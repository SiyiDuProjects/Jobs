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
const answer = (veteran, options) =>
  c.JobsAnswerResolver.decide(
    { question: "Veteran status", options },
    { employmentData: { veteran } },
    { options },
    [],
  );

test("full veteran status questions use existing facts without inferring protected status", () => {
  const question =
    "Please select the veteran status which most accurately describes your status.";
  const options = ["I am a veteran", "I am not a veteran", "Prefer not to say"];
  const decide = (veteran, labels = options, q = question) =>
    c.JobsAnswerResolver.decide(
      { question: q, options: labels },
      { employmentData: { veteran } },
      { options: labels },
      [],
    );
  assert.equal(decide(false).answer, options[1]);
  assert.equal(decide(true).answer, options[0]);
  assert.equal(decide(undefined).answer, null);
  assert.equal(
    decide(true, ["I am a protected veteran", "I am not a protected veteran"])
      .answer,
    null,
  );
  assert.equal(
    decide(false, options, "Please select the veteran status of your spouse.")
      .answer,
    null,
  );
});

test("ordinary veteran facts select explicit positive and negative ATS options including sentence punctuation", () => {
  for (const yes of ["I am a veteran", "I identify as a veteran"])
    for (const no of ["I am not a veteran", "I do not identify as a veteran"])
      for (const period of ["", "."]) {
        const labels = [yes + period, no + period, "Prefer not to say"];
        assert.equal(answer(true, labels).answer, yes + period);
        assert.equal(answer(false, labels).answer, no + period);
        assert.equal(answer("undisclosed", labels).answer, "Prefer not to say");
      }
});

test("ordinary veteran aliases never establish protected veteran status from singular or plural option text", () => {
  for (const protectedLabel of [
    "I identify as a protected veteran",
    "I identify as one or more of the classifications of protected veterans listed above",
  ]) {
    const result = answer(true, [
      "I am a veteran",
      protectedLabel,
      "I am not a protected veteran",
      "Prefer not to say",
    ]);
    assert.equal(result.answer, null);
    assert.equal(result.reason, "protected_veteran_status_unconfirmed");
    assert.equal(
      answer(false, [
        protectedLabel,
        "I am not a protected veteran",
        "Prefer not to say",
      ]).answer,
      "I am not a protected veteran",
    );
  }
  assert.equal(
    answer(true, [
      "I am a veteran",
      "I identify as one or more classifications of protected veterans",
      "Prefer not to say",
    ]).answer,
    null,
  );
});
