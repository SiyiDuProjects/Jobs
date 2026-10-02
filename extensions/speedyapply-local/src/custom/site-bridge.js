import { JobsBrand } from "./brand.js";
// Isolated content-script world: credentials never go through window messages.
(() => {
  const ORIGIN = JobsBrand.origin;
  if (location.origin !== ORIGIN || window !== window.top) return;
  if (globalThis.jobsSiteBridgeInstalled) return;
  globalThis.jobsSiteBridgeInstalled = true;
  let connecting,
    disconnecting,
    stale = false,
    linksTimer;
  const refreshMessage =
    "插件已更新，请刷新本页恢复自动识别；岗位链接仍可直接打开";
  const live = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  function detach() {
    if (stale) return;
    stale = true;
    observer.disconnect();
    clearTimeout(linksTimer);
    document.removeEventListener("click", clicked, true);
    document.removeEventListener("auxclick", clicked, true);
    publish({ error: refreshMessage });
  }
  const send = async (value) => {
    if (!live()) {
      detach();
      throw Error(refreshMessage);
    }
    try {
      return await chrome.runtime.sendMessage(value);
    } catch (error) {
      if (!live() || /Extension context invalidated/i.test(error.message))
        detach();
      throw error;
    }
  };
  const clicked = (event) => {
    if (!event.isTrusted || event.button > 1) return;
    const anchor = event.target.closest?.("a[data-jobs-id]");
    // Observe only. Browser-native left/middle/Ctrl clicks and context-menu
    // opening never depend on a running worker, network, or Profile sync.
    if (anchor?.dataset.jobsKind)
      void send({
        type: "jobs:site-links",
        links: [
          {
            jobId: anchor.dataset.jobsId,
            kind: anchor.dataset.jobsKind,
            url: anchor.href,
          },
        ],
      }).catch(() => {});
  };
  document.addEventListener("click", clicked, true);
  document.addEventListener("auxclick", clicked, true);
  const publish = (status) =>
    window.postMessage(
      {
        type: "jobs:extension-status",
        installed: true,
        connected: !!status.connected,
        disabled: !!status.disabled,
        queued: status.queued || 0,
        error: status.error || "",
        lastSynced: status.lastSynced || null,
      },
      ORIGIN,
    );
  // Publish job metadata BEFORE a click; the destination can select its
  // Profile independently of how the browser opened the ordinary link.
  let lastLinks = "";
  function publishLinks() {
    if (stale) return;
    const links = [
      .../** @type {NodeListOf<HTMLAnchorElement>} */ (
        document.querySelectorAll("a[data-jobs-id][data-jobs-kind]")
      ),
    ]
      .slice(0, 2000)
      .map((a) => ({
        jobId: a.dataset.jobsId,
        kind: a.dataset.jobsKind,
        url: a.href,
      }));
    const signature = JSON.stringify(links);
    if (signature === lastLinks) return;
    lastLinks = signature;
    void send({ type: "jobs:site-links", links })
      .then((result) => {
        if (result?.error) lastLinks = "";
      })
      .catch(() => {
        lastLinks = "";
      });
  }
  const observer = new MutationObserver(() => {
    clearTimeout(linksTimer);
    linksTimer = setTimeout(publishLinks, 0);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href", "data-jobs-id", "data-jobs-kind"],
  });
  async function connect(force = false) {
    if (disconnecting) return disconnecting;
    if (connecting) return connecting;
    connecting = (async () => {
      const info = await send({ type: "jobs:sync-pair-info" });
      if (info.error) throw Error(info.error);
      if (
        (!info.connected || !info.profilesConnected) &&
        (!info.disabled || force)
      ) {
        const response = await fetch(ORIGIN + "/api/extension/connect", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "X-Jobs-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            device_id: info.deviceId,
            extension_id: info.extensionId,
            profiles: true,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw Error("请先登录网站，再连接插件");
        const data = await response.json();
        const result = await send({
          type: "jobs:sync-connect",
          token: data.token,
          profileToken: data.profile_token,
        });
        if (!result.ok) throw Error(result.error || "插件连接失败");
      }
      publish(await send({ type: "jobs:sync-status" }));
    })()
      .catch((error) => publish({ error: error.message }))
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    if (stale) return;
    if (event.data?.type === "jobs:website-ready") {
      publishLinks();
      void connect();
    }
    if (event.data?.type === "jobs:extension-connect") void connect(true);
    if (event.data?.type !== "jobs:extension-disconnect" || disconnecting)
      return;
    disconnecting = (async () => {
      // Finish any already-started connect first, then revoke it. Otherwise a
      // late connect reply can silently re-enable sync after Disconnect.
      if (connecting) await connecting;
      const info = await send({ type: "jobs:sync-pair-info" });
      // Confirm pending personal answers before revoking the grant they need.
      const stopped = await send({ type: "jobs:sync-disconnect" });
      if (!stopped.ok) throw Error(stopped.error || "插件未能停止，请重试");
      const status = await send({ type: "jobs:sync-status" });
      publish(status);
      try {
        const response = await fetch(ORIGIN + "/api/extension/disconnect", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "X-Jobs-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ device_id: info.deviceId }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw Error("Grant revocation failed");
      } catch {
        publish({
          ...status,
          error: "插件已停止；服务器连接尚未撤销，请重试断开",
        });
      }
    })()
      .catch(async (error) =>
        publish({
          ...(await send({ type: "jobs:sync-status" }).catch(() => ({}))),
          error: error.message,
        }),
      )
      .finally(() => {
        disconnecting = undefined;
      });
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "jobs:sync-status") publish(message);
  });
  send({ type: "jobs:sync-status" })
    .then(publish)
    .catch(() => {});
  publishLinks();
  // Connect even if an older/cached website bundle never sends website-ready.
  void connect();
})();
