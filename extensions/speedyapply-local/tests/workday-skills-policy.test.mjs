import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
import { mountReviewPanel } from "./helpers/review-panel.mjs";

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

for (const [name, marker, host] of [
  ["optional skills skipped", "", "fixture.myworkdayjobs.com"],
  ["native required skills filled", "required", "fixture.myworkdayjobs.com"],
  [
    "aria required skills filled",
    'aria-required="true"',
    "fixture.myworkdayjobs.com",
  ],
  ["label-only required skills filled", "star", "fixture.myworkdayjobs.com"],
  ["other sites unaffected", "", "example.test"],
]) {
  test(`skills requiredness: ${name}`, async (t) => {
    const w = new JSDOM(
      `<form>
      <div data-automation-id="formField-skills"><label>Skills${marker === "star" ? "*" : ""}<textarea id="skills" ${marker === "star" ? "" : marker}></textarea></label></div>
      <div data-automation-id="formField-skillsPrompt"><label>Skills${marker === "star" ? "*" : ""}<textarea id="fallback" ${marker === "star" ? "" : marker}></textarea></label></div>
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
            throw Error("Retired setting must never be read");
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
    const fillSkills = !!marker || host === "example.test";
    assert.equal(skills.value, fillSkills ? "Python" : "");
    assert.equal(
      fallback.value,
      fillSkills ? "Python" : "",
      "general rules use the same requiredness as bindings",
    );
    assert.equal(
      root.querySelector("#name").value,
      "Ada",
      "other fields still fill",
    );
    if (!fillSkills)
      assert.deepEqual(events, [], "optional skills have no page interaction");
    assert.equal(
      requests.filter((m) => m.type === "jobs:auto-answers").length,
      0,
    );
    assert.equal(
      result,
      true,
      "filled required skills no longer block completion",
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

for (const scenario of ["filled", "no-profile-skills", "no-matching-options"]) {
  test(`required Workday skill prompt: ${scenario}`, async (t) => {
    const w = new JSDOM(
      `<form><div data-automation-id="formField-skillsPrompt">
        <label for="skills">Type to Add Skills*</label>
        <div data-automation-id="multiSelectContainer">
          <input id="skills" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="prompt">
          <ul data-automation-id="selectedItemList"></ul>
        </div></div></form>`,
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ).window;
    t.after(() => w.close());
    const profile = {
      skillsData: scenario === "no-profile-skills" ? [] : ["Python"],
    };
    const requests = [],
      searches = [];
    w.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "jobs:tab-profile")
            return { data: { id: "fixture", profile } };
          requests.push(message);
          return {
            data: {
              answers: (message.fields || []).map((field) => ({
                fieldId: field.fieldId,
                kind: "unknown",
                value: null,
                source: "unknown",
                questionZh: "请添加技能",
                reasonZh: "未找到可以确认的技能，请补充。",
              })),
            },
          };
        },
      },
    };
    w.JobsDiagnostics = { note() {}, trace() {} };
    scripts.forEach((script) => w.eval(script));
    w.eval(adapter);
    mountReviewPanel(w);
    const until = w.JobsDOMWait.until;
    w.JobsDOMWait.until = (read, options = {}) =>
      until(read, { ...options, timeout: 120 });
    const doc = w.document,
      input = doc.querySelector("input");
    let host;
    const menu = (label, searched) => {
      const group = doc.createElement("div");
      group.setAttribute("data-uxi-multiselectlist-issearch", String(searched));
      group.innerHTML =
        '<div data-automation-id="activeListContainer"><div role="presentation"><div role="option"><input type="checkbox"><span data-automation-id="promptOption"></span></div></div></div>';
      group.querySelector("span").textContent = label;
      group.querySelector("input").onclick = () => {
        const li = doc.createElement("li");
        li.setAttribute("data-automation-id", "menuItem");
        li.innerHTML =
          '<div data-automation-id="selectedItem"><p data-automation-id="promptOption"></p></div>';
        li.querySelector("p").textContent = label;
        doc.querySelector("ul").append(li);
        input.value = "";
        host.remove();
      };
      return group;
    };
    input.onclick = () => {
      if (host?.isConnected) return;
      host = doc.createElement("div");
      host.setAttribute("data-associated-widget", "prompt");
      host.append(menu("Unrelated option", false));
      doc.body.append(host);
    };
    input.onkeydown = (event) => {
      if (event.key === "Escape") host?.remove();
      if (event.key !== "Enter") return;
      searches.push(input.value);
      host.replaceChildren(
        menu(scenario === "filled" ? "Python" : "Unrelated option", true),
      );
    };
    const root = doc.querySelector("form");
    const row = w.JobsControlFields.create(doc)
      .scan()
      .find((row) => row.node === input);
    assert.equal(
      row.public.required,
      true,
      "same label-only requiredness seen in the real diagnostic",
    );
    assert.equal(row.public.type, "search-choice");
    const result = await w.JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      autoConfirm: false,
      fill: () => w.workdayFillSkills(profile.skillsData),
    });
    const reader = w.JobsControlFields.create(doc);
    const field = reader.scan().find((row) => row.node === input).public;
    if (scenario === "filled") {
      assert.equal(result, true);
      assert.deepEqual(searches, ["Python"]);
      assert.equal(
        field.filled,
        true,
        "a retained selected chip, not search text, completes the field",
      );
      assert.equal(doc.querySelector("ul").textContent, "Python");
      assert.equal(
        requests.filter((m) => m.type === "jobs:auto-answers").length,
        0,
      );
    } else {
      assert.equal(result, false);
      assert.equal(field.filled, false);
      const batches = requests.filter((m) => m.type === "jobs:auto-answers");
      assert.equal(
        batches.length,
        1,
        "failed/missing profile binding reaches supplemental answering",
      );
      assert.equal(batches[0].fields[0].required, true);
      const card = doc.querySelector("#jobs-ai-review").shadowRoot;
      assert.match(card.textContent, /未找到可以确认的技能/);
      assert.match(
        card.textContent,
        /确认这些答案/,
        "unresolved required skills stay visible for review",
      );
    }
  });
}
