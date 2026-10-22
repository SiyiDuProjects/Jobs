import { stableStringify } from "./stable-value.js";
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

// A platform's post-submit receipt (Workday: "Application Submitted"). The
// page may no longer name its posting, so the worker attributes it.
export function detectSubmittedNotice(doc = document) {
  if (!doc?.location) return null;
  const found = JobsPlatformConfig.submittedNotice(doc);
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
    lastRequest = "",
    notice = "",
    noticePending = false;
  function present(value) {
    message = value;
    show?.(value);
  }
  async function scanNotice() {
    if (stopped || noticePending) return;
    const found = detectSubmittedNotice();
    const identity = found ? stableStringify(found) : "";
    if (!found || notice === identity) return;
    noticePending = true;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: "jobs:submitted-notice-observed",
        ...found,
      });
      const data = reply?.data;
      if (reply?.error || !data?.ok) throw Error("not_acknowledged");
      if (stopped || stableStringify(detectSubmittedNotice()) !== identity)
        return;
      // A fast SPA receipt can precede the asynchronous attempt persistence.
      // Only an attributed receipt is final; focus/storage changes retry others.
      if (data.state !== "unattributed") notice = identity;
      JobsDiagnostics?.note("submitted_notice_observed", null, data.state);
      if (data.state === "unattributed")
        present(
          "网站显示已提交；本标签页没有可对应的提交记录，请在投递管理核对",
        );
      else {
        JobsPageSession?.confirmed();
        present("confirmed");
      }
    } catch {
      // Retried on the next page change, focus or reconnect.
    } finally {
      noticePending = false;
    }
  }
  async function scan() {
    void scanNotice();
    if (stopped || pending) return;
    const found = detectAppliedStatus();
    if (!found) return;
    const identity = stableStringify(found);
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
      if (stopped || stableStringify(detectAppliedStatus()) !== identity)
        return;
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
      if (stopped || stableStringify(detectAppliedStatus()) !== identity)
        return;
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
      stableStringify(detectAppliedStatus()) === lastRequest &&
      !detectSubmittedNotice()
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
    if (
      (area === "local" && changes.jobsSyncV1) ||
      (area === "session" &&
        Object.keys(changes).some((key) => key.startsWith("jobsTabSubmit:")))
    )
      retry();
  };
  chrome.storage.onChanged.addListener(changed);
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (
      !["jobs:applied-status-check", "jobs:submitted-notice-check"].includes(
        request?.type,
      ) ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    reply(
      request.type === "jobs:applied-status-check"
        ? detectAppliedStatus()
        : detectSubmittedNotice(),
    );
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
