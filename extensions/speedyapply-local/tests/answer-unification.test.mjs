import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const [profileCodeOnly, answers, contract, fields, wait] = await Promise.all(
  [
    "src/custom/profile-answers.js",
    "src/custom/answer-resolver.js",
    "src/custom/response-contract.js",
    "src/custom/control-fields.js",
    "src/custom/dom-wait.js",
  ].map(read),
);
const profileCode =
  (await read("src/custom/option-match.js")) + "\n" + profileCodeOnly;
const profile = {
  nameData: { firstName: "Example", lastName: "Applicant" },
  addressData: { country: "United States" },
  employmentData: { eligibilityUS: true, sponsorship: true, age: 22 },
  websiteData: { linkedin: "https://example.test/profile" },
  applicationData: {},
};
function fixture(saved = []) {
  const c = vm.createContext({ saved });
  vm.runInContext(profileCode + "\n" + resolverWith("saved"), c);
  return c;
}

test("one Profile resolver answers ordinary facts; no legacy Profile keyword engine remains", async () => {
  const c = fixture();
  assert.equal(c.jobsBuildProfileResponseRules, undefined);
  const rows = await c.JobsAnswerResolver.resolve(
    [
      {
        question: "Are you authorized to work in the United States?",
        options: ["Yes", "No"],
      },
      {
        question:
          "Will your employment require sponsorship now or in the future?",
        options: ["Yes", "No"],
      },
      { question: "Are you at least 18 years of age?", options: ["Yes", "No"] },
      { question: "Are you under 18 years of age?", options: ["Yes", "No"] },
      { question: "LinkedIn profile" },
    ],
    profile,
  );
  assert.deepEqual(
    Array.from(rows, (r) => r.answer),
    ["Yes", "Yes", "Yes", "No", "https://example.test/profile"],
  );
  assert(rows.every((row) => row.source === "profile"));
});

test("refused compound questions cannot fall back to coarse Profile or broad memory rules", async () => {
  const questions = [
    "Do you require sponsorship and a security clearance?",
    "Are you authorized to work in the United States and hold a security clearance?",
    "Are you authorized to work in the United States or Canada?",
    "Will you be 18 years of age by the internship start date?",
    "Do you require sponsorship and relocation assistance?",
  ];
  for (const applicationData of [
    {},
    { sponsorshipNow: false, sponsorshipFuture: false },
  ]) {
    const c = fixture([
        { keywords: ["sponsorship"], appearances: 1, response: "Yes" },
        { keywords: ["authorized to work"], appearances: 1, response: "Yes" },
        { keywords: ["18", "years"], appearances: 2, response: "Yes" },
      ]),
      decisions = [];
    const result = await c.JobsAnswerResolver.resolve(
      questions.map((question) => ({ question, options: ["Yes", "No"] })),
      { ...profile, applicationData },
      { onDecision: (d) => decisions.push(d) },
    );
    assert.equal(result.length, 0);
    assert(decisions.every((d) => d.status === "needs-input"));
    assert(
      decisions.every(
        (d) =>
          d.reason.startsWith("unresolved_") ||
          ["country_mismatch", "relocation_assistance_unconfirmed"].includes(
            d.reason,
          ),
      ),
      JSON.stringify(decisions),
    );
  }
});

test("an explicit whole-question memory has the same policy with old and expanded Profiles", async () => {
  const question = "Do you require sponsorship and a security clearance?";
  const c = fixture([
    { question, keywords: ["sponsorship"], appearances: 1, response: "No" },
  ]);
  for (const applicationData of [
    {},
    { sponsorshipNow: false, sponsorshipFuture: true },
  ]) {
    const result = await c.JobsAnswerResolver.resolve(
      [{ question, options: ["Yes", "No"] }],
      { ...profile, applicationData },
    );
    assert.equal(result[0].answer, "No");
    assert.equal(result[0].reason, "saved_exact_question");
  }
});

