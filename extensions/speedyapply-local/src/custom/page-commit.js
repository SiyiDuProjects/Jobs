import { JobsDOMWait } from "./dom-wait.js";

// An observed page update is separate from a visible input value. The observer
// publishes counters only; the existing writer still validates each answer.
export const JobsPageCommit = Object.freeze({
  async wait(node, { canProceed = () => true, timeout = 15000 } = {}) {
    const doc = node.ownerDocument || node;
    const read = () => {
      const text = doc.documentElement?.getAttribute("data-jobs-form-commit");
      if (text == null) return { pending: 0, failed: false };
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
    };
    if (!canProceed()) return false;
    const initial = read();
    if (initial?.pending === 0) return !initial.failed;
    const result = await JobsDOMWait.until(
      () => {
        if (!canProceed()) return { ok: false };
        const state = read();
        return state && state.pending === 0 ? { ok: !state.failed } : null;
      },
      { root: doc, timeout, interval: 100 },
    );
    return result?.ok === true;
  },
});
