import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const modules = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function fixture({
  addressData = { line1: "10 Example Street" },
  required = false,
  initial = "",
  question = "Address 2",
} = {}) {
  const dom = new JSDOM(
    `<form><label for="line1">Address*</label><input id="line1" required value="10 Example Street"><label for="line2">${question}</label><input id="line2" ${required ? "required" : ""}></form>`,
    {
      url: "https://careers.example.icims.com/jobs/1/profile",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    profile = addressData === null ? {} : { addressData },
    events = [],
    requests = [];
  w.document.getElementById("line2").value = initial;
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        requests.push(message);
        return {
          data: {
            answers: message.fields.map((f) => ({
              fieldId: f.fieldId,
              state: "answer",
              source: "profile",
              needsConfirmation: false,
              value: "10 Example Street, Example City",
              reason: "Incorrect full-address fallback",
            })),
          },
        };
      },
    },
  };
  modules.forEach((code) => w.eval(code));
  installAnswerResolver(w, [
    {
      keywords: ["address"],
      appearances: 1,
      response: "10 Example Street, Example City",
    },
  ]);
  const run = (options = {}) =>
    w.JobsAutomatic.advance({
      root: w.document.querySelector("form"),
      profile,
      action: "fill",
      ...options,
    });
  return { w, profile, events, requests, run, close: () => w.close() };
}

test("address second-line variants map only to the second profile line", () => {
  const f = fixture({
    addressData: { line1: "10 Example Street", line2: "Suite 42" },
  });
  try {
    for (const question of [
      "Address 2",
      "Address Line 2",
      "Street Address 2",
      "Address line two (optional)",
    ])
      assert.equal(
        f.w.JobsProfileAnswers.resolve(question, f.profile)?.answer,
        "Suite 42",
        question,
      );
    for (const question of [
      "Previous address 2",
      "Employer address 2",
      "Address for the last 2 years",
    ])
      assert.equal(
        f.w.JobsProfileAnswers.resolve(question, f.profile),
        null,
        question,
      );
  } finally {
    f.close();
  }
});

test("empty optional line two stays blank before either saved answers or AI can copy the full address", async () => {
  for (const line2 of [undefined, "", "   "]) {
    const f = fixture({ addressData: { line1: "10 Example Street", line2 } });
    try {
      assert.equal(await f.run(), true);
      assert.equal(f.w.document.getElementById("line2").value, "");
      assert.equal(
        f.w.document.getElementById("line1").value,
        "10 Example Street",
      );
      assert.equal(f.requests.length, 0);
      assert(!f.events.some(([type]) => type === "auto_field_omitted"));
      assert.equal(f.w.JobsAIReview.pending(), false);
    } finally {
      f.close();
    }
  }
});

test("a required second address line is filled exactly from the bound profile", async () => {
  const f = fixture({
    required: true,
    addressData: { line1: "10 Example Street", line2: "Apartment 8" },
  });
  try {
    assert.equal(await f.run(), true);
    assert.equal(f.w.document.getElementById("line2").value, "Apartment 8");
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test("AI-only supplemental entry also respects the empty second line", async () => {
  const f = fixture();
  try {
    assert.equal(await f.run({ resolveAnswers: undefined }), true);
    assert.equal(f.w.document.getElementById("line2").value, "");
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test("required second address line without a value remains unresolved instead of copying line one", async () => {
  const f = fixture({ required: true });
  try {
    assert.equal(await f.run(), false);
    assert.equal(f.w.document.getElementById("line2").value, "");
    assert.equal(f.requests.length, 0);
    assert(f.w.JobsAIReview.pending());
  } finally {
    f.close();
  }
});

test("an absent address profile is unknown rather than an intentional blank", async () => {
  const f = fixture({ required: true, addressData: null });
  try {
    assert.equal(await f.run(), false);
    assert.equal(f.w.document.getElementById("line2").value, "");
    assert.equal(f.requests.length, 0);
    assert(f.w.JobsAIReview.pending());
  } finally {
    f.close();
  }
});

test("an existing user-entered second address line is preserved", async () => {
  const f = fixture({ initial: "User supplied unit" });
  try {
    assert.equal(await f.run(), true);
    assert.equal(
      f.w.document.getElementById("line2").value,
      "User supplied unit",
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});
