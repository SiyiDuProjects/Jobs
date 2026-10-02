import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const c = vm.createContext({});
vm.runInContext(
  await readModule(
    new URL("../src/custom/management-model.js", import.meta.url),
    "utf8",
  ),
  c,
);
const m = c.JobsManagementModel;
const profiles = [
  { id: "ng", profileName: "Newgrad" },
  { id: "intern", profileName: "Intern" },
];
const responseKey = "jobsResponses:00000000-0000-4000-8000-000000000001";
const row = (key) => ({
  key,
  question: "Question " + key,
  response: "Answer " + key,
  keywords: [key],
  appearances: 1,
});
test("job-kind mappings use explicit choices or unique profile names and never classify application records", () => {
  assert.deepEqual(
    { ...m.mappings(profiles) },
    { intern: "intern", newgrad: "ng" },
  );
  assert.deepEqual(
    { ...m.mappings(profiles, { intern: "ng", newgrad: "missing" }) },
    { intern: "ng", newgrad: "ng" },
  );
  assert.equal(
    m.mappings([...profiles, { id: "second", profileName: "Intern" }]).intern,
    undefined,
  );
  assert.equal(m.classify, undefined);
});
test("three way merge keeps independent additions, modifications and deletions", () => {
  const a = row("A"),
    b = row("B"),
    d = row("D");
  const result = m.merge(
    responseKey,
    [a, b],
    [{ ...a, response: "Updated answer" }],
    [a, b, d],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].response, "Updated answer");
  assert.equal(result[1].key, "D");
});
test("conflicting edits and deletion of remotely modified responses stop without overwriting", () => {
  const a = { key: "a", response: "before" };
  assert.throws(
    () =>
      m.merge(
        responseKey,
        [a],
        [{ ...a, response: "local" }],
        [{ ...a, response: "remote" }],
      ),
    /两处修改/,
  );
  assert.throws(
    () => m.merge(responseKey, [a], [], [{ ...a, response: "remote" }]),
    /两处修改/,
  );
});
test("no credentials or global response list accepted; canonical object order is equal", () => {
  for (const k of [
    "profile",
    "autofillAccount",
    "jobsSyncV1",
    "responseList",
    "subscription",
    "appliedList",
    "dailyGoal",
    "jobsResponses:id",
  ]) {
    assert.equal(m.allowed(k), false);
    assert.throws(
      () => m.merge(k, undefined, [], []),
      "unsupported keys cannot bypass validation even when both sides match",
    );
  }
  assert(m.same({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
  const remote = { autofillSettings: { autoSubmit: false } };
  assert.equal(
    m.merge(
      "settings",
      undefined,
      { autofillSettings: { autoSubmit: true } },
      remote,
    ),
    remote,
  );
});