test("country-specific keywords cannot override a refused compound question", async () => {
  for (const question of [
    "Do you require sponsorship and a security clearance in Canada?",
    "Are you authorized to work in Canada and hold a security clearance?",
  ]) {
    const c = fixture([
      {
        keywords: ["canada", "sponsorship", "authorized"],
        appearances: 2,
        response: "Yes",
      },
    ]);
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: ["Yes", "No"] }],
          profile,
        )
      ).length,
      0,
    );
    c.saved.push({
      question,
      keywords: ["canada"],
      appearances: 1,
      response: "No",
    });
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: ["Yes", "No"] }],
          profile,
        )
      )[0].answer,
      "No",
    );
  }
});

test("all country detection uses one scope and unfamiliar countries do not become US authorization", async () => {
  for (const place of ["India", "Mexico", "Chile"]) {
    const question = "Are you authorized to work in " + place + "?";
    const c = fixture([
        { keywords: ["authorized", "work"], appearances: 2, response: "Yes" },
      ]),
      decisions = [];
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: ["Yes", "No"] }],
          profile,
          { onDecision: (d) => decisions.push(d) },
        )
      ).length,
      0,
      place,
    );
    assert.equal(decisions[0].reason, "country_mismatch");
    c.saved.push({
      question,
      keywords: ["work"],
      appearances: 1,
      response: "No",
    });
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: ["Yes", "No"] }],
          profile,
        )
      )[0].answer,
      "No",
    );
  }
});

test("legal keyword memories never expand Yes into citizenship or additional clearance claims", async () => {
  for (const [question, keywords, long] of [
    [
      "Are you authorized to work in Canada?",
      ["canada", "authorized"],
      "Yes, I am a Canadian citizen",
    ],
    [
      "Do you require sponsorship in Canada?",
      ["canada", "sponsorship"],
      "Yes, and I hold a security clearance",
    ],
  ]) {
    const c = fixture([{ keywords, appearances: 2, response: "Yes" }]);
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: [long, "No"] }],
          profile,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: ["Yes", "No"] }],
          profile,
        )
      )[0].answer,
      "Yes",
    );
    c.saved[0].response = long;
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options: [long, "No"] }],
          profile,
        )
      )[0].answer,
      long,
    );
  }
});

test("generic veteran=true never supplies protected veteran status from labels or options", async () => {
  const c = fixture();
  for (const question of [
    "Protected veteran status",
    "Are you a protected veteran?",
    "Veteran status",
  ]) {
    const options = [
      "I am a protected veteran",
      "I am not a protected veteran",
      "I prefer not to disclose",
    ];
    const decisions = [];
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve(
          [{ question, options }],
          { ...profile, employmentData: { veteran: true } },
          { onDecision: (d) => decisions.push(d) },
        )
      ).length,
      0,
    );
    assert.equal(decisions[0].profileAnswer.profileOnly, true);
    assert.equal(
      (
        await c.JobsAnswerResolver.resolve([{ question, options }], {
          ...profile,
          employmentData: { veteran: false },
        })
      )[0].answer,
      options[1],
    );
  }
});

test("bad memory records are skipped and diagnosed without mutating valid or rejected source records", async () => {
  const raw = [
    {
      key: "name",
      question: "全名",
      keywords: ["全名"],
      appearances: 1,
      response: "Example Applicant",
      fromAutofill: false,
    },
    {
      key: "damaged",
      keywords: [""],
      appearances: 1,
      response: "Retain in storage",
      fromAutofill: false,
    },
  ];
  const original = JSON.stringify(raw),
    events = [];
  const c = vm.createContext({
    chrome: {
      runtime: {
        sendMessage: async () => ({
          data: raw,
          rejected: [{ index: 7, reason: "Earlier boundary rejection" }],
        }),
      },
    },
    JobsDiagnostics: { note: (...args) => events.push(args) },
  });
  vm.runInContext(contract + "\n" + answers, c);
  const list = await c.JobsAnswerResolver.readSaved();
  assert.equal(list.length, 1);
  assert.equal(list[0].keywords[0], "全名");
  assert.equal(JSON.stringify(raw), original);
  assert.deepEqual(events, [["saved_responses_rejected", null, "2"]]);
});
