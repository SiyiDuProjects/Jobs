import { readModule } from "./helpers/module-source.mjs";
import { runAnswerStage } from "./helpers/answer-stage.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
// Load the same committed-value capability that the production manifest loads.
// A bare unknown combobox has no evidence that its text is a selected answer.
const captureCode = (
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "ashby-controls",
      "control-fields",
      "answer-memory",
    ].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
const writer = await readModule(
  new URL("../source/saved-responses.js", import.meta.url),
  "utf8",
);
const responseKey = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const matcher = await readModule(
  new URL("../src/custom/answer-resolver.js", import.meta.url),
  "utf8",
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const storeCode = await readWithDependencies(
  new URL("../src/custom/document-store.js", import.meta.url),
  "utf8",
);
const responseContract = await readWithDependencies(
  new URL("../src/custom/response-contract.js", import.meta.url),
  "utf8",
);
const question = "Are you willing to work in this office?";
function setup(data, company = "example", kind = "radio") {
  const dom = new JSDOM("<!doctype html>", {
    url: `https://jobs.ashbyhq.com/${company}/role/application`,
    runScripts: "outside-only",
  });
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.JobsControlConfig = { observe: true };
  w.readSaved = async () => structuredClone(data[responseKey] ?? []);
  // Test the unchanged original keyword writer/matcher; scope routing has its
  // own tests with the real response-scope module.
  w.JobsResponseScope = {
    scopeFor: async () => "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    storageKey: async () => responseKey,
    read: () => w.readSaved(),
  };
  w.chrome = {
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {
          throw Error("Personal answers cannot persist locally");
        },
      },
      session: {
        getKeys: async () => Object.keys(data),
        async get() {
          return structuredClone(data);
        },
        async set(update) {
          await pause();
          Object.assign(data, structuredClone(update));
        },
      },
    },
  };
  w.eval(responseContract + "\n" + storeCode);
  w.eval(writer + "\nwindow.saveOriginal=entries=>saveResponses(entries,{});");
  w.eval(
    matcher +
      "\nwindow.matchOriginal = async question => JobsAnswerResolver.matchSaved({question}, await window.readSaved());",
  );
  w.document.body.innerHTML =
    `<fieldset class="ashby-application-form-input-radio-group ashby-application-form-field-entry"><label class="ashby-application-form-question-title">${question}</label>` +
    (kind === "radio"
      ? '<span><input type="radio" id="yes" name="q"></span><label for="yes">Yes, willing</label><span><input type="radio" id="no" name="q"></span><label for="no">No, unwilling</label>'
      : '<div class="ashby-application-form-input-yesno"><button data-option="yes" aria-pressed="false">Yes</button><button data-option="no" aria-pressed="false">No</button></div>') +
    "</fieldset>";
  const handlers = {};
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, listener, ...args) => {
    if (
      [
        "click",
        "keyup",
        "input",
        "change",
        "focusout",
        "pointerdown",
        "keydown",
        "compositionend",
      ].includes(type)
    )
      handlers[type] = listener;
    return add(type, listener, ...args);
  };
  w.eval(captureCode);
  let pending = Promise.resolve();
  const save = (records) => (pending = w.saveOriginal(records));
  return {
    dom,
    w,
    doc: w.document,
    memory: w.JobsAnswerMemory,
    handlers,
    save,
    async settle() {
      await pause();
      await pending;
    },
  };
}
test("radio selection enters original responseList and matches across company pages", async () => {
  const data = {};
  const a = setup(data);
  a.memory.start(a.doc, true, a.save);
  const input = a.doc.getElementById("yes");
  input.checked = true;
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: input,
  });
  a.handlers.click({ type: "click", isTrusted: true, target: input });
  await a.settle();
  assert.equal(data[responseKey].length, 1);
  assert.equal(data[responseKey][0].question, question);
  assert.equal(data[responseKey][0].response, "Yes, willing");
  assert.equal(
    data[responseKey][0].appearances,
    data[responseKey][0].keywords.length,
  );
  assert.equal(data[responseKey][0].fromAutofill, true);
  const b = setup(data, "another-company");
  assert.equal(await b.w.matchOriginal(question), "Yes, willing");
  assert.deepEqual(Object.keys(data), [responseKey]);
  a.dom.window.close();
  b.dom.window.close();
});
test("manual personal why answers remain reusable across jobs while employer motivation stays scoped", async () => {
  const data = {},
    a = setup(data, "company-a"),
    b = setup(data, "company-b");
  try {
    a.doc.body.innerHTML =
      "<label>Why did you leave your previous job?<textarea></textarea></label><label>Why did you choose Physics?<textarea></textarea></label><label>Why do you want to work here?<textarea></textarea></label>";
    a.memory.start(a.doc, true, a.save);
    const values = [
      "My fixed-term internship ended.",
      "I enjoy understanding physical systems.",
      "Company A builds the instruments I want to work on.",
    ];
    const nodes = [...a.doc.querySelectorAll("textarea")];
    for (const [index, node] of nodes.entries()) {
      node.value = values[index];
      a.handlers.input({ type: "input", isTrusted: true, target: node });
    }
    a.memory.flush();
    await a.settle();
    assert.equal(data[responseKey].length, 3);
    for (let index = 0; index < 2; index++) {
      const question = nodes[index].closest("label").textContent;
      assert.equal(
        data[responseKey].find((row) => row.question === question).jobKey,
        undefined,
      );
      assert.equal(await b.w.matchOriginal(question), values[index]);
    }
    const motivation = "Why do you want to work here?";
    assert.equal(
      data[responseKey].find((row) => row.question === motivation).jobKey,
      a.w.JobsJobMatch.key(a.w.location.href),
    );
    assert.equal(await a.w.matchOriginal(motivation), values[2]);
    assert.equal(await b.w.matchOriginal(motivation), null);
  } finally {
    a.dom.window.close();
    b.dom.window.close();
  }
});
test("button selection uses same pipeline; automatic clicks and disabled saving do not record", async () => {
  const data = {};
  const a = setup(data, "buttons", "button");
  a.memory.start(a.doc, true, a.save);
  const yes = a.doc.querySelector('[data-option="yes"]');
  yes.setAttribute("aria-pressed", "true");
  yes.click();
  await a.settle();
  assert.equal(data[responseKey], undefined);
  a.handlers.keyup({
    type: "keyup",
    key: "Enter",
    isTrusted: true,
    target: yes,
  });
  await a.settle();
  assert.equal(data[responseKey][0].response, "Yes");
  a.memory.start(a.doc, false, a.save);
  data[responseKey] = [];
  a.handlers.click({ type: "click", isTrusted: true, target: yes });
  await a.settle();
  assert.equal(data[responseKey].length, 0);
  a.dom.window.close();
});
test("manual correction updates the same Saved Response instead of creating a duplicate", async () => {
  const data = {};
  const a = setup(data);
  a.memory.start(a.doc, true, a.save);
  for (const id of ["yes", "no"]) {
    a.doc.getElementById(id).checked = true;
    a.handlers.pointerdown({
      type: "pointerdown",
      isTrusted: true,
      target: a.doc.querySelector(`label[for="${id}"]`),
    });
    a.handlers.click({
      type: "click",
      isTrusted: true,
      target: a.doc.querySelector(`label[for="${id}"]`),
    });
    await a.settle();
  }
  assert.equal(data[responseKey].length, 1);
  assert.equal(await a.w.matchOriginal(question), "No, unwilling");
  a.dom.window.close();
});
test("Saved Responses edits and deletions are effective immediately without a private cache", async () => {
  const data = {};
  const a = setup(data);
  await a.w.saveOriginal([{ question, response: "Yes, willing" }]);
  data[responseKey][0].response = "No, unwilling";
  assert.equal(await a.w.matchOriginal(question), "No, unwilling");
  data[responseKey] = [];
  assert.equal(await a.w.matchOriginal(question), null);
  a.dom.window.close();
});
test("rapid concurrent saves retain both answers and preserve existing rule metadata", async () => {
  const data = {};
  const a = setup(data);
  await Promise.all([
    a.w.saveOriginal([{ question, response: "Yes, willing" }]),
    a.w.saveOriginal([
      { question: "Have you previously worked for Rivian?", response: "No" },
    ]),
  ]);
  assert.equal(data[responseKey].length, 2);
  assert.equal(
    await a.w.matchOriginal("Have you previously worked for Gecko?"),
    null,
  );
  data[responseKey][0].id = "existing-cloud-id";
  data[responseKey][0].ignore = ["remote"];
  await a.w.saveOriginal([{ question, response: "No, unwilling" }]);
  assert.equal(data[responseKey][0].id, "existing-cloud-id");
  assert.deepEqual(data[responseKey][0].ignore, ["remote"]);
  a.dom.window.close();
});

