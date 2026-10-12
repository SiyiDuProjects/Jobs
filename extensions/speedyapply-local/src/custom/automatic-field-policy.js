import { stableStringify } from "./stable-value.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { matchesAnswerRequest } from "./answer-proof.js";

export function reviewFailure(code) {
  const messages = {
    control_failure: "答案校验或写入失败，请重试。",
    ai_unavailable: "AI 服务暂时不可用，请稍后重试。",
    ai_rate_limited: "AI 调用额度暂时用完，请稍后重试。",
    unrecognized_question: "AI 未能理解这道题，请重试。",
    draft_unavailable: "文字草稿未生成，请重试。",
  };
  return {
    reason: messages[code] || "缺少作答所需的资料。",
    failure: !!messages[code],
  };
}

export function answerNeedsReview(answer, row, record, field) {
  return (
    !field || answer.kind !== "answer" || !matchesAnswerRequest(answer, field)
  );
}

export function shape(row) {
  return stableStringify([
    row.public.question,
    row.public.type,
    row.public.options,
    row.public.conditional,
    row.description,
    row.descriptionIncomplete,
  ]);
}

export function automaticFillPolicy(root, reader) {
  const selector = JobsPlatformConfig.detect(
    root.ownerDocument || root,
  ).requiredOnlyAutofill;
  // Bindings and supplemental answers use the same scanner's requiredness.
  // Re-read for bindings so conditional changes are not frozen at run start.
  return (node, field = null) =>
    !selector ||
    !node.closest(selector) ||
    (
      field ||
      reader
        .scan()
        .find((row) => row.node === node || row.group?.includes(node))?.public
    )?.required === true;
}
