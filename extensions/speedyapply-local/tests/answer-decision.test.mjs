import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const base = new URL("../", import.meta.url);
const profileCode = await Promise.all(
  ["option-match", "profile-answers"].map((n) =>
    readModule(new URL("src/custom/" + n + ".js", base), "utf8"),
  ),
).then((parts) => parts.join("\n"));
const responseContract = await import("../src/custom/response-contract.js");
const profile = {
  nameData: { firstName: "Example", lastName: "Applicant" },
  websiteData: {},
  addressData: { country: "United States" },
  employmentData: {},
  applicationData: {},
};

test("Intel legal questions cannot inherit generic acknowledgement or government keyword answers", async () => {
  const c = fixture([
    { keywords: ["response"], appearances: 1, response: "Yes, I agree" },
    { keywords: ["employee"], appearances: 1, response: "Yes" },
  ]);
  const questions = [
    {
      question:
        "If your response to question 9 is No, please specify the country or countries where you have citizenship or lawful permanent resident status.",
      type: "textarea",
    },
    {
      question:
        "Are you a current Federal, State or Local Government employee, including military, or have you at any time in the past 5 years been an employee of one of these entities?",
      options: ["Yes", "No"],
    },
  ];
  assert.equal(
    (await c.JobsAnswerResolver.resolve(questions, profile)).length,
    0,
  );
});

test("employer instructions explicitly requiring student visa holders to answer Yes cannot use the Intern No default", async () => {
  const c = fixture();
  const decisions = [];
  const answers = await c.JobsAnswerResolver.resolve(
    [
      {
        question:
          "Do you now, or in the future, require Intel to sponsor you for a visa to work in the United States? NOTE: Individuals with work authorization issued pursuant to their student visa (e.g., F-1, J-1, M-1) should answer “Yes”.",
        options: ["Yes", "No"],
      },
    ],
    {
      ...profile,
      employmentData: { sponsorship: false },
      applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
    },
    { onDecision: (d) => decisions.push(d) },
  );
  assert.equal(answers.length, 0);
  assert.equal(
    decisions[0].reason,
    "employer_specific_student_visa_instructions",
  );
});
function fixture(saved = []) {
  const c = vm.createContext({ saved });
  vm.runInContext(profileCode + "\n" + resolverWith("saved"), c);
  return c;
}

