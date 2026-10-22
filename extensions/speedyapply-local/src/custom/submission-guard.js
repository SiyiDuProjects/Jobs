import { JobsDiagnostics } from "./diagnostics.js";
import { diagnosticGuard } from "./diagnostic-evidence.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsJobMatch } from "./job-match.js";
export var JobsSubmissionGuard;
let initialized = false;
export function initializeSubmissionGuard() {
  if (initialized || location.protocol !== "https:") return;
  initialized = true;
  let bridge = {},
    disposed = false,
    removed = false;
  const lifetime = new AbortController();
  const allowed = () => !lifetime.signal.aborted;
  const stop = () => {
    removed = true;
    lifetime.abort(Error("岗位已移除，操作已停止"));
    bridge.cancel?.();
  };
  const guard = (check) => {
    const signal = lifetime.signal;
    return diagnosticGuard(
      [
        ["page_left", () => !disposed],
        ["removed", () => !removed],
        ["caller_invalid", () => !signal.aborted && (!check || check())],
      ],
      (value) => JobsDiagnostics?.evidence?.(null, value),
    );
  };
  function verify() {
    if (!allowed()) throw Error("岗位已移除或页面已关闭");
  }
  const visible = (node) => {
    if (
      !node?.isConnected ||
      node.closest('[hidden],[inert],[aria-hidden="true"]')
    )
      return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
    }
    return true;
  };
  function blocker() {
    if (
      [
        ...document.querySelectorAll(
          'iframe[src*="/bframe"],iframe[title*="challenge"],iframe[title*="Challenge"]',
        ),
      ].some(visible)
    )
      return "等待验证码处理";
    if (
      [
        ...document.querySelectorAll(
          'input[autocomplete="one-time-code"],input[name*="verificationCode" i],input[name*="otp" i]',
        ),
      ].some(visible)
    )
      return "等待验证码／邮箱验证";
    if (
      [...document.querySelectorAll('[role="alert"],h1,h2')].some(
        (node) =>
          visible(node) &&
          /verify (?:that )?you are human|security challenge|complete the captcha/i.test(
            node.textContent,
          ),
      )
    )
      return "等待验证码处理";
    return "";
  }
  let submissionGuard,
    submissionAttempted = false,
    clickingSubmit = false,
    clickValidation = false,
    manualSubmit = false;
  async function beforeNavigate(action, root, target) {
    const signal = lifetime.signal;
    verify();
    const result = await chrome.runtime.sendMessage({
      type: "jobs:removal-check",
      url: location.href,
      final: action === "submit",
    });
    if (result?.error) throw Error(result.error);
    if (typeof result?.data?.removed !== "boolean")
      throw Error("无法核对岗位移除状态");
    if (result?.data?.removed) stop();
    signal.throwIfAborted();
    if (action === "submit" && !submissionGuard) {
      const reply = await chrome.runtime.sendMessage({
        type: "jobs:submission-prepare",
        url: location.href,
      });
      if (reply?.error || !reply?.data?.id)
        throw Error(reply?.error || "无法建立提交保护");
      submissionGuard = reply.data.id;
    }
    signal.throwIfAborted();
    const reason = blocker();
    if (reason) throw Error(reason);
    verify();
  }
  function afterNavigate() {
    if (submissionGuard) {
      submissionAttempted = true;
      bridge.attempted?.();
      void chrome.runtime
        .sendMessage({
          type: "jobs:submission-attempted",
          id: submissionGuard,
          url: location.href,
        })
        .catch(() => {});
      if (clickValidation) validationError();
    }
  }
  function clickNavigate(action, target) {
    if (!JobsPageActions.allowed()) return false;
    clickingSubmit = action === "submit";
    clickValidation = false;
    let dispatched = false;
    const observeClick = (event) => {
      if (event.composedPath().includes(target)) dispatched = true;
    };
    window.addEventListener("click", observeClick, true);
    try {
      const clicked = JobsPageActions.click(target);
      return clicked && dispatched;
    } finally {
      window.removeEventListener("click", observeClick, true);
      // A method return or exception alone is not an executed click. Retain
      // preparation if dispatch is unproven; never manufacture an attempt.
      if (dispatched) afterNavigate();
      clickingSubmit = false;
      clickValidation = false;
    }
  }
  function validationError() {
    if (clickingSubmit && !submissionAttempted) {
      clickValidation = true;
      return;
    }
    if (manualSubmit) {
      void chrome.runtime
        .sendMessage({
          type: "jobs:submission-observed",
          url: location.href,
          validationError: true,
        })
        .catch(() => {});
      return;
    }
    if (submissionGuard && submissionAttempted)
      void chrome.runtime
        .sendMessage({
          type: "jobs:submission-validation-error",
          id: submissionGuard,
          url: location.href,
        })
        .catch(() => {});
  }
  document.addEventListener("invalid", validationError, true);
  const manualRoots = new WeakSet();
  function trackManualSubmit(root, text) {
    if (!root || manualRoots.has(root)) return;
    manualRoots.add(root);
    root.addEventListener(
      "click",
      (event) => {
        if (clickingSubmit || disposed) return;
        const target = event
          .composedPath()
          .find(
            (node) =>
              node instanceof Element &&
              node.matches('button,input[type="submit"],[role="button"]'),
          );
        if (
          !(target instanceof HTMLElement) ||
          !root.contains(target) ||
          !visible(target) ||
          target.matches(':disabled,[aria-disabled="true"]') ||
          !text.test(
            (target instanceof HTMLInputElement
              ? target.value
              : target.textContent
            ).trim(),
          )
        )
          return;
        manualSubmit = true;
        bridge.attempted?.();
        // The worker owns the full observe -> persist transaction. This page
        // must not await a prepare ACK before sending the executed attempt.
        void chrome.runtime
          .sendMessage({
            type: "jobs:submission-observed",
            url: location.href,
          })
          .catch(() => {});
      },
      true,
    );
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.type !== "jobs:job-removed" ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    const key = JobsJobMatch.key(location.href);
    if (
      message.topMatches ||
      message.identityKeys?.includes(key) ||
      JobsJobMatch.same(message.url, location.href)
    )
      stop();
    reply({ ok: true });
  });
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      lifetime.abort();
      bridge.cancel?.();
    },
    { once: true },
  );
  JobsSubmissionGuard = Object.freeze({
    allowed,
    guard,
    verify,
    beforeNavigate,
    afterNavigate,
    clickNavigate,
    trackManualSubmit,
    validationError,
    attach: (value) => {
      bridge = value;
    },
  });
}
