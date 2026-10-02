import { JobsJobMatch } from "./job-match.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPageSession } from "./control-content.js";
import { JobsAutomatic } from "./automatic-fill.js";

export var JobsAppliedStatus;
export function detectAppliedStatus(doc = document) {
  if (!doc?.location) return null;
  const key = JobsJobMatch.key(doc.location.href);
  if (!key || JSON.parse(key)[1] !== "workday") return null;
  const found = JobsPlatformConfig.appliedStatus(doc, "workday");
  return found ? { url: doc.location.href, quote: found.quote } : null;
}

let initialized = false;
export function initializeAppliedStatus() {
  if (initialized || window !== window.top) return;
  initialized = true;
  let show,
    message,
    pending = false,
    scheduled = false,
    stopped = false,
    retryPending = false;
  let seen = "",
    completed = "",
    lastRequest = "";
  function present(value) {
    message = value;
    show?.(value);
  }
  async function scan() {
    if (stopped || pending) return;
    const found = detectAppliedStatus();
    if (!found) return;
    const identity = JSON.stringify(found);
    if (completed === identity) return;
    if (seen !== identity) {
      seen = identity;
      JobsDiagnostics?.note("already_applied_observed", null, found.quote);
      JobsAutomatic?.cancel?.(JobsPageSession?.root());
    }
    pending = true;
    lastRequest = identity;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: "jobs:applied-status-observed",
        ...found,
      });
      if (stopped || JSON.stringify(detectAppliedStatus()) !== identity) return;
      const data = reply?.data;
      if (reply?.error || !data?.ok) throw Error("not_acknowledged");
      if (data.state === "disabled") {
        present("网站显示已申请；投递记录已关闭");
        completed = identity;
      } else if (data.state === "unmatched") {
        present("网站显示已申请；未匹配到岗位记录");
      } else {
        JobsPageSession?.confirmed();
        present(
          data.state === "confirmed"
            ? "网站显示已申请，后台已同步"
            : "网站显示已申请，已记录并等待同步",
        );
        JobsDiagnostics?.note("already_applied_recorded", null, data.state);
        if (data.state === "confirmed") completed = identity;
      }
    } catch {
      if (stopped || JSON.stringify(detectAppliedStatus()) !== identity) return;
      present("网站显示已申请；回填尚未确认，联网或返回页面时重试");
      JobsDiagnostics?.note(
        "already_applied_sync_failed",
        null,
        "not_acknowledged",
      );
    } finally {
      pending = false;
      if (retryPending) {
        retryPending = false;
        schedule(true);
      }
    }
  }
  function schedule(force = false) {
    if (scheduled || stopped) return;
    if (pending) {
      if (force) retryPending = true;
      return;
    }
    if (
      !force &&
      lastRequest &&
      JSON.stringify(detectAppliedStatus()) === lastRequest
    )
      return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void scan();
    });
  }
  JobsAppliedStatus = {
    attach(presenter) {
      show = presenter;
      if (message) show(message);
    },
  };
  const observer = new MutationObserver((records) => {
    if (
      records.every((record) => {
        const node = /** @type {Element} */ (
          record.target.nodeType === 1
            ? record.target
            : record.target.parentElement
        );
        return node?.closest?.("[data-jobs-ui],[data-jobs-owner]");
      })
    )
      return;
    schedule();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "style",
      "class",
      "data-automation-id",
    ],
  });
  const retry = () => schedule(true);
  for (const event of ["focus", "online", "pageshow", "jobs:locationchange"])
    window.addEventListener(event, retry);
  const changed = (changes, area) => {
    if (area === "local" && changes.jobsSyncV1) retry();
  };
  chrome.storage.onChanged.addListener(changed);
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (
      request?.type !== "jobs:applied-status-check" ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    reply(detectAppliedStatus());
  });
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    stopped = true;
    observer.disconnect();
    chrome.storage.onChanged.removeListener(changed);
    for (const event of ["focus", "online", "pageshow", "jobs:locationchange"])
      window.removeEventListener(event, retry);
  });
  void scan();
}
