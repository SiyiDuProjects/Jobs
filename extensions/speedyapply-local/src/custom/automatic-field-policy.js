import { JobsPlatformConfig } from "./platform-config.js";
import { allowsAutomaticFill } from "./autofill-preferences.js";
import { JobsAnswerPolicy } from "./answer-policy.js";

export function answerNeedsReview(answer, row, record) {
  return (
    answer.needsConfirmation !== false ||
    answer.source === "suggestion" ||
    answer.source === "unknown" ||
    record.confirm ||
    JobsAnswerPolicy.reviewQuestions.some((pattern) =>
      new RegExp(pattern, "i").test(
        row.public.question + " " + (row.public.description || ""),
      ),
    )
  );
}

export function shape(row) {
  return JSON.stringify([
    row.public.question,
    row.public.type,
    row.public.options,
    row.public.conditional,
  ]);
}

export async function automaticFillPolicy(root) {
  const rules = JobsPlatformConfig.detect(
    root.ownerDocument || root,
  ).automaticPreferences;
  let preferences = {};
  if (
    rules?.some(
      ({ selector }) =>
        root.matches?.(selector) || root.querySelector(selector),
    )
  ) {
    // Local storage may be restricted to trusted extension contexts after
    // migration. Content scripts read only behavior preferences via the worker.
    const result = await chrome.runtime.sendMessage({
      type: "jobs:autofill-preferences",
    });
    if (result?.error) throw Error(result.error);
    preferences = result?.data || {};
  }
  return (node) => allowsAutomaticFill(node, preferences, rules);
}
