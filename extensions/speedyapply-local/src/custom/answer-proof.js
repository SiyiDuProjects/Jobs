import { stableStringify, sameValue } from "./stable-value.js";
// The worker binds the authenticated response to the request, without judging facts.
export const ANSWER_PROTOCOL = 3;
export function evidenceField(field) {
  return Object.fromEntries(
    ["fieldId", "question", "type", "required", "description", "options"].map(
      (key) => [
        key,
        key === "options" && Array.isArray(field.options)
          ? field.options.map(({ value, label }) => ({ value, label }))
          : (field[key] ?? (key === "description" ? "" : null)),
      ],
    ),
  );
}
export function bindAnswerEvidence(answer, field, bound) {
  const binding = answer.binding;
  const current =
    binding?.profileId === bound.id &&
    binding.profileVersion === bound.lastSync &&
    answer.fieldId === field.fieldId &&
    sameValue(evidenceField(binding.field || {}), evidenceField(field));
  return {
    ...answer,
    requestBinding: current
      ? {
          profileId: bound.id,
          profileVersion: bound.lastSync,
          field: stableStringify(evidenceField(field)),
          value: stableStringify(answer.value),
          kind: answer.kind,
        }
      : null,
  };
}
export function matchesAnswerRequest(answer, field) {
  const binding = answer.requestBinding;
  return (
    !!binding &&
    ["answer", "draft"].includes(answer.kind) &&
    binding.kind === answer.kind &&
    binding.field === stableStringify(evidenceField(field)) &&
    binding.value === stableStringify(answer.value)
  );
}