test("explicit Arts maps Upbound degree labels deterministically; generic bachelor cannot be guessed by AI", async () => {
  const c = fixture();
  for (const degree of ["Bachelor's", "Bachelor of Arts"]) {
    const decisions = [];
    const answers = await c.JobsAnswerResolver.resolve(
      [
        {
          question: "Degree*",
          type: "combobox",
          options: ["Bachelor of Science (B.S)", "Bachelor of Arts (B.A)"],
        },
      ],
      { ...profile, educationData: [{ degree, fieldOfStudy: "Physics" }] },
      { onDecision: (d) => decisions.push(d) },
    );
    assert.equal(decisions[0].source, "profile");
    assert.equal(decisions[0].profileAnswer.profileOnly, true);
    if (degree === "Bachelor of Arts") {
      assert.equal(answers[0].answer, "Bachelor of Arts (B.A)");
      assert.equal(decisions[0].status, "answered");
    } else {
      assert.equal(answers.length, 0);
      assert.equal(decisions[0].status, "needs-input");
    }
  }
});
test("one decision contract distinguishes answers, unrecognized questions and unavailable facts", async () => {
  const c = fixture([
    {
      question: "How did you find this job?",
      keywords: ["find"],
      appearances: 1,
      response: "University portal",
    },
  ]);
  const decisions = [];
  const answers = await c.JobsAnswerResolver.resolve(
    [
      { question: "First name" },
      { question: "How did you find this job?" },
      { question: "Describe the unknown project" },
      { question: "Graduation date", type: "date" },
    ],
    profile,
    { onDecision: (d) => decisions.push(d) },
  );
  assert.deepEqual(
    decisions.map((d) => d.status),
    ["answered", "answered", "unmatched", "needs-input"],
  );
  assert.deepEqual(
    decisions.map((d) => d.source),
    ["profile", "saved", "none", "profile"],
  );
  assert.equal(decisions[0].field, "nameData.firstName");
  assert.equal(decisions[1].reason, "saved_exact_question");
  assert.equal(decisions[3].reason, "missing_day_precision");
  assert.deepEqual(
    Array.from(answers, (d) => [d.index, d.answer]),
    [
      [0, "Example"],
      [1, "University portal"],
    ],
  );
});
test("matching priority and original option matching are preserved while their source is observable", async () => {
  const c = fixture([
      {
        id: "fixture-source-rule",
        keywords: ["hear about"],
        appearances: 1,
        response: "Friend or Referral",
      },
    ]),
    decisions = [];
  const result = await c.JobsAnswerResolver.resolve(
    [
      {
        question: "How did you hear about this job?",
        options: ["A Friend or Referral", "Search engine"],
      },
    ],
    profile,
    { onDecision: (d) => decisions.push(d) },
  );
  assert.equal(result[0].answer, "A Friend or Referral");
  assert.equal(decisions[0].source, "saved");
  assert.equal(decisions[0].reason, "keyword_match");
  assert.equal(decisions[0].ruleId, "fixture-source-rule");
});
test("a recognized but absent new Profile fact differs from an unrecognized question after fallback is exhausted", async () => {
  const c = fixture(),
    decisions = [];
  const answers = await c.JobsAnswerResolver.resolve(
    [
      { question: "Earliest start date", type: "date" },
      { question: "Unknown research story" },
    ],
    profile,
    { onDecision: (decision) => decisions.push(decision) },
  );
  assert.equal(answers.length, 0);
  assert.equal(decisions[0].status, "needs-input");
  assert.equal(decisions[0].source, "profile");
  assert.equal(decisions[0].field, "applicationData.earliestStartDate");
  assert.equal(decisions[0].reason, "profile_unavailable");
  assert.equal(decisions[1].status, "unmatched");
  assert.equal(decisions[1].field, null);
});

test("Persistent Systems experience and percentage questions cannot reuse a saved applicant name", async () => {
  const questions = [
    "How many years of experience do you have programming in C or C++?*",
    "How many years of experience do you have programming on Embedded Linux?*",
    "Of the coding that you do currently, how much is spent in C/C++ ?*",
    "What percentage of your time is currently spent doing direct coding?*",
  ];
  for (const saved of [
    [{ keywords: ["you"], appearances: 1, response: "Example Applicant" }],
    [{ keywords: [], appearances: 0, response: "Example Applicant" }],
    questions.map((question) => ({
      question,
      keywords: ["experience"],
      appearances: 1,
      response: "Example Applicant",
    })),
  ]) {
    const c = fixture(saved),
      decisions = [];
    const answers = await c.JobsAnswerResolver.resolve(
      questions.map((question) => ({ question, type: "text" })),
      profile,
      { onDecision: (d) => decisions.push(d) },
    );
    assert.equal(answers.length, 0);
    assert(decisions.every((d) => d.status === "unmatched"));
  }
  const c = fixture([
    {
      question: questions[0],
      keywords: ["programming"],
      appearances: 1,
      response: "2",
    },
  ]);
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: questions[0], type: "text" }],
        profile,
      )
    )[0].answer,
    "2",
  );
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: "Full name", type: "text" }],
        profile,
      )
    )[0].answer,
    "Example Applicant",
  );
});

test("empty and zero-threshold keyword rules cannot match unrelated questions", () => {
  const c = fixture();
  for (const rule of [
    { keywords: [], appearances: 0 },
    { keywords: [""], appearances: 1 },
    { keywords: ["programming"], appearances: 0 },
    { keywords: ["programming"], appearances: -1 },
  ])
    assert.equal(
      c.JobsAnswerResolver.matchSaved(
        { question: "How much experience?", type: "text" },
        [{ ...rule, response: "Wrong answer" }],
      ),
      null,
    );
  assert.equal(
    c.JobsAnswerResolver.matchSaved({ question: "Specific question" }, [
      {
        question: "Specific question",
        keywords: [],
        appearances: 0,
        response: "Exact answer",
      },
    ]),
    "Exact answer",
  );
});

