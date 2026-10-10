// Only the background verifies a server decision against the pinned request.
// A model-provided source or similarly named property is never sufficient.
export const ANSWER_PROTOCOL = 2;
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
  const proof = answer.proof;
  const verified =
    ["write", "draft"].includes(answer.decision) &&
    answer.state === "answer" &&
    (answer.decision === "write"
      ? answer.source === "profile"
      : answer.source === "suggestion") &&
    proof?.version === ANSWER_PROTOCOL &&
    proof.status === "verified" &&
    answer.reviewOnly !== true &&
    proof.profileId === bound.id &&
    proof.profileVersion === bound.lastSync &&
    JSON.stringify(evidenceField(proof.field || {})) ===
      JSON.stringify(evidenceField(field)) &&
    JSON.stringify(proof.value) === JSON.stringify(answer.value) &&
    typeof proof.id === "string" &&
    /^[a-f0-9]{24}$/.test(proof.id) &&
    Array.isArray(proof.paths) &&
    proof.paths.every((path) => typeof path === "string");
  return {
    ...answer,
    verification: verified
      ? {
          version: ANSWER_PROTOCOL,
          decision: answer.decision,
          source: answer.source,
          fieldId: field.fieldId,
          field: JSON.stringify(evidenceField(field)),
          value: JSON.stringify(answer.value),
          profileId: bound.id,
          profileVersion: bound.lastSync,
          id: proof.id,
          paths: proof.paths,
        }
      : null,
  };
}
function matchesAnswer(answer, field) {
  const proof = answer.verification;
  return (
    proof?.version === ANSWER_PROTOCOL &&
    proof.decision === answer.decision &&
    proof.source === answer.source &&
    proof.fieldId === field.fieldId &&
    proof.field === JSON.stringify(evidenceField(field)) &&
    proof.value === JSON.stringify(answer.value)
  );
}

export function verifiedAnswer(answer, field) {
  return (
    answer.reviewOnly !== true &&
    !answer.verification?.reviewOnly &&
    matchesAnswer(answer, field)
  );
}
