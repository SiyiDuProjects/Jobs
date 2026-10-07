import { JobsDOMWait } from "./dom-wait.js";

// An observed page update is separate from a visible input value. The observer
// publishes counters only; the existing writer still validates each answer.
function readState(node) {
  const doc = node.ownerDocument || node;
  const text = doc.documentElement?.getAttribute("data-jobs-form-commit");
  if (text == null) return { pending: 0, failed: false, revision: 0 };
  try {
    const state = JSON.parse(text);
    return Number.isSafeInteger(state.pending) &&
      state.pending >= 0 &&
      typeof state.failed === "boolean"
      ? state
      : null;
  } catch {
    return null;
  }
}
export const JobsPageCommit = Object.freeze({
  revision: (node) => readState(node)?.revision || 0,
  async wait(
    node,
    {
      canProceed = () => true,
      timeout = 15000,
      idle = false,
      since = undefined,
    } = {},
  ) {
    const doc = node.ownerDocument || node;
    const outcome = (state) => {
      if (!state || state.stalled) return { ok: false };
      if (state.pending !== 0) return null;
      return {
        ok:
          idle ||
          (since !== undefined
            ? (state.failureRevision || (state.failed ? state.revision : 0)) <=
              since
            : !state.failed),
      };
    };
    if (!canProceed()) return false;
    const initial = outcome(readState(node));
    if (initial) return initial.ok;
    const result = await JobsDOMWait.until(
      () => {
        if (!canProceed()) return { ok: false };
        return outcome(readState(node));
      },
      { root: doc, timeout, interval: 100 },
    );
    return result?.ok === true;
  },
});
