import { bindAnswerEvidence } from "../../src/custom/answer-proof.js";
// Control fixtures mock the wire boundary; a separate integration test calls Python.
export function confirmedAnswer(field, row) {
  const kind =
    row.kind ||
    (row.state === "needs_input"
      ? "unknown"
      : row.source === "suggestion" && ["text", "textarea"].includes(field.type)
        ? "draft"
        : "answer");
  const answer = {
    ...row,
    kind,
    reasonZh: row.reasonZh || row.reason,
    binding: { profileId: "fixture", profileVersion: "fixture-v1", field },
  };
  return bindAnswerEvidence(answer, field, {
    id: "fixture",
    lastSync: "fixture-v1",
  });
}
export function confirmedDraft(field, value) {
  return confirmedAnswer(field, {
    fieldId: field.fieldId,
    kind: "draft",
    value,
    source: "suggestion",
  });
}
