import { JobsProfileAnswers } from "./profile-answers.js";
import { verifiedAnswer } from "./answer-proof.js";
// A search query is a verified fact. The existing component then finds an
// equivalent offered label and commits it through the same guarded writer.
export function searchAnswerSpec(answer, field) {
  if (
    !["search-choice", "combobox", "select-one"].includes(field.type) ||
    answer.decision !== "write" ||
    !verifiedAnswer(answer, field) ||
    typeof answer.value !== "string" ||
    !answer.value.trim()
  )
    return null;
  const paths = answer.verification.paths;
  if (paths.length === 1 && /^educationData\.\d+\.school$/.test(paths[0]))
    return JobsProfileAnswers.schoolSpec(
      field.options?.find((option) => option.value === answer.value)?.label ||
        answer.value,
    );
  return field.type === "search-choice"
    ? { tiers: [[answer.value]], query: answer.value, strict: true }
    : null;
}
