import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/profile-answer-expectations.json", import.meta.url),
    "utf8",
  ),
);
const context = vm.createContext({});
for (const name of ["answer-policy", "option-match", "profile-answers"])
  vm.runInContext(
    await readModule(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
    context,
  );
const api = context.JobsProfileAnswers;

test("the explicit synthetic matrix retains every reviewed resolution and selection", () => {
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.cases.length, 1074);
  assert.equal(
    fixture.cases.reduce((n, row) => n + row.selections.length, 0),
    4848,
  );
  assert.equal(
    fixture.cases.filter((row) => row.correction === "confirmed_middle_name")
      .length,
    54,
  );
  assert.equal(
    fixture.cases.filter(
      (row) => row.correction === "separate_sponsorship_scope_missing",
    ).length,
    36,
  );
});

for (const [name, profile] of Object.entries(fixture.profiles))
  test(`explicit Profile answers and option choices: ${name}`, (t) => {
    let resolutions = 0,
      selections = 0;
    for (const row of fixture.cases.filter((row) => row.profile === name)) {
      const answer = api.resolve(row.question, profile, fixture.context);
      assert.equal(
        answer?.answer ?? null,
        row.answer,
        `${name}: ${row.question}`,
      );
      resolutions++;
      for (const choice of row.selections) {
        const options = fixture.options[choice.options] ?? undefined;
        assert.equal(
          api.select(answer, options),
          choice.answer,
          `${name}: ${row.question} / ${JSON.stringify(options)}`,
        );
        selections++;
      }
    }
    t.diagnostic(
      `${resolutions} explicit answers and ${selections} option constraints`,
    );
  });

test("authorization accepts truthful long options for both confirmed polarities", () => {
  const question = "Are you legally authorized to work in the United States?";
  const options = [
    "Yes, I am currently legally authorized to work in the United States.",
    "No, I am not legally authorized to work in the United States.",
  ];
  for (const [value, index] of [
    [true, 0],
    [false, 1],
  ]) {
    const profile = {
      ...fixture.profiles.newgrad,
      employmentData: {
        ...fixture.profiles.newgrad.employmentData,
        eligibilityUS: value,
      },
    };
    assert.equal(
      api.select(api.resolve(question, profile), options),
      options[index],
    );
  }
});
