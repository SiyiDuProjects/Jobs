import test from "node:test";
import assert from "node:assert/strict";
import {
  initializeOptionMatch,
  JobsOptionMatch,
} from "../src/custom/option-match.js";
import { initializeProfileAnswers } from "../src/custom/profile-answers.js";
import {
  initializeAnswerResolver,
  JobsAnswerResolver,
} from "../src/custom/answer-resolver.js";
import { JobsResponseContract } from "../src/custom/response-contract.js";
initializeOptionMatch();
initializeProfileAnswers();
initializeAnswerResolver();
const profile = {
  nameData: { firstName: "Example", lastName: "Applicant" },
  employmentData: { eligibilityUS: true, sponsorship: false },
  applicationData: { sponsorshipNow: false, sponsorshipFuture: true },
  addressData: { line1: "10 Test Street", country: "United States" },
  educationData: [{ degree: "Bachelor of Arts", endDate: "2027-05" }],
};

test("known facts carry their source, while missing date precision goes to the server", async () => {
  const decisions = [];
  const answers = await JobsAnswerResolver.resolve(
    [
      { question: "First name" },
      { question: "Graduation date", type: "date", required: true },
      {
        question: "Will you require sponsorship now or in the future?",
        required: true,
      },
    ],
    profile,
    { onDecision: (row) => decisions.push(row) },
  );
  assert.deepEqual(
    answers.map((row) => [row.index, row.answer, row.source]),
    [
      [0, "Example", "profile"],
      [2, "Yes", "profile"],
    ],
  );
  assert.deepEqual(
    decisions.map((row) => row.status),
    ["answered", "unmatched", "answered"],
  );
});

test("the actual degree option preserves confirmed subtype and rejects a guessed subtype", async () => {
  const fields = [
    {
      question: "Degree*",
      type: "combobox",
      options: ["Bachelor of Science (B.S)", "Bachelor of Arts (B.A)"],
    },
  ];
  assert.equal(
    (await JobsAnswerResolver.resolve(fields, profile))[0].answer,
    "Bachelor of Arts (B.A)",
  );
  assert.deepEqual(
    await JobsAnswerResolver.resolve(fields, {
      educationData: [{ degree: "Bachelor's" }],
    }),
    [],
  );
});

test("empty optional address line is deliberate but required missing facts are delegated", () => {
  assert.equal(
    JobsAnswerResolver.decide(
      { question: "Address line 2", required: false },
      profile,
    ).status,
    "omit",
  );
  assert.equal(
    JobsAnswerResolver.decide(
      { question: "Address line 2", required: true },
      profile,
    ).status,
    "unmatched",
  );
});

test("exact and keyword memories cannot locally override current canonical Profile facts", async () => {
  const saved = [
    { origin: "person", question: "First name", response: "Old name" },
    {
      origin: "person",
      question: "Do you require sponsorship?",
      response: "No",
      keywords: ["sponsorship"],
      appearances: 1,
    },
  ];
  const answers = await JobsAnswerResolver.resolve(
    [{ question: "First name" }, { question: "Do you require sponsorship?" }],
    profile,
    { saved },
  );
  assert.deepEqual(
    answers.map((row) => row.answer),
    ["Example", "Yes"],
  );
  assert.equal(JobsAnswerResolver.matchSaved, undefined);
  assert.equal(JobsAnswerResolver.countKeywords, undefined);
});

test("symbols, negation and non-English options retain their exact identity", () => {
  for (const [answer, options, expected] of [
    ["否", ["是", "否"], "否"],
    ["未确认", ["是", "否"], null],
    ["C++", ["C", "C#"], null],
    ["C++", ["C", "C++", "C#"], "C++"],
    ["1-2 years", ["12 years", "2 years"], null],
    ["No professional experience", ["Professional experience"], null],
    ["Research", ["Research engineering", "Research analysis"], null],
    ["???", ["---", "否"], null],
  ])
    assert.equal(
      JobsOptionMatch.pick(options, answer)?.label || null,
      expected,
    );
});

test("legacy keyword metadata survives storage but no longer provides a matching function", () => {
  const rows = JobsResponseContract.parseList([
    {
      key: "old",
      keywords: ["全名"],
      appearances: 1,
      response: "Example Applicant",
    },
  ]);
  assert.deepEqual(rows[0].keywords, ["全名"]);
  assert.equal(rows[0].origin, undefined);
  assert.equal(JobsResponseContract.questionKeywords, undefined);
  assert.throws(() =>
    JobsResponseContract.parseList([
      { key: "invalid", keywords: [""], appearances: 1, response: "Bad" },
    ]),
  );
});
