import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
import { popupPage, until } from "./helpers/popup-page.mjs";
import {
  readAutofillPreferences,
  saveWorkdaySkillsPreference,
  workdaySkillsPreferenceKey,
} from "../src/custom/autofill-preferences.js";

const scripts = await Promise.all(
  [
    "dom-wait",
    "control-fields",
    "workday-controls",
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const adapter = await readWithDependencies(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);

for (const [name, enabled, required, host] of [
  ["old installs default off", undefined, false, "fixture.myworkdayjobs.com"],
  ["explicitly disabled", false, false, "fixture.myworkdayjobs.com"],
  ["required skills stay manual", false, true, "fixture.myworkdayjobs.com"],
  ["explicitly enabled", true, false, "fixture.myworkdayjobs.com"],
  ["other sites unaffected", false, false, "example.test"],
]) {
  test(`skills preference: ${name}`, async (t) => {
    const w = new JSDOM(
      `<form>
      <div data-automation-id="formField-skills"><label>Skills<textarea id="skills" ${required ? "required" : ""}></textarea></label></div>
      <div data-automation-id="formField-skillsPrompt"><label>Skills<textarea id="fallback"></textarea></label></div>
      <label>First name<input id="name" required></label>
    </form>`,
      { url: `https://${host}/apply`, runScripts: "outside-only" },
    ).window;
    t.after(() => w.close());
    const profile = { nameData: { firstName: "Ada" }, skillsData: ["Python"] };
    const requests = [],
      events = [];
    w.chrome = {
      storage: {
        local: {
          get: async () => {
            throw Error("Content storage is restricted");
          },
        },
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "jobs:tab-profile")
            return { data: { id: "fixture", profile } };
          if (message.type === "jobs:autofill-preferences")
            return { data: { workdaySkills: enabled === true } };
          requests.push(message);
          return {};
        },
      },
    };
    w.JobsDiagnostics = { note() {}, trace() {} };
    scripts.forEach((script) => w.eval(script));
    installAnswerResolver(w, [
      {
        question: "Skills",
        response: "Python",
        keywords: ["skills"],
        appearances: 1,
      },
    ]);
    const root = w.document.querySelector("form");
    const skills = root.querySelector("#skills"),
      fallback = root.querySelector("#fallback");
    for (const event of ["click", "input", "keydown", "change"])
      for (const node of [skills, fallback])
        node.addEventListener(event, () => events.push(event));
    const result = await w.JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      fill: () =>
        w.JobsFormPipeline.bind([
          { name: "skills", find: () => skills, answer: "Python" },
        ]),
    });
    const fillSkills = enabled === true || host === "example.test";
    assert.equal(skills.value, fillSkills ? "Python" : "");
    assert.equal(
      fallback.value,
      fillSkills ? "Python" : "",
      "general rules and saved answers respect the preference too",
    );
    assert.equal(
      root.querySelector("#name").value,
      "Ada",
      "other fields still fill",
    );
    if (!fillSkills)
      assert.deepEqual(events, [], "disabled skills have no page interaction");
    assert.equal(
      requests.filter((m) => m.type === "jobs:auto-answers").length,
      0,
    );
    assert.equal(
      result,
      !required,
      "required empty skills still block completion",
    );
  });
}

test("Workday's actual skill binding skips search and preserves selected chips", async (t) => {
  const w = new JSDOM(
    '<form><div data-automation-id="formField-skillsPrompt"><label>Skills</label><div data-automation-id="multiSelectContainer"><input data-uxi-widget-type="selectinput"><ul data-automation-id="selectedItemList"><li data-automation-id="menuItem"><div data-automation-id="selectedItem"><p data-automation-id="promptOption">Manual skill</p></div></li></ul></div></div></form>',
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  const profile = { skillsData: ["Python", "Java"] };
  w.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { id: "fixture", profile } }),
    },
  };
  w.JobsDiagnostics = { note() {}, trace() {} };
  scripts.forEach((script) => w.eval(script));
  w.eval(adapter);
  installAnswerResolver(w, []);
  let clicks = 0;
  w.document.querySelector("input").onclick = () => clicks++;
  await w.JobsAutomatic.advance({
    root: w.document.querySelector("form"),
    profile,
    action: "fill",
    fill: () => w.workdayFillSkills(profile.skillsData),
  });
  assert.equal(clicks, 0);
  assert.equal(w.document.querySelector("input").value, "");
  assert.equal(w.document.querySelector("ul").textContent, "Manual skill");
});

test("local preference defaults off, persists both ways and leaves all other data intact", async () => {
  const values = {
    settings: { autofillSettings: { autoClickNextPage: true } },
    untouched: "kept",
  };
  const storage = {
    get: async () => values,
    set: async (update) => Object.assign(values, update),
  };
  assert.equal((await readAutofillPreferences(storage)).workdaySkills, false);
  await saveWorkdaySkillsPreference(true, storage);
  assert.equal((await readAutofillPreferences(storage)).workdaySkills, true);
  await saveWorkdaySkillsPreference(false, storage);
  assert.equal((await readAutofillPreferences(storage)).workdaySkills, false);
  assert.equal(values.settings.autofillSettings.autoClickNextPage, true);
  assert.equal(values.untouched, "kept");
});

test("popup switch persists, reopens and reports save failure without changing its state", async () => {
  const values = {};
  let fail = false;
  const local = {
    get: async () => values,
    set: async (update) => {
      if (fail) throw Error("Storage unavailable");
      Object.assign(values, update);
    },
  };
  const open = () => popupPage(async () => ({}), local);
  let h = open();
  try {
    const control = () => h.w.document.querySelector('[role="switch"]');
    await until(() => control() && !control().disabled);
    assert.equal(control().checked, false);
    control().click();
    await until(
      () => values[workdaySkillsPreferenceKey] === true && !control().disabled,
    );
    h.close();
    h = open();
    await until(() => control()?.checked && !control().disabled);
    fail = true;
    control().click();
    await until(() => h.w.document.body.textContent.includes("保存失败"));
    assert.equal(control().checked, true);
    assert.equal(values[workdaySkillsPreferenceKey], true);
    fail = false;
    control().click();
    await until(() => values[workdaySkillsPreferenceKey] === false);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});

test("worker exposes only the behavior preference to this extension's application tabs", async (t) => {
  const w = new JSDOM("", { runScripts: "outside-only" }).window;
  t.after(() => w.close());
  const reads = [];
  w.chrome = {
    runtime: {
      id: "fixture",
      onMessage: { addListener() {} },
      onConnect: { addListener() {} },
    },
    storage: {
      local: {
        get: async (key) => {
          reads.push(key);
          return { [workdaySkillsPreferenceKey]: true };
        },
      },
    },
  };
  for (const name of [
    "src/custom/autofill-preferences.js",
    "source/background-api.js",
  ])
    w.eval(
      await readWithDependencies(
        new URL("../" + name, import.meta.url),
        "utf8",
      ),
    );
  const message = { type: "jobs:autofill-preferences" };
  const sender = {
    id: "fixture",
    tab: { id: 1 },
    url: "https://fixture.myworkdayjobs.com/apply",
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await w.handle(message, sender))),
    { workdaySkills: true },
  );
  await assert.rejects(
    w.handle(message, { ...sender, id: "untrusted" }),
    /Application tab required/,
  );
  assert.deepEqual(reads, [workdaySkillsPreferenceKey]);
});
