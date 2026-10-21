import { stableStringify } from "./stable-value.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { matchesAnswerRequest } from "./answer-proof.js";

export function reviewFailure(code) {
  const messages = {
    control_failure: "页面写入或回读失败，请检查。",
    answer_missing: "AI 没有返回这道题的有效回答，请重试。",
    answer_invalid: "AI 返回的答案无法用于这道题，请重试。",
    ai_unavailable: "AI 服务暂时不可用，请稍后重试。",
    ai_rate_limited: "AI 调用额度暂时用完，请稍后重试。",
    unrecognized_question: "尚未获得可用回答，请补充或重试。",
    draft_unavailable: "文字草稿未生成，请重试。",
  };
  return {
    reason: messages[code] || "缺少作答所需的资料。",
    failure: !!messages[code],
    failureLabel:
      code === "control_failure"
        ? "填写失败"
        : messages[code]
          ? "未获得可用回答"
          : "",
  };
}

export function answerNeedsReview(answer, row, record, field) {
  return (
    !field || answer.kind !== "answer" || !matchesAnswerRequest(answer, field)
  );
}

const identity = (row) => [
  row.public.question,
  row.public.type,
  row.public.options,
  row.public.conditional,
];

// A reviewed field can lose placeholder/help text when the person answers it.
// Its current value and website validation determine completion, not that text.
export function reviewShape(row) {
  return stableStringify(identity(row));
}

// Pending automatic answers still expire when their instructions change.
export function shape(row) {
  return stableStringify([
    ...identity(row),
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