test("manual text is saved without submission, survives removed controls, and later corrections replace it", async () => {
  const data = {};
  const a = setup(data);
  a.doc.body.innerHTML = "<label>Why this team?<textarea></textarea></label>";
  a.memory.start(a.doc, true, a.save);
  const input = a.doc.querySelector("textarea");
  input.value = "My first answer";
  a.handlers.input({ type: "input", isTrusted: true, target: input });
  input.remove();
  a.memory.flush();
  await a.settle();
  assert.equal(data[responseKey][0].response, "My first answer");
  a.doc.body.innerHTML = "<label>Why this team?<textarea></textarea></label>";
  const next = a.doc.querySelector("textarea");
  next.value = "Corrected answer";
  a.handlers.change({ type: "change", isTrusted: true, target: next });
  await a.settle();
  assert.equal(data[responseKey].length, 1);
  assert.equal(data[responseKey][0].response, "Corrected answer");
  a.dom.window.close();
});

test("mere focus/click on autofilled text does not learn; clearing a pending answer cancels it", async () => {
  const data = {};
  const a = setup(data);
  a.doc.body.innerHTML = "<label>Summary<textarea></textarea></label>";
  a.memory.start(a.doc, true, a.save);
  const node = a.doc.querySelector("textarea");
  node.value = "Autofilled";
  a.handlers.click({ type: "click", isTrusted: true, target: node });
  a.handlers.focusout({ type: "focusout", isTrusted: true, target: node });
  await a.settle();
  assert.equal(data[responseKey], undefined);
  a.handlers.input({ type: "input", isTrusted: true, target: node });
  node.value = "";
  a.handlers.input({ type: "input", isTrusted: true, target: node });
  a.memory.flush();
  await a.settle();
  assert.equal(data[responseKey], undefined);
  a.dom.window.close();
});