test("every caller of the shared counter ignores blank, invalid and duplicate keywords", () => {
  const c = fixture(),
    question =
      "What percentage of your time is currently spent doing direct coding?*";
  assert.equal(
    c.JobsAnswerResolver.countKeywords(question, [
      "",
      " ",
      "\t",
      null,
      undefined,
    ]),
    0,
  );
  assert.equal(
    c.JobsAnswerResolver.countKeywords(question, [
      "",
      "coding",
      " CODING ",
      "全名",
    ]),
    1,
  );
  assert.equal(c.JobsAnswerResolver.countKeywords("", ["coding"]), 0);
  assert.equal(c.JobsAnswerResolver.countKeywords(question, null), 0);
  assert.equal(
    c.JobsAnswerResolver.matchSaved({ question }, [
      {
        keywords: ["coding", "coding"],
        appearances: 2,
        response: "Wrong answer",
      },
    ]),
    null,
  );
});

test("Chinese answer options retain their identity and cannot compare as equal empty strings", () => {
  const c = fixture();
  for (const question of ["Eligibility", "Other question"]) {
    const rule = {
      question: "Eligibility",
      keywords: ["other"],
      appearances: 1,
      response: "否",
    };
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question, options: ["是", "否"] }, [
        rule,
      ]),
      "否",
    );
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question, options: ["是", "否"] }, [
        { ...rule, response: "未确认" },
      ]),
      null,
    );
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question, options: ["---", "否"] }, [
        { ...rule, response: "???" },
      ]),
      null,
    );
  }
});

test("the production saved-response schema preserves Chinese keywords rather than turning them into match-all blanks", () => {
  assert.deepEqual(
    responseContract.JobsResponseContract.parseList([
      {
        key: "full-name",
        keywords: ["全名"],
        appearances: 1,
        response: "Example Applicant",
      },
    ])[0].keywords,
    ["全名"],
  );
  const c = fixture();
  assert.equal(
    c.JobsAnswerResolver.matchSaved(
      {
        question:
          "How many years of experience do you have programming in C or C++?",
      },
      [{ keywords: ["全名"], appearances: 1, response: "Example Applicant" }],
    ),
    null,
  );
  assert.equal(
    c.JobsAnswerResolver.matchSaved({ question: "全名" }, [
      { keywords: ["全名"], appearances: 1, response: "Example Applicant" },
    ]),
    "Example Applicant",
  );
});

test("relocation funding needs its own confirmed answer even when relocation and onsite preferences are Yes", async () => {
  const p = {
    ...profile,
    applicationData: { willingToRelocate: true, willingToWorkOnsite: true },
  };
  const question =
    "Are you able to work in New York City without relocation assistance?*";
  const c = fixture([
      { keywords: ["relocation"], appearances: 1, response: "Yes" },
    ]),
    decisions = [];
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question, options: ["Yes", "No"] }],
        p,
        { onDecision: (d) => decisions.push(d) },
      )
    ).length,
    0,
  );
  assert.equal(decisions[0].reason, "relocation_assistance_unconfirmed");
  assert.equal(decisions[0].profileAnswer.profileOnly, true);
  assert.equal(c.JobsProfileAnswers.resolve(question, p), null);
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: "Are you willing to relocate?", options: ["Yes", "No"] }],
        p,
      )
    )[0].answer,
    "Yes",
  );
  const explicit = fixture([
    { question, keywords: ["relocation"], appearances: 1, response: "No" },
  ]);
  assert.equal(
    (
      await explicit.JobsAnswerResolver.resolve(
        [{ question, options: ["Yes", "No"] }],
        p,
      )
    )[0].answer,
    "No",
  );
});
