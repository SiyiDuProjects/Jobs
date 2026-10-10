import { JobsProfileAnswers } from "./profile-answers.js";
import { matchesAnswerRequest } from "./answer-proof.js";
// A search query is bound to the current field. The existing component then finds an
// equivalent offered label and commits it through the same guarded writer.
export function searchAnswerSpec(answer, field, profile = {}) {
  if (
    !["search-choice", "combobox", "select-one"].includes(field.type) ||
    answer.kind !== "answer" ||
    !matchesAnswerRequest(answer, field) ||
    typeof answer.value !== "string" ||
    !answer.value.trim()
  )
    return null;
  if (
    JobsProfileAnswers.classify(field.question)?.field ===
      "educationData.school" ||
    profile.educationData?.some(
      (row) =>
        row.school &&
        JobsProfileAnswers.schoolMatches(row.school, answer.value),
    )
  )
    return JobsProfileAnswers.schoolSpec(
      field.options?.find((option) => option.value === answer.value)?.label ||
        answer.value,
    );
  return field.type === "search-choice"
    ? { tiers: [[answer.value]], query: answer.value, strict: true }
    : null;
}
