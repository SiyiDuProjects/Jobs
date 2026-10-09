import test from "node:test";
import assert from "node:assert/strict";
import {
  bindAnswerEvidence,
  verifiedAnswer,
  reviewProposal,
} from "../src/custom/answer-proof.js";
import { answerNeedsReview } from "../src/custom/automatic-field-policy.js";
const field = {
  fieldId: "f",
  question: "Are you bound by a non-compete agreement?",
  type: "radio",
  required: true,
  description: "",
  options: [{ value: "n", label: "No" }],
};
const bound = { id: "p", lastSync: "v" };
const answer = {
  fieldId: "f",
  state: "answer",
  source: "profile",
  value: "n",
  decision: "write",
  needsConfirmation: false,
  proof: {
    version: 2,
    status: "verified",
    profileId: "p",
    profileVersion: "v",
    field,
    value: "n",
    id: "a".repeat(24),
    paths: [],
  },
};
test("only exact field value and pinned Profile evidence can remove confirmation", () => {
  const valid = bindAnswerEvidence(answer, field, bound);
  assert(verifiedAnswer(valid, field));
  assert.equal(
    answerNeedsReview(valid, { public: {} }, { confirm: false }, field),
    false,
  );
  assert.equal(
    answerNeedsReview(valid, { public: {} }, { confirm: true }, field),
    true,
  );
  for (const patch of [
    { version: 1 },
    { profileId: "another" },
    { profileVersion: "old" },
    { value: "y" },
    {
      field: {
        ...field,
        options: [{ value: "n", label: "No current or previous agreement" }],
      },
    },
    { status: "unverified" },
  ]) {
    const invalid = bindAnswerEvidence(
      { ...answer, proof: { ...answer.proof, ...patch } },
      field,
      bound,
    );
    assert.equal(invalid.verification, null);
    assert.equal(answerNeedsReview(invalid, { public: {} }, {}, field), true);
  }
  assert.equal(
    bindAnswerEvidence(
      { ...answer, proof: null, verification: valid.verification },
      field,
      bound,
    ).verification,
    null,
  );
  assert.equal(
    answerNeedsReview({ ...answer, proof: null }, { public: {} }, {}, field),
    true,
  );
  assert.equal(verifiedAnswer(valid, { ...field, required: false }), false);
  assert.equal(
    verifiedAnswer(
      { ...valid, decision: "draft", source: "suggestion" },
      field,
    ),
    false,
  );
});

test("proposed proof is bound to the exact field but never authorizes autofill", () => {
  const proposal = {
    ...answer,
    source: "suggestion",
    decision: "draft",
    reviewOnly: true,
    needsConfirmation: true,
    proof: { ...answer.proof, status: "proposed" },
  };
  const boundProposal = bindAnswerEvidence(proposal, field, bound);
  assert(reviewProposal(boundProposal, field));
  assert.equal(verifiedAnswer(boundProposal, field), false);
  assert.equal(
    reviewProposal(boundProposal, { ...field, question: "Changed question" }),
    false,
  );
  assert.equal(reviewProposal({ ...boundProposal, value: "y" }, field), false);
  assert.equal(
    reviewProposal(
      bindAnswerEvidence(proposal, field, { ...bound, lastSync: "new" }),
      field,
    ),
    false,
  );
  assert.equal(
    verifiedAnswer({ ...boundProposal, reviewOnly: false }, field),
    false,
  );
});