test("native select, checkbox correction, and custom radio use readable answers in the original list", async () => {
  const data = {};
  const a = setup(data);
  a.doc.body.innerHTML =
    '<label>How did you hear?<select><option value="">Choose</option><option value="friend">Friend or Referral</option></select></label><fieldset><legend>Preferred locations</legend><label>Oakland<input type="checkbox"></label></fieldset><div role="radiogroup" aria-label="Willing to relocate?"><div role="radio" aria-checked="false">Yes</div><div role="radio" aria-checked="true">No</div></div>';
  a.memory.start(a.doc, true, a.save);
  const select = a.doc.querySelector("select");
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: select,
  });
  select.value = "friend";
  a.handlers.change({ type: "change", isTrusted: true, target: select });
  const check = a.doc.querySelector("input");
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: check,
  });
  check.checked = true;
  a.handlers.change({ type: "change", isTrusted: true, target: check });
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: a.doc.querySelector('[aria-checked="true"]'),
  });
  a.handlers.click({
    type: "click",
    isTrusted: true,
    target: a.doc.querySelector('[aria-checked="true"]'),
  });
  await a.settle();
  assert(
    data[responseKey].some((row) => row.response === "Friend or Referral"),
  );
  assert(
    data[responseKey].some(
      (row) =>
        row.question === "Preferred locations — Oakland" &&
        row.response === "Yes",
    ),
  );
  assert(
    data[responseKey].some(
      (row) => row.question === "Willing to relocate?" && row.response === "No",
    ),
  );
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: check,
  });
  check.checked = false;
  a.handlers.change({ type: "change", isTrusted: true, target: check });
  await a.settle();
  assert.equal(
    data[responseKey].find(
      (row) => row.question === "Preferred locations — Oakland",
    ).response,
    "No",
  );
  a.dom.window.close();
});

