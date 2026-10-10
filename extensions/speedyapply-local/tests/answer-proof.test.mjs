import test from "node:test";
import assert from "node:assert/strict";
import {
  bindAnswerEvidence,
  matchesAnswerRequest,
} from "../src/custom/answer-proof.js";
import { sameValue } from "../src/custom/stable-value.js";
import { answerNeedsReview } from "../src/custom/automatic-field-policy.js";
const field = {
  fieldId: "f",
  question: "Example question",
  type: "radio",
  required: true,
  description: "",
  options: [
    { value: "n", label: "No" },
    { value: "y", label: "Yes" },
  ],
};
const bound = { id: "p", lastSync: "v" };
const row = {
  fieldId: "f",
  kind: "answer",
  value: "n",
  binding: { profileId: "p", profileVersion: "v", field },
};
test("object ordering is ignored and array ordering is retained", () => {
  assert(sameValue({ a: [{ b: 1, c: 2 }] }, { a: [{ c: 2, b: 1 }] }));
  assert(!sameValue([1, 2], [2, 1]));
  const reordered = {
    ...field,
    options: field.options.map(({ label, value }) => ({ label, value })),
  };
  assert(
    matchesAnswerRequest(bindAnswerEvidence(row, reordered, bound), field),
  );
});
test("only stale request data blocks an answer; no semantic proof or source is required", () => {
  const answer = bindAnswerEvidence(row, field, bound);
  assert(matchesAnswerRequest(answer, field));
  assert(!answerNeedsReview(answer, {}, { confirm: true }, field));
  for (const patch of [
    { profileId: "other" },
    { profileVersion: "old" },
    { field: { ...field, required: false } },
  ])
    assert(
      !matchesAnswerRequest(
        bindAnswerEvidence(
          { ...row, binding: { ...row.binding, ...patch } },
          field,
          bound,
        ),
        field,
      ),
    );
  assert(!matchesAnswerRequest({ ...answer, value: "y" }, field));
  assert(
    !matchesAnswerRequest(answer, {
      ...field,
      options: [...field.options].reverse(),
    }),
  );
  assert(
    !matchesAnswerRequest(
      bindAnswerEvidence(
        { ...row, binding: null, requestBinding: answer.requestBinding },
        field,
        bound,
      ),
      field,
    ),
  );
});
test("draft and unknown stay distinct without a verifier category", () => {
  const draft = bindAnswerEvidence({ ...row, kind: "draft" }, field, bound);
  assert(matchesAnswerRequest(draft, field));
  assert(answerNeedsReview(draft, {}, {}, field));
  assert(
    !matchesAnswerRequest(
      bindAnswerEvidence(
        { ...row, kind: "unknown", value: null },
        field,
        bound,
      ),
      field,
    ),
  );
});
