import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const c = vm.createContext({});
vm.runInContext(
  (await Promise.all(
    ["option-match", "profile-answers"].map((n) =>
      readModule(
        new URL("../src/custom/" + n + ".js", import.meta.url),
        "utf8",
      ),
    ),
  ).then((parts) => parts.join("\n"))) +
    "\n" +
    (await readModule(
      new URL("../src/custom/answer-resolver.js", import.meta.url),
      "utf8",
    )),
  c,
);
const old = {
  addressData: { country: "United States" },
  employmentData: { eligibilityUS: true, sponsorship: true },
};
const versions = [
  ["legacy", old],
  [
    "timed",
    {
      ...old,
      applicationData: { sponsorshipNow: false, sponsorshipFuture: true },
    },
  ],
];
const resolve = (question, options, profile) =>
  c.JobsAnswerResolver.decide({ question, options }, profile, { options }, []);

for (const [version, profile] of versions) {
  for (const question of [
    "Are you legally authorized to work in the United States?",
    "Are you eligible to work in the United States?",
  ]) {
    test(`${version}: ${question} refuses extra claims and opposite polarity in option text`, () => {
      for (const label of [
        "Yes, I am a US citizen",
        "Yes, I am a permanent resident",
        "Yes, I am authorized to work without restrictions",
        "Yes, I am authorized to work in Canada",
        "Yes, I am legally authorized to work in the United States and can relocate",
        "Yes, I am not legally authorized to work in the United States",
        "Yes, I will require sponsorship.",
      ]) {
        assert.equal(
          resolve(question, [label, "No"], profile).answer,
          null,
          label,
        );
      }
      const legal =
        "Yes, I am currently legally authorized to work in the United States.";
      assert.equal(resolve(question, [legal, "No"], profile).answer, legal);
    });
  }
  test(`${version}: sponsorship options cannot add citizenship, clearance, relocation or negative assertions`, () => {
    for (const label of [
      "Yes, and I hold a security clearance",
      "Yes, I require sponsorship and hold a security clearance",
      "Yes, I require sponsorship now and I am a US citizen",
      "Yes, I require sponsorship and can relocate",
      "Yes, I do not require sponsorship",
      "Yes, I need sponsorship to legally work in Canada",
    ]) {
      assert.equal(
        resolve("Do you require sponsorship?", [label, "No"], profile).answer,
        null,
        label,
      );
    }
    const valid = "Yes, I will require sponsorship.";
    assert.equal(
      resolve("Do you require sponsorship?", [valid, "No"], profile).answer,
      valid,
    );
  });
}

test("timed sponsorship options still distinguish now, future and combined negative facts", () => {
  const question = "Will you require sponsorship now or in the future?";
  const now =
    "Yes, I will require immigration sponsorship now to legally work in the country where the job is located.";
  const future =
    "Yes, I will require immigration sponsorship in the future to legally work in the country where the job is located.";
  const no =
    "No, I do not and will not require immigration sponsorship now or in the future.";
  for (const [sponsorshipNow, sponsorshipFuture, expected] of [
    [true, false, now],
    [false, true, future],
    [false, false, no],
  ]) {
    const profile = {
      ...old,
      applicationData: { sponsorshipNow, sponsorshipFuture },
    };
    assert.equal(
      resolve(question, [now, future, no], profile).answer,
      expected,
    );
  }
  assert.equal(
    resolve("Do you require sponsorship?", [now, future, "No"], old).answer,
    null,
    "coarse legacy data cannot choose a new timing distinction",
  );
  assert.equal(
    resolve("Do you currently require sponsorship?", [now, "No"], old).answer,
    null,
    "untimed legacy facts cannot answer a now-only question",
  );
});