test("Ashby dropdown does not learn search fragments and captures a portal option after the menu is removed", async () => {
  const data = {};
  const a = setup(data);
  a.doc.body.innerHTML =
    '<label>Referral source<input role="combobox" aria-expanded="true" aria-controls="options"></label><div role="listbox" id="options"><div role="option">Friend or Referral</div></div>';
  a.memory.start(a.doc, true, a.save);
  const node = a.doc.querySelector("input");
  node.value = "Fri";
  a.handlers.input({ type: "input", isTrusted: true, target: node });
  a.memory.flush();
  await a.settle();
  assert.equal(data[responseKey], undefined);
  a.handlers.pointerdown({
    type: "pointerdown",
    isTrusted: true,
    target: a.doc.querySelector('[role="option"]'),
  });
  a.handlers.click({
    type: "click",
    isTrusted: true,
    target: a.doc.querySelector('[role="option"]'),
  });
  node.value = "Friend or Referral";
  node.setAttribute("aria-expanded", "false");
  a.doc.querySelector('[role="listbox"]').remove();
  await a.settle();
  assert.equal(data[responseKey][0].response, "Friend or Referral");
  a.dom.window.close();
});

test("an unknown combobox does not learn a closed query as a committed answer", async () => {
  const data = {},
    a = setup(data);
  a.w.JobsAshbyControls = undefined;
  a.doc.body.innerHTML =
    '<label>Referral source<input role="combobox" aria-expanded="false" value="Unconfirmed search"></label>';
  a.memory.start(a.doc, true, a.save);
  const node = a.doc.querySelector("input");
  a.handlers.keyup({
    type: "keyup",
    key: "Enter",
    isTrusted: true,
    target: node,
  });
  a.memory.flush();
  await a.settle();
  assert.equal(data[responseKey], undefined);
  a.dom.window.close();
});

