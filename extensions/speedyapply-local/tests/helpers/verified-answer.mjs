import { bindAnswerEvidence } from "../../src/custom/answer-proof.js";
// These pipeline fixtures mock the authenticated service/background boundary.
// Tests of unverified provenance deliberately do not call this helper. Actual
// entailment and stale-proof rejection have independent service/binding tests.
export function confirmedAnswer(field, row, paths = []) {
  if (
    row.state !== "answer" ||
    row.needsConfirmation !== false ||
    !["profile", "ai"].includes(row.source)
  )
    return row;
  const answer = {
    ...row,
    source: "profile",
    decision: "write",
    proof: {
      version: 2,
      status: "verified",
      profileId: "fixture",
      profileVersion: "fixture-v1",
      field,
      value: row.value,
      id: "b".repeat(24),
      paths,
    },
  };
  return bindAnswerEvidence(answer, field, {
    id: "fixture",
    lastSync: "fixture-v1",
  });
}

export function confirmedDraft(field, value) {
  const answer = confirmedAnswer(field, {
    fieldId: field.fieldId,
    state: "answer",
    value,
    source: "profile",
    needsConfirmation: false,
  });
  return bindAnswerEvidence(
    {
      ...answer,
      source: "suggestion",
      decision: "draft",
      needsConfirmation: true,
    },
    field,
    { id: "fixture", lastSync: "fixture-v1" },
  );
}
