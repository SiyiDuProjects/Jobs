import test from "node:test";
import assert from "node:assert/strict";
import { initializeOptionMatch } from "../src/custom/option-match.js";
import {
  JobsProfileAnswers,
  initializeProfileAnswers,
} from "../src/custom/profile-answers.js";
import {
  JobsAnswerResolver,
  initializeAnswerResolver,
} from "../src/custom/answer-resolver.js";
import { AnswerVocabulary } from "../src/custom/answer-vocabulary.js";
initializeOptionMatch();
initializeProfileAnswers();
initializeAnswerResolver();
const profile = {
  nameData: { firstName: "Alex", lastName: "Example" },
  addressData: { line1: "10 Test Street", line2: "Suite 2" },
  employmentData: { eligibilityUS: true, sponsorship: true },
};
test("canonical labels and signatures keep deterministic Profile formatting", async () => {
  const rows = await JobsAnswerResolver.resolve(
    [{ question: "First name" }, { question: "Address line 2" }],
    profile,
  );
  assert.deepEqual(
    rows.map((row) => row.answer),
    ["Alex", "Suite 2"],
  );
  assert.equal(
    JobsProfileAnswers.resolve("Signature and Date", profile).answer.startsWith(
      "Alex Example",
    ),
    true,
  );
});
test("conditions and free-form claims cannot inherit a simpler canonical field or old saved answer", async () => {
  for (const question of [
    "Your previous address",
    "Do you have unrestricted work authorization?",
    "Will you now or in the future require sponsorship?",
    "I accept the privacy policy and certify I have never been disciplined",
  ]) {
    assert.equal(
      (
        await JobsAnswerResolver.resolve(
          [{ question, required: true }],
          profile,
        )
      ).length,
      0,
      question,
    );
  }
  assert.equal(
    JobsProfileAnswers.resolve("Address", profile, {
      description: "Provide your employer's business address",
    }),
    null,
  );
  assert.equal(JobsAnswerResolver.matchSaved, undefined);
  assert.equal(JobsAnswerResolver.countKeywords, undefined);
});
test("the local catalog contains literal field types and no executable question recognizers", () => {
  for (const theme of Object.values(JobsProfileAnswers.topicRegistry))
    assert.equal(theme.recognize, undefined);
  for (const [label, type] of Object.entries(AnswerVocabulary.localFields)) {
    assert(label.length < 80);
    assert.equal(typeof type.field, "string");
    assert.equal(
      typeof JobsProfileAnswers.topicRegistry[type.theme].resolve,
      "function",
    );
  }
});
