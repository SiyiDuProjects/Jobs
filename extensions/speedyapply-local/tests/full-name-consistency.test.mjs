import { typedAnswer } from "./helpers/typed-answer.mjs";
// Tests below exercise retained answer functions with explicit fixture types.
// Free-form classification is tested at the service decision boundary.
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

test("typed answers: old labels, expanded prompts and typed signature all use the same confirmed full name", () => {
  for (const middleName of ["Middle", "", undefined]) {
    const profile = {
      nameData: { firstName: "Example", middleName, lastName: "Applicant" },
    };
    const expected = ["Example", middleName, "Applicant"]
      .filter(Boolean)
      .join(" ");
    for (const question of [
      "Legal name",
      "Full name",
      "Your full name",
      "What is your full name?",
      "Please provide your full name",
      "Please enter your full legal name",
      "Signature",
      "Electronic signature",
    ]) {
      const decision = typedAnswer(c.JobsProfileAnswers, question, profile, {
        inputType: "text",
      });
      assert.equal(decision.answer, expected, question);
      assert.equal(decision.field, "nameData.fullName");
    }
  }
});
