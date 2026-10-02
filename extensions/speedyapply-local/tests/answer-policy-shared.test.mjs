import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";

const fixture = JSON.parse(
  await fs.readFile(
    new URL(
      "../../../services/jobs-radar/deploy/fixtures/answer-policy-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const sandbox = vm.createContext({});
for (const name of ["answer-policy", "option-match", "profile-answers"])
  vm.runInContext(
    await readModule(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
    sandbox,
  );

for (const scenario of fixture.cases)
  test(`shared AI/rule policy: ${scenario.id}`, () => {
    const profile = {
      ...structuredClone(fixture.profile),
      ...scenario.profilePatch,
    };
    const result = sandbox.JobsProfileAnswers.resolve(
      scenario.question,
      profile,
      {
        type: scenario.type,
        inputType: scenario.type,
        required: true,
        options: scenario.options || [],
        country: "US",
        now: "2026-09",
      },
    );
    assert.equal(result?.answer ?? null, scenario.rule);
  });
