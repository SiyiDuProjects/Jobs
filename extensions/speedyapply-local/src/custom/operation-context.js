import { JobsDiagnostics } from "./diagnostics.js";
import { diagnosticGuard } from "./diagnostic-evidence.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsSubmissionGuard } from "./submission-guard.js";
export var JobsOperationContext;
let initialized = false;
export function initializeOperationContext() {
  if (initialized) return;
  initialized = true;
  (() => {
    const signature = (value) =>
      (JobsProfileAnswers?.signature || JSON.stringify)(value);
    const withoutResume = (profile) => {
      if (!profile?.resumeData) return profile;
      const { resumeBase64, ...metadata } = profile.resumeData;
      return { ...profile, resumeData: metadata };
    };
    function create({
      root,
      getRoot = () => root,
      profile,
      profileId,
      expiresAt = Infinity,
      canProceed = () => true,
      controller,
    }) {
      canProceed = JobsPageActions.guard(canProceed);
      const doc = root?.ownerDocument || document,
        win = doc.defaultView;
      controller ||= new win.AbortController();
      const signal = controller.signal;
      const url = doc.location.href,
        parent = root?.parentNode,
        stamp = signature(profile);
      let boundId = profileId,
        boundTabId,
        boundResumeRef,
        watching = false,
        writing = 0,
        failure = "";
      // Profile checks and their time (timing diagnostics).
      const checks = { count: 0, fresh: 0, ms: 0, reused: 0 };
      let verified, pending;
      const cancel = (reason) => {
        failure = reason || "页面或用户输入已变化，停止继续";
        controller.abort(failure);
      };
      const current = diagnosticGuard(
        [
          ["cancelled", () => !signal.aborted],
          ["expired", () => Date.now() < expiresAt],
          ["detached", () => root?.isConnected],
          [
            "root_changed",
            () => root.parentNode === parent && getRoot() === root,
          ],
          ["url_changed", () => doc.location.href === url],
          ["caller_invalid", canProceed],
          ["page_removed", () => JobsPageActions.allowed()],
        ],
        (value) => JobsDiagnostics?.evidence?.(null, value),
      );
      const assertCurrent = () => {
        if (!current())
          throw Error(failure || "页面或用户输入已变化，停止继续");
      };
      const changed = (event) => {
        const target = event.composedPath?.()[0] || event.target;
        // Native radio/checkbox .click() also emits trusted input/change events.
        // Hardware interaction still cancels during an asynchronous writer.
        if (
          event.isTrusted &&
          (!writing ||
            ["pointerdown", "keydown", "paste"].includes(event.type)) &&
          root.contains(target) &&
          (target.closest?.(
            'input,textarea,select,button,[contenteditable="true"],[role="combobox"],[role="radio"],[role="checkbox"]',
          ) ||
            JobsControlFields?.component(target))
        )
          cancel("填写时用户输入已变化，停止继续");
      };
      const listen = (enabled) => {
        if (watching === enabled) return;
        watching = enabled;
        for (const type of [
          "pointerdown",
          "keydown",
          "paste",
          "input",
          "change",
        ])
          doc[enabled ? "addEventListener" : "removeEventListener"](
            type,
            changed,
            true,
          );
      };
      const hidden = () => cancel("页面已离开，停止继续");
      const storageChanged = (changes, area) => {
        const change =
          area === "session" &&
          boundTabId != null &&
          changes["profile_" + boundTabId];
        if (!change) return;
        const record = change.newValue;
        if (
          !record?.profile ||
          record.id !== boundId ||
          (record.resumeRef
            ? record.resumeRef !== boundResumeRef ||
              signature(record.profile) !== signature(withoutResume(profile))
            : signature(record.profile) !== stamp)
        )
          cancel("本页 Profile 已改变");
      };
      win.addEventListener("pagehide", hidden);
      globalThis.chrome?.storage?.onChanged?.addListener(storageChanged);
      listen(true);
      async function verify({ fresh = true } = {}) {
        assertCurrent();
        // A run uses its bound snapshot. Local lifecycle/queue guards and the
        // storage listener invalidate it without a background trip per field.
        // Explicit remote commands can still request fresh server verification.
        if (!fresh && (verified || pending)) {
          checks.reused++;
          const state = verified || (await pending);
          assertCurrent();
          return state;
        }
        const started = Date.now();
        verified = undefined;
        const task = check(fresh);
        pending = task;
        try {
          const state = await task;
          assertCurrent();
          verified = state;
          return state;
        } finally {
          if (pending === task) pending = undefined;
          checks.count++;
          if (fresh) checks.fresh++;
          checks.ms += Date.now() - started;
        }
      }
      async function check(fresh) {
        assertCurrent();
        await JobsSubmissionGuard?.verify();
        if (!profile || typeof profile !== "object")
          throw Error("本页 Profile 不可用");
        const state = await chrome.runtime.sendMessage({
          type: "jobs:tab-profile",
          ...(fresh ? { verify: true } : {}),
        });
        if (state?.error) {
          cancel(state.error);
          throw Error(state.error);
        }
        if (
          !state?.data?.id ||
          (boundId && boundId !== state.data.id) ||
          signature(state.data.profile) !== stamp
        ) {
          cancel("本页 Profile 已改变");
          throw Error(failure);
        }
        boundId = state.data.id;
        boundResumeRef = state.data.resumeRef;
        if (Number.isInteger(state.data.tabId)) boundTabId = state.data.tabId;
        assertCurrent();
        return state.data;
      }
      function release() {
        listen(false);
        win.removeEventListener("pagehide", hidden);
        globalThis.chrome?.storage?.onChanged?.removeListener(storageChanged);
      }
      const write = async (action) => {
        assertCurrent();
        writing++;
        try {
          return await action(current);
        } finally {
          writing--;
        }
      };
      return Object.freeze({
        signal,
        current,
        assertCurrent,
        verify,
        stamp,
        cancel,
        release,
        write,
        checks: () => ({ ...checks }),
        pause: () => listen(false),
        resume: () => {
          assertCurrent();
          listen(true);
        },
      });
    }
    JobsOperationContext = Object.freeze({ create });
  })();
}
