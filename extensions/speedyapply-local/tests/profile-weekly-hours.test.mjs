import test from "node:test";
import assert from "node:assert/strict";
import { readModule } from "./helpers/module-source.mjs";
import vm from "node:vm";
const sandbox = vm.createContext({});
vm.runInContext(
  (
    await Promise.all(
      ["option-match", "profile-answers"].map((n) =>
        readModule(
          new URL("../src/custom/" + n + ".js", import.meta.url),
          "utf8",
        ),
      ),
    )
  ).join("\n"),
  sandbox,
);
const api = sandbox.JobsProfileAnswers;
const profile = (weeklyHours = "30") => ({ applicationData: { weeklyHours } });
const answer = (question, p = profile()) =>
  api.resolve(question, p)?.answer ?? null;

test("weekly availability reads the selected profile and missing facts retain fallback", () => {
  for (const q of [
    "How many hours per week are you available to work?",
    "How many hours are you able to work each week?",
    "How many hours a week can you commit?",
    "Hours per week",
    "Weekly availability (hours)",
    "每周可工作时长",
  ]) {
    assert.equal(answer(q), "30", q);
    assert.equal(answer(q, profile("20")), "20", q);
    for (const p of [{}, profile(""), profile("0"), profile(40)])
      assert.equal(answer(q, p), null, q);
  }
  assert.equal(
    answer("Are you available to work at least 20 hours per week?"),
    "Yes",
  );
  assert.equal(answer("Can you commit to 40 hours per week?"), "No");
  assert.equal(answer("Can you work 30 hours a week?"), "Yes");
});

test("weekly capacity never supplies dates, duration, legal limits, past hours or calendar promises", () => {
  for (const q of [
    "Are you available to work 30 hours per week from May to August?",
    "Can you work 30 hours per week onsite in Boston?",
    "Are you legally allowed to work 40 hours per week?",
    "How many hours per week did you work at your previous employer?",
    "How many months are you available for an internship?",
    "Are you available full-time?",
    "Are you unavailable to work 20 hours per week?",
  ])
    assert.equal(answer(q), null, q);
});

test("weekly options preserve units and reject overlapping ranges or added commitments", () => {
  const r = api.resolve("Hours per week", profile());
  assert.equal(
    api.select(r, [
      "20 hours per week",
      "30 hours per week",
      "40 hours per week",
    ]),
    "30 hours per week",
  );
  assert.equal(
    api.select(r, ["10–20 hours/week", "21–30 hours/week", "31–40 hours/week"]),
    "21–30 hours/week",
  );
  assert.equal(api.select(r, ["20–30", "30–40"]), null);
  assert.equal(
    api.select(r, ["30 hours/month", "30 hours/week during May-August"]),
    null,
  );
  const yes = api.resolve("Can you work 20 hours per week?", profile());
  assert.equal(api.select(yes, ["Yes", "No"]), "Yes");
  assert.equal(api.select(yes, ["Yes, including weekends", "No"]), null);
  assert.equal(
    api.covers(
      { question: "Hours per week", response: "30 hours per week" },
      profile(),
    ),
    true,
  );
  assert.equal(
    api.covers(
      { question: "Hours per week", response: "30 hours during the summer" },
      profile(),
    ),
    false,
  );
});
