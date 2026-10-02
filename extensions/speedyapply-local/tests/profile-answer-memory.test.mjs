import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const code = (
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "option-match",
      "profile-answers",
      "control-fields",
      "answer-memory",
    ].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
const profile = {
  addressData: { country: "United States" },
  employmentData: { sponsorship: true },
  educationData: [{ endDate: "2027-05" }],
  contactData: { email: "person@example.test" },
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function fixture(
  question,
  boundProfile = profile,
  { countryQuestion, save } = {},
) {
  const dom = new JSDOM("<form><label><span></span><input></label></form>", {
    url: "https://jobs.ashbyhq.com/test/role/application",
    runScripts: "outside-only",
  });
  const w = dom.window,
    doc = w.document,
    node = doc.querySelector("input"),
    saved = [];
  doc.querySelector("span").textContent = question;
  if (countryQuestion) {
    const label = doc.createElement("label");
    label.textContent = countryQuestion;
    label.append(doc.createElement("input"));
    doc.querySelector("form").append(label);
  }
  w.JobsPageSession = { profile: () => boundProfile };
  w.eval(code);
  const memory = w.JobsAnswerMemory.start(
    doc,
    true,
    save ||
      ((rows) => {
        saved.push(...JSON.parse(JSON.stringify(rows)));
        return Promise.resolve();
      }),
  );
  return {
    saved,
    w,
    node,
    memory,
    remember(value) {
      node.value = value;
      memory.remember(question, node);
    },
    close: () => w.close(),
  };
}

test("captured corrections that disagree with Profile retain their original answer and precision", async () => {
  for (const [question, value] of [
    ["Will you require sponsorship?", "No"],
    ["Graduation year", "2028"],
    ["Graduation month", "December"],
    ["Graduation date (MM/DD/YYYY)", "05/18/2027"],
  ]) {
    const h = fixture(question);
    try {
      h.remember(value);
      await settle();
      assert.deepEqual(h.saved, [
        {
          question,
          response: value,
          jobKey: h.w.JobsJobMatch.key(h.w.location.href),
        },
      ]);
    } finally {
      h.close();
    }
  }
});

test("equivalent captures do not become a second stale copy of Profile facts", async () => {
  for (const [question, value] of [
    ["Will you require sponsorship?", "Yes"],
    ["Graduation year", "2027"],
    ["Graduation month", "May"],
    ["Email", "person@example.test"],
  ]) {
    const h = fixture(question);
    try {
      h.remember(value);
      await settle();
      assert.deepEqual(h.saved, []);
    } finally {
      h.close();
    }
  }
});

test("capture equivalence uses the current form country and current bound Profile", async () => {
  const question = "Will you require sponsorship?";
  for (const [boundProfile, options] of [
    [
      profile,
      { countryQuestion: "Are you legally authorized to work in Canada?" },
    ],
    [{ ...profile, employmentData: { sponsorship: false } }, {}],
    [{ ...profile, employmentData: {} }, {}],
  ]) {
    const h = fixture(question, boundProfile, options);
    try {
      h.remember("Yes");
      await settle();
      assert.deepEqual(h.saved, [
        {
          question,
          response: "Yes",
          jobKey: h.w.JobsJobMatch.key(h.w.location.href),
        },
      ]);
    } finally {
      h.close();
    }
  }
});

test("correcting a failed queued capture back to the Profile value does not retry the stale answer", async () => {
  const attempts = [];
  const h = fixture("Email", profile, {
    save: (rows) => {
      attempts.push(...JSON.parse(JSON.stringify(rows)));
      return Promise.reject(Error("offline"));
    },
  });
  try {
    h.remember("old@example.test");
    await settle();
    assert.equal(attempts.length, 1);
    h.remember("person@example.test");
    h.memory.flush();
    await settle();
    assert.deepEqual(attempts, [
      {
        question: "Email",
        response: "old@example.test",
        jobKey: h.w.JobsJobMatch.key(h.w.location.href),
      },
    ]);
  } finally {
    h.close();
  }
});
