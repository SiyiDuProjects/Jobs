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
  addressData: {
    line1: "10 Test Street",
    line2: "Suite 2",
    country: "United States",
  },
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
test("unsupported conditions cannot inherit a simpler fact or old saved answer", async () => {
  for (const question of [
    "Your previous address",
    "Do you have unrestricted work authorization?",
    "Will you require sponsorship and a security clearance?",
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
test("shared question recognition uses the same fact readers as canonical labels", async () => {
  const rows = await JobsAnswerResolver.resolve(
    [
      { question: "Please state your full legal name:" },
      {
        question: "Are you authorized to work in the United States?",
        options: ["Yes", "No"],
      },
      {
        question: "Will you now or in the future require sponsorship?",
        options: ["Yes", "No"],
      },
    ],
    profile,
  );
  assert.deepEqual(
    rows.map((row) => row.answer),
    ["Alex Example", "Yes", "Yes"],
  );
  assert(rows.every((row) => row.source === "profile"));
  for (const [label, type] of Object.entries(AnswerVocabulary.localFields)) {
    assert(label.length < 80);
    assert.equal(typeof type.field, "string");
    assert.equal(
      typeof JobsProfileAnswers.topicRegistry[type.theme].resolve,
      "function",
    );
  }
});

test("fallback retains missing facts, extra conditions and incompatible options", async () => {
  const questions = [
    {
      question: "Are you authorized to work in the United States?",
      description: "This authorization must permit work for any employer",
      options: ["Yes", "No"],
    },
    {
      question: "Are you authorized to work in the United States?",
      options: ["Yes, without restrictions", "No"],
    },
    { question: "What day will you graduate?", type: "date" },
    {
      question: "Do you currently require visa sponsorship?",
      options: ["Yes", "No"],
    },
  ];
  const current = { ...profile, educationData: [{ endDate: "2027-05" }] };
  const decisions = [];
  assert.deepEqual(
    await JobsAnswerResolver.resolve(questions, current, {
      onDecision: (d) => decisions.push(d),
    }),
    [],
  );
  assert(
    decisions.every(
      (d) =>
        d.status === "unmatched" && d.reason === "server_decision_required",
    ),
  );
  assert.equal(
    JobsProfileAnswers.resolve("Please state your full legal name:", profile, {
      description: "Please state your full legal name: ✱",
    }).answer,
    "Alex Example",
  );
});

test("captions and option echoes add no condition; extra explanation still goes to the service", async () => {
  const question = "Are you legally authorized to work in the U.S.?";
  for (const description of [question, `${question} Yes No`, "Yes No"]) {
    const rows = await JobsAnswerResolver.resolve(
      [{ question, description, options: ["Yes", "No"] }],
      profile,
    );
    assert.equal(rows[0]?.answer, "Yes", description);
  }
  for (const description of [
    `${question} Yes No. This authorization must cover any employer.`,
    "Yes, without restrictions No",
    "Yes. Answer No if you need sponsorship.",
  ]) {
    assert.deepEqual(
      await JobsAnswerResolver.resolve(
        [{ question, description, options: ["Yes", "No"] }],
        profile,
      ),
      [],
      description,
    );
  }
});