test("failed saving stays diagnosable and retries on the next flush, then avoids rewriting identical values", async () => {
  const data = {};
  const a = setup(data),
    events = [];
  a.w.JobsDiagnostics = { note: (type) => events.push(type) };
  a.doc.body.innerHTML = "<label>Custom answer<input></label>";
  let fail = true;
  a.memory.start(a.doc, true, (rows) =>
    fail ? Promise.reject(Error("disk failed")) : a.save(rows),
  );
  const node = a.doc.querySelector("input");
  node.value = "Answer";
  a.handlers.change({ type: "change", isTrusted: true, target: node });
  await a.settle();
  assert(events.includes("memory_save_failed"));
  assert(!events.includes("memory_saved"));
  fail = false;
  a.memory.flush();
  await a.settle();
  assert(events.includes("memory_saved"));
  const result = await a.w.saveOriginal([
    { question: "Custom answer", response: "Answer" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.saved, 0);
  a.dom.window.close();
});

test("exact saved questions survive short or non-English labels and take precedence over generic defaults", async () => {
  const data = {};
  const a = setup(data);
  await a.w.saveOriginal([
    { question: "工作地点？", response: "上海" },
    { question: "Are you authorized to work?", response: "No" },
  ]);
  assert.equal(await a.w.matchOriginal("工作地点？"), "上海");
  a.w.eval(
    'window.matchWithDefaults = () => JobsAnswerResolver.matchSaved({question:"Are you authorized to work? *"}, [{keywords:["authorized"],appearances:1,response:"Yes"}, ...window.currentSaved]);',
  );
  a.w.currentSaved = data[responseKey];
  assert.equal(a.w.matchWithDefaults(), "No");
  a.dom.window.close();
});

test("same question drafts for two jobs survive the actual background writer without overwriting each other", async () => {
  const data = {},
    a = setup(data, "company-a"),
    b = setup(data, "company-b");
  const question = "Why this team?",
    keyA = a.w.JobsJobMatch.key(a.w.location.href),
    keyB = b.w.JobsJobMatch.key(b.w.location.href);
  try {
    await a.w.saveOriginal([
      { question, response: "Company A draft", jobKey: keyA },
    ]);
    await b.w.saveOriginal([
      { question, response: "Company B draft", jobKey: keyB },
    ]);
    await a.w.saveOriginal([
      { question, response: "Company A corrected", jobKey: keyA },
    ]);
    assert.equal(data[responseKey].length, 2);
    assert.equal(await a.w.matchOriginal(question), "Company A corrected");
    assert.equal(await b.w.matchOriginal(question), "Company B draft");
    assert.notEqual(data[responseKey][0].key, data[responseKey][1].key);
  } finally {
    a.dom.window.close();
    b.dom.window.close();
  }
});

test("saved text, select, checkbox and custom radio refill a fresh Ashby form without learning autofill again", async () => {
  const data = {},
    a = setup(data);
  for (const name of ["ashby-controls", "form-pipeline"])
    a.w.eval(
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    );
  a.doc.body.innerHTML =
    '<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Why this team?</label><textarea></textarea></div><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Source?</label><select><option value="">Choose</option><option value="ref">Referral</option></select></div><fieldset class="ashby-application-form-field-entry"><legend class="ashby-application-form-question-title">Available days</legend><label>Monday<input type="checkbox"></label><label>Tuesday<input type="checkbox"></label></fieldset><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Remote preference</label><div role="radiogroup" aria-label="Remote preference"><button role="radio" aria-checked="false">Yes</button><button role="radio" aria-checked="false">No</button></div></div>';
  await a.w.saveOriginal([
    {
      question: "Why this team?",
      response: "Specific motivation",
      jobKey: a.w.JobsJobMatch.key(a.w.location.href),
    },
    { question: "Source?", response: "Referral" },
    { question: "Available days — Monday", response: "Yes" },
    { question: "Available days — Tuesday", response: "No" },
    { question: "Remote preference", response: "No" },
  ]);
  let learned = 0;
  a.memory.start(a.doc, true, () => {
    learned++;
  });
  for (const button of a.doc.querySelectorAll('[role="radio"]'))
    button.addEventListener("click", () =>
      button.setAttribute("aria-checked", "true"),
    );
  await runAnswerStage(a.w, {
    root: a.doc,
    profile: {},
    resolveAnswers: async (questions) => {
      const answers = [];
      for (const [index, item] of questions.entries()) {
        const answer = await a.w.matchOriginal(item.question);
        if (answer)
          answers.push({
            index,
            answer,
            source: "saved",
            reason: "saved_exact_question",
          });
      }
      return answers;
    },
  });
  assert.equal(a.doc.querySelector("textarea").value, "Specific motivation");
  assert.equal(a.doc.querySelector("select").value, "ref");
  const boxes = a.doc.querySelectorAll("input");
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(a.doc.querySelector('[aria-checked="true"]').textContent, "No");
  assert.equal(learned, 0);
  a.dom.window.close();
});
