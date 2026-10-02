import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const c = vm.createContext({});
vm.runInContext(
  await Promise.all(
    ["option-match", "profile-answers"].map((n) =>
      readModule(
        new URL("../src/custom/" + n + ".js", import.meta.url),
        "utf8",
      ),
    ),
  ).then((parts) => parts.join("\n")),
  c,
);
const api = c.JobsProfileAnswers,
  profile = {
    addressData: { country: "United States" },
    employmentData: { eligibilityUS: true, sponsorship: true },
  };

test("one country catalog retains aliases and covers additional known countries", () => {
  for (const [label, code] of [
    ["United States", "US"],
    ["U.S.", "US"],
    ["U.S.A.", "US"],
    ["USA", "US"],
    ["US", "US"],
    ["Canada", "CA"],
    ["CA", "CA"],
    ["United Kingdom", "UK"],
    ["Great Britain", "UK"],
    ["UK", "UK"],
    ["France", "FR"],
    ["Germany", "DE"],
    ["Australia", "AU"],
    ["India", "IN"],
    ["IN", "IN"],
    ["Mexico", "MX"],
    ["MX", "MX"],
  ])
    assert.equal(api.country(label), code, label);
  assert.equal(api.country("Will you require us to sponsor you?"), null);
  assert.equal(api.country("in order to work"), null);
  assert.equal(api.country("the United States and Canada"), "MIXED");
  assert.equal(api.country("US or Mexico"), "MIXED");
});

test("known and unrecognized named countries never inherit US home facts", () => {
  for (const [place, expected] of [
    ["India", "IN"],
    ["Mexico", "MX"],
    ["Chile", "UNKNOWN"],
  ]) {
    for (const question of [
      `Are you authorized to work in ${place}?`,
      `Are you eligible to work within ${place}?`,
      `Do you require sponsorship to work in ${place}?`,
      `Do you require sponsorship in ${place}?`,
      `Do you require sponsorship for ${place}?`,
    ]) {
      assert.equal(
        api.requestedCountry(question, {}, "US"),
        expected,
        question,
      );
      assert.equal(
        api.resolve(question, profile)?.answer ?? null,
        null,
        question,
      );
    }
    assert.equal(
      api.scope([{ question: `Are you authorized to work in ${place}?` }]),
      expected,
    );
  }
});

test("mixed or partly unknown jurisdictions remain conservative across individual questions and batch scope", () => {
  for (const question of [
    "Are you authorized to work in India or Mexico?",
    "Are you authorized to work in US and Canada?",
  ])
    assert.equal(api.requestedCountry(question, {}, "US"), "MIXED");
  assert.equal(
    api.requestedCountry(
      "Are you authorized to work in the United States and Chile?",
      {},
      "US",
    ),
    "UNKNOWN",
  );
  assert.equal(
    api.scope([
      { question: "Are you authorized to work in the United States?" },
      { question: "Are you authorized to work in Chile?" },
    ]),
    "MIXED",
  );
  assert.equal(
    api.scope([
      { question: "Are you authorized to work in India?" },
      { question: "Are you authorized to work in Mexico?" },
    ]),
    "MIXED",
  );
  assert.equal(
    api.scope([{ question: "Are you authorized to work?" }]),
    null,
    "batch scope never inserts a home country",
  );
  assert.equal(
    api.requestedCountry(
      "Do you require sponsorship?",
      { country: "UNKNOWN" },
      "US",
    ),
    "UNKNOWN",
  );
});

test("timing and generic job wording are not mistaken for named countries", () => {
  for (const question of [
    "Will you require sponsorship in the future?",
    "Do you require sponsorship for this role?",
    "Will you need sponsorship now or in the future?",
  ])
    assert.equal(api.requestedCountry(question, {}, "US"), "US", question);
  assert.equal(
    api.requestedCountry(
      "Will you require sponsorship in India now or in the future?",
      {},
      "US",
    ),
    "IN",
  );
  assert.equal(
    api.requestedCountry(
      "I require sponsorship in the future to legally work in the country where the job is located.",
      {},
      "US",
    ),
    "US",
  );
  assert.equal(
    api.requestedCountry(
      "Are you legally authorized to work in the U.S.?",
      {},
      "CA",
    ),
    "US",
  );
});

test("employer suffixes do not become part of a country name or erase unknown and mixed countries", () => {
  for (const suffix of ["for any employer", "for any company"]) {
    const known = `Are you legally authorized to work in the United States ${suffix}?`;
    assert.equal(api.requestedCountry(known, {}, "CA"), "US");
    assert.equal(api.resolve(known, profile)?.answer, "Yes");
    for (const [place, expected] of [
      ["Canada", "CA"],
      ["Chile", "UNKNOWN"],
      ["the United States and Canada", "MIXED"],
      ["the United States and Chile", "UNKNOWN"],
    ]) {
      const question = `Are you legally authorized to work in ${place} ${suffix}?`;
      assert.equal(
        api.requestedCountry(question, {}, "US"),
        expected,
        question,
      );
      assert.equal(
        api.resolve(question, profile)?.answer ?? null,
        null,
        question,
      );
    }
  }
});

test("what sponsorship is for and parenthetical visa examples are not places", () => {
  for (const question of [
    "Will you now or in the future require sponsorship for work authorization (e.g., H-1B, TN)?",
    "Do you require sponsorship for an employment visa?",
    "Will you require sponsorship for an H-1B visa status?",
  ])
    assert.equal(api.requestedCountry(question, {}, "US"), "US", question);
  assert.equal(
    api.requestedCountry(
      "Do you require sponsorship for an employment visa (e.g., H-1B) to work in India?",
      {},
      "US",
    ),
    "IN",
  );
  assert.equal(
    api.requestedCountry(
      "Do you require sponsorship for work authorization in Chile?",
      {},
      "US",
    ),
    "UNKNOWN",
  );
  assert.equal(
    api.resolve(
      "Will you now or in the future require sponsorship for work authorization (e.g., H-1B, TN)?",
      profile,
    )?.answer,
    "Yes",
  );
});
