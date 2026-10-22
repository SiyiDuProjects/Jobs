import { loadReviewView } from "./deferred-review-view.js";

// Browser operators use the same editor and versioned actions as the side panel.
// The host page can interact with this surface, so it can only claim AI ownership.
export function createPageReview({
  operator,
  claim,
  loadView = loadReviewView,
}) {
  // Embedded documents relay review/status through the background to the top
  // presenter. They still own their form actions, but never another visible UI.
  if (
    !globalThis.chrome?.runtime?.getURL ||
    document.defaultView !== document.defaultView?.top
  )
    return { show() {}, status() {}, expand() {}, dispose() {} };
  let host,
    container,
    status,
    toggle,
    prepare,
    progress,
    statusAction,
    last,
    act,
    view,
    loading,
    loadError = "",
    disposed = false;
  const enabled = () => ["agent", "page-tool"].includes(operator.read().mode);
  function loadEditor() {
    if (view || loading || loadError || disposed || !last || !enabled()) return;
    loading = Promise.resolve()
      .then(loadView)
      .then((createReviewView) => {
        // A module response is only code, never permission to revive an old
        // review, reclaim ownership, or mount a removed page surface.
        if (disposed || !last || !enabled()) return;
        view = createReviewView({
          stylesheetHref: chrome.runtime.getURL("custom/popup.css"),
          showReasons: true,
        });
        view.attach(host, container, () => {});
      })
      .catch(() => {
        if (!disposed && last && enabled())
          loadError = "补答界面加载失败，请点击重试。";
      })
      .finally(() => {
        loading = null;
        if (!disposed) refresh();
      });
  }
  function mount() {
    if (host || disposed || !document.body) return;
    host = document.createElement("aside");
    host.dataset.jobsOperator = "true";
    host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);z-index:2147483646;color-scheme:light";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host{font:14px system-ui;color:#171717}section{background:#fff;border:1px solid #ddd;border-radius:14px;box-shadow:0 8px 32px #0002;padding:12px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}button{font:inherit;background:#f3f3f3;color:#171717;border:1px solid #ddd;border-radius:8px;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5}p{margin:8px 0 0;font-size:12px;color:#555}.review{max-height:65vh;overflow:auto;margin-top:8px}.review:empty{display:none}";
    const section = document.createElement("section"),
      header = document.createElement("header"),
      title = document.createElement("strong");
    title.textContent = "Jobs";
    toggle = document.createElement("button");
    toggle.type = "button";
    status = document.createElement("p");
    status.setAttribute("role", "status");
    container = document.createElement("div");
    container.className = "review";
    prepare = document.createElement("button");
    prepare.type = "button";
    prepare.textContent = "准备本页回答";
    prepare.onclick = async (event) => {
      if (
        !event.isTrusted ||
        disposed ||
        !["agent", "page-tool"].includes(operator.read().mode)
      )
        return;
      const id = progress?.id,
        action = statusAction;
      prepare.disabled = true;
      try {
        await claim("page-tool");
        if (
          disposed ||
          id !== progress?.id ||
          statusAction !== action ||
          !["agent", "page-tool"].includes(operator.read().mode)
        )
          throw Error("页面已变化，请重新检查。");
        const result = await action?.("draft");
        if (result?.error) throw Error(result.error);
      } catch (error) {
        status.textContent = error.message;
      } finally {
        prepare.disabled = false;
      }
    };
    header.append(title, toggle);
    section.append(header, status, prepare, container);
    shadow.append(style, section);
    document.body.append(host);
    toggle.onclick = async (event) => {
      if (!event.isTrusted || disposed) return;
      if (loadError && enabled()) {
        loadError = "";
        refresh();
        return;
      }
      if (
        operator.read().mode !== "person" &&
        operator.read().mode !== "unknown"
      ) {
        container.hidden = !container.hidden;
        toggle.textContent = container.hidden ? "展开补答" : "收起补答";
        return;
      }
      toggle.disabled = true;
      try {
        await claim("page-tool");
        refresh();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        toggle.disabled = false;
      }
    };
  }
  function refresh() {
    if (disposed) return;
    mount();
    if (!host) return;
    const active = enabled();
    loadEditor();
    toggle.textContent = active
      ? loadError
        ? "重试补答"
        : "收起补答"
      : "AI 接手";
    host.style.width = active ? "360px" : "auto";
    status.hidden = !active;
    prepare.hidden = !active || !progress?.canFill || !!last;
    status.textContent = active
      ? loadError ||
        (loading ? "正在加载补答…" : progress?.text || "AI 操作中") +
          " · 补答不会记为本人回答"
      : "亲自填写可使用侧边栏；AI 操作前先点接手。";
    container.hidden = !active;
    const shownId = last?.id,
      action = act;
    view?.show(active ? last : null, async (...args) => {
      // Recheck at dispatch and after claiming: neither a delayed import nor an
      // old editor callback can redirect an action to another review/document.
      if (disposed || !enabled())
        return { error: "操作模式已改变，请重新接手。" };
      if (last?.id !== shownId || act !== action)
        return { error: "这份补答已变化，请重新检查。" };
      await claim("page-tool");
      if (disposed || last?.id !== shownId || act !== action || !enabled())
        return { error: "这份补答已变化，请重新检查。" };
      return action?.(...args);
    });
  }
  const unsubscribe = operator.subscribe(refresh);
  refresh();
  return {
    status(data, action) {
      if (disposed) return;
      progress = data;
      statusAction = action;
      refresh();
    },
    show(data, action) {
      if (disposed) return;
      if (last?.id !== data?.id) loadError = "";
      last = data;
      act = action;
      refresh();
    },
    expand() {
      if (disposed) return;
      refresh();
      if (container) container.hidden = false;
      view?.expand();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      view?.show(null);
      last = progress = act = statusAction = null;
      host?.remove();
    },
  };
}
