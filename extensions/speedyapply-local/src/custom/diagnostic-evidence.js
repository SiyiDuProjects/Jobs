// Causal metadata is an allowlist, not a second route for answers or exception text.
export const diagnosticEnums = {
  stage: ["guard", "write", "item", "navigation", "lifecycle"],
  reason: [
    "manual",
    "cancelled",
    "form_hidden",
    "url_changed",
    "owner_changed",
    "caller_invalid",
    "queue_changed",
    "queue_paused",
    "page_left",
    "removed",
    "user_input",
    "expired",
    "detached",
    "root_changed",
    "profile_changed",
    "not_committed",
    "value_lost",
    "exception",
    "unknown",
    "buffer_overflow",
  ],
  result: ["started", "committed", "failed", "kept", "blocked", "completed"],
  action: ["fill", "next", "submit", "review"],
};
export function diagnosticEvidence(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, choices] of Object.entries(diagnosticEnums))
    if (choices.includes(value[key])) result[key] = value[key];
  for (const key of ["operation", "item", "total", "committed", "dropped"])
    if (
      Number.isSafeInteger(value[key]) &&
      value[key] >= 0 &&
      value[key] <= 1000000
    )
      result[key] = value[key];
  for (const key of ["focused", "hidden"])
    if (typeof value[key] === "boolean") result[key] = value[key];
  return result;
}

// Preserve short circuit order and evaluate every guard exactly once.
export function diagnosticGuard(checks, report) {
  let previous;
  return () => {
    for (const [reason, check] of checks) {
      if (!check()) {
        if (previous !== reason) {
          previous = reason;
          try {
            report({ stage: "guard", reason, result: "blocked" });
          } catch {}
        }
        return false;
      }
    }
    previous = undefined;
    return true;
  };
}

// Under a bounded archive budget, preserve the initial context and observed
// failures before routine activity. Coverage still explicitly says truncated.
export function evictDiagnosticEvent(events) {
  const important = (e) =>
    ["failed", "blocked"].includes(e.evidence?.result) ||
    (e.trace?.result &&
      !["committed", "decided", "matched", "kept"].includes(e.trace.result));
  const index = events.findIndex((e, i) => i > 0 && !important(e));
  events.splice(index < 0 ? 0 : index, 1);
}
