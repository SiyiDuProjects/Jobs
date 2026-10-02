import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const names = [
  "job-match-rules",
  "job-match",
  "option-match",
  "profile-answers",
  "dom-wait",
  "control-fields",
  "workday-controls",
  "review-presenter",
  "ai-review",
  "operation-context",
  "automatic-fill",
  "answer-memory",
];
const codes = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name,
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ]),
  ),
);
function setup() {
  const field = (i) =>
    `<div data-automation-id="formField-q${i}"><div data-automation-id="richText">Question ${i}</div><button type="button" id="q${i}" name="q${i}" aria-haspopup="listbox" aria-label=" ${i < 2 ? "Yes" : "Select One"} Required" aria-invalid="${i >= 2}"><span>${i < 2 ? "Yes" : "Select One"}</span></button><input type="text" style="display:none" value="${i < 2 ? "existing-id" : ""}">${i >= 2 ? '<p data-automation-id="inputAlert">Required</p>' : ""}</div>`;
  const dom = new JSDOM(
      `<div data-automation-id="applyFlowPage"><div data-automation-id="applyFlowPrimaryQuestionsPage">${Array.from({ length: 6 }, (_, i) => field(i)).join("")}<div><label for="text">Other answer</label><input id="text" value="Existing answer"></div></div><button type="button" id="next">Save and Continue</button></div>`,
      {
        url: "https://fixture.myworkdayjobs.com/en-US/Careers/job/SF/Engineer_R123/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  const root = w.document.querySelector('[data-automation-id="applyFlowPage"]'),
    profile = { profileName: "Newgrad" },
    messages = [],
    requests = [],
    events = [],
    saved = [];
  let clicks = 0,
    serial = 0;
  w.JobsControlConfig = { observe: true, enabled: false };
  w.JobsPageSession = { root: () => root, profile: () => profile };
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        if (msg.type === "jobs:tab-profile")
          return { data: { id: "ng", profile } };
        if (msg.type === "saveResponses") {
          saved.push(...msg.data);
          return { ok: true };
        }
        if (msg.type === "jobs:auto-answers") {
          requests.push(msg);
          return {
            data: {
              answers: msg.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "No",
                reason: "Synthetic test",
                source: "suggestion",
                questionZh: "测试问题",
                answerZh: "否",
              })),
            },
          };
        }
        throw Error("Unexpected message");
      },
    },
  };
  Object.values(codes).forEach((code) => w.eval(code));
  function close(button) {
    w.document.getElementById(button.getAttribute("aria-controls"))?.remove();
    button.removeAttribute("aria-controls");
  }
  for (const button of root.querySelectorAll('[aria-haspopup="listbox"]')) {
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close(button);
    });
    button.addEventListener("click", () => {
      const list = w.document.createElement("ul");
      list.id = "list-" + ++serial;
      list.setAttribute("role", "listbox");
      button.setAttribute("aria-controls", list.id);
      w.document.body.append(list);
      setTimeout(() => {
        if (!list.isConnected) return;
        for (const [value, label] of [
          ["select-one", "Select One"],
          ["yes-id", "Yes"],
          ["no-id", "No"],
        ]) {
          const option = w.document.createElement("li");
          option.id = value;
          option.setAttribute("role", "option");
          option.textContent = label;
          list.append(option);
          option.onclick = () => {
            button.firstElementChild.textContent = label;
            button.setAttribute("aria-invalid", "false");
            button.nextElementSibling.value = value;
            button.parentElement
              .querySelector('[data-automation-id="inputAlert"]')
              ?.remove();
            close(button);
          };
        }
      }, 5);
    });
  }
  w.document.querySelector("#next").onclick = () => clicks++;
  return {
    w,
    root,
    profile,
    messages,
    requests,
    events,
    saved,
    clicks: () => clicks,
    close: () => w.close(),
  };
}

test("Workday button listboxes expose questions/required state and committed text without confusing hidden IDs with answers", async () => {
  const h = setup();
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root, {
        write: true,
      }),
      rows = reader.scan();
    assert.equal(rows.length, 7);
    assert.equal(
      rows.filter((r) => r.public.required && !r.public.filled).length,
      4,
    );
    assert.equal(rows[0].public.type, "combobox");
    assert.equal(rows[0].public.question, "Question 0");
    assert.equal(reader.response(rows[0]).response, "Yes");
    const opts = await reader.readOptions(rows[2]);
    assert.deepEqual(
      Array.from(opts, (o) => o.label),
      ["Yes", "No"],
    );
    assert.equal(
      h.w.document.querySelectorAll('[role="listbox"]').length,
      0,
      "reading choices does not leave a menu open",
    );
    assert.equal(
      reader.scan()[2].public.filled,
      false,
      "reading choices never answers the question",
    );
    await reader.apply(reader.scan()[2], "No");
    assert.equal(reader.response(reader.scan()[2]).response, "No");
  } finally {
    h.close();
  }
});

test("explicit manual review: four Workday button questions fill exact options and wait for confirmation before learning", async () => {
  const h = setup();
  try {
    h.w.JobsAnswerMemory.start(
      h.w.document,
      true,
      (rows) => {
        h.saved.push(...rows);
        return Promise.resolve();
      },
      () => h.root,
    );
    const result = await h.w.JobsAutomatic.advance({
      root: h.root,
      profile: h.profile,
      action: "fill",
      autoConfirm: false,
      resolveAnswers: async () => [],
      setMessage: (msg) => h.messages.push(msg),
    });
    assert.equal(result, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].fields.length, 4);
    assert(
      h.requests[0].fields.every(
        (field) =>
          field.type === "combobox" &&
          field.required &&
          field.options.map((o) => o.label).join(",") === "Yes,No",
      ),
    );
    assert.equal(h.saved.length, 0);
    assert.equal(h.clicks(), 0);
    assert(h.w.JobsAIReview.pending());
    const buttons = [...h.root.querySelectorAll('[aria-haspopup="listbox"]')];
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["Yes", "Yes", "No", "No", "No", "No"],
    );
    assert.equal(h.w.document.querySelector("#text").value, "Existing answer");
    assert.equal(
      h.events.filter(([type]) => type === "auto_luna_requested").length,
      4,
    );
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.saved.length, 4);
    assert(h.saved.every((row) => row.response === "No"));
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("late Workday validation replaces page-complete without another fill or submit attempt", async () => {
  const h = setup();
  try {
    for (const button of h.root.querySelectorAll('[aria-haspopup="listbox"]')) {
      button.firstElementChild.textContent = "Yes";
      button.setAttribute("aria-invalid", "false");
    }
    h.root
      .querySelectorAll('[data-automation-id="inputAlert"]')
      .forEach((node) => node.remove());
    const observed = h.w.JobsAutomatic.observe({
      setMessage: (msg) => h.messages.push(msg),
      getProfile: async () => h.profile,
    });
    await observed.getProfile();
    observed.setMessage("page-complete");
    h.w.document.getElementById("q2").setAttribute("aria-invalid", "true");
    await h.w.JobsDOMWait.until(
      () => h.messages.at(-1) === "complete-required",
      { timeout: 1000, interval: 10 },
    );
    assert.equal(h.messages.at(-1), "complete-required");
    assert.equal(h.requests.length, 0);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

function selfIdentify(selected = true, registered = false) {
  const h = setup();
  h.root.innerHTML = `<label for="employee">Employee ID (if applicable)</label><input id="employee" aria-required="false">
 <fieldset><legend><label>Please check one of the boxes below:<abbr aria-hidden="true">*</abbr></label></legend>
 <span><fieldset data-automation-id="preferenceStatus-CheckboxGroup" aria-required="true">
 <div role="grid">${["Choice A", "Choice B", "Decline"].map((label, i) => `<div role="row"><input type="checkbox" id="choice${i}" aria-required="true" ${selected ? (i === 1 ? "checked" : "disabled") : ""}><label for="choice${i}">${label}</label></div>`).join("")}</div>
 </fieldset></span></fieldset>`;
  if (registered)
    h.root
      .querySelectorAll('[role="row"]')
      .forEach((node) => node.setAttribute("role", "cell"));
  for (const option of h.root.querySelectorAll('[type="checkbox"]'))
    option.onclick = () => {
      for (const other of h.root.querySelectorAll('[type="checkbox"]')) {
        other.checked = other === option;
        other.disabled = other !== option;
      }
    };
  return h;
}

test("registered Workday exclusive group retains its selected answer when peers disable", async () => {
  const h = selfIdentify(false, true);
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root);
    const before = reader.scan().find((row) => row.public.required);
    assert.equal(before.public.component, "workday-checkbox-group");
    h.root.querySelector("#choice1").click();
    const after = reader.scan().find((row) => row.public.required);
    assert.equal(after.node, before.node);
    assert.equal(after.public.filled, true);
    assert.equal(reader.response(after).response, "Choice B");
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "fill",
      }),
      true,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
  } finally {
    h.close();
  }
});

test("confirmation of an unreadable field stays blocked until the same field is readable and answered", async () => {
  const h = setup();
  try {
    h.root.innerHTML =
      '<label for="missing">Required detail*</label><input id="missing" required><label for="kept">Existing detail</label><input id="kept" value="fixture">';
    const observed = h.w.JobsAutomatic.observe({
      setMessage: (message) => h.messages.push(message),
      getProfile: async () => h.profile,
    });
    const profile = await observed.getProfile();
    const send = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = async (message) =>
      message.type === "jobs:auto-answers"
        ? {
            data: {
              answers: message.fields.map((f) => ({
                fieldId: f.fieldId,
                state: "needs_input",
                value: null,
                source: "unknown",
              })),
            },
          }
        : send(message);
    await h.w.JobsAutomatic.advance({
      root: h.root,
      profile,
      action: "fill",
      setMessage: observed.setMessage,
    });
    const input = h.root.querySelector("#missing");
    input.disabled = true;
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    h.root.append(h.w.document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.messages.at(-1), "complete-required");
    input.disabled = false;
    input.value = "Fixture response";
    input.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await h.w.JobsDOMWait.until(() => h.messages.at(-1) === "page-complete", {
      timeout: 1000,
      interval: 10,
    });
    assert.equal(h.messages.at(-1), "page-complete");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("Workday self identify: an answered exclusive checkbox group is one completed question; optional employee ID triggers no AI", async () => {
  const h = selfIdentify();
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root, {
        write: true,
      }),
      rows = reader.scan();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].public.required, false);
    assert.equal(rows[0].public.supplement, false);
    assert.equal(rows[1].public.type, "radio");
    assert.equal(rows[1].public.filled, true);
    assert.equal(rows[1].public.required, true);
    assert.equal(reader.response(rows[1]).response, "Choice B");
    assert.equal(rows[1].group.length, 3);
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "fill",
      }),
      true,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.w.document.getElementById("employee").value, "");
  } finally {
    h.close();
  }
});

test("Workday exclusive checkbox question uses one existing answer and keeps a stable field identity when peers disable", async () => {
  const h = selfIdentify(false);
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root, {
      write: true,
    });
    const before = reader.scan()[1];
    assert.equal(before.public.filled, false);
    let questions;
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "fill",
        resolveAnswers: async (fields) => {
          questions = fields;
          return [
            {
              index: fields.findIndex((field) => field.required),
              answer: "Choice B",
            },
          ];
        },
      }),
      true,
    );
    assert.equal(questions.length, 2);
    assert.deepEqual(
      Array.from(questions.find((field) => field.required).options),
      ["Choice A", "Choice B", "Decline"],
    );
    const after = reader.scan()[1];
    assert.equal(after.node, before.node);
    assert.equal(after.public.id, before.public.id);
    assert.equal(reader.response(after).response, "Choice B");
    assert.equal(h.requests.length, 0);
    assert.equal(h.root.querySelectorAll("input:checked").length, 1);
  } finally {
    h.close();
  }
});

test("Workday exclusive selection survives an empty intermediate rerender without AI and continues once", async () => {
  const h = selfIdentify();
  let clicks = 0;
  const next = h.w.document.createElement("button");
  next.id = "continue";
  next.onclick = () => clicks++;
  h.w.document.body.append(next);
  try {
    const task = h.w.JobsAutomatic.advance({
      root: h.root,
      profile: h.profile,
      action: "next",
      selector: "#continue",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const group = h.root.querySelector(
        '[data-automation-id$="-CheckboxGroup"]',
      ),
      replacement = group.cloneNode(true);
    replacement.querySelectorAll("input").forEach((input) => {
      input.checked = false;
      input.disabled = false;
    });
    group.replaceWith(replacement);
    await new Promise((resolve) => setTimeout(resolve, 80));
    replacement.querySelector("#choice1").checked = true;
    assert.equal(await task, true);
    assert.equal(h.requests.length, 0);
    assert.equal(clicks, 1);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(replacement.querySelector("#choice1").checked, true);
  } finally {
    h.close();
  }
});

test("Workday optional policy preserves star-required questions and real multi-select checkbox semantics", () => {
  const h = selfIdentify();
  try {
    h.root.innerHTML = `<label for="star">Required answer<abbr>*</abbr></label><input id="star">
  <label for="optional">Optional answer</label><input id="optional">
  <fieldset data-automation-id="preferences-CheckboxGroup"><legend>Select all that apply</legend><input id="a" type="checkbox"><label for="a">A</label><input id="b" type="checkbox"><label for="b">B</label></fieldset>`;
    const rows = h.w.JobsControlFields.create(
      h.w.document,
      () => h.root,
    ).scan();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].public.required, true);
    assert.equal(h.w.JobsControlFields.needsAnswer(rows[0].public), true);
    assert.equal(h.w.JobsControlFields.needsAnswer(rows[1].public), false);
    assert.equal(rows[2].public.type, "select-multiple");
    assert.equal(rows[2].public.options.length, 2);
  } finally {
    h.close();
  }
});

// Structure observed on GM's Voluntary Disclosures page: a labelled outer
// fieldset, an inner ethnicityMulti-CheckboxGroup, and aria-required on every
// checkbox. These options are one multi-select question, not eight yes/no facts.
function gmDisclosures(selected = [1]) {
  const h = setup();
  const labels = [
    "American Indian or Alaska Native",
    "Asian",
    "Black or African American",
    "Hispanic or Latino",
    "I do not wish to answer.",
    "Native Hawaiian or Other Pacific Islander",
    "Two or More Races",
    "White",
  ];
  h.root.innerHTML = `<div data-automation-id="formField-ethnicityMulti"><fieldset><legend><label>What is / are your race(s) / ethnicity(ies)?<abbr aria-hidden="true">*</abbr></label></legend><div>
 <fieldset data-automation-id="ethnicityMulti-CheckboxGroup" id="personalInfoUS--ethnicityMulti" aria-required="true"><div role="grid"><div role="row">
 ${labels.map((label, index) => `<div role="gridcell"><input id="race${index}" type="checkbox" aria-required="true" ${selected.includes(index) ? "checked" : ""}><label for="race${index}">${label} (United States of America)</label></div>`).join("")}
 </div></div></fieldset></div></fieldset></div>
 <div data-automation-id="formField-gender"><div data-automation-id="richText">What is your gender?</div><button aria-haspopup="listbox" id="gender">Male</button></div>
 <div data-automation-id="formField-veteran"><div data-automation-id="richText">What is your veteran status?*</div><button aria-haspopup="listbox" id="veteran" aria-label="Veteran Required">I AM NOT A VETERAN</button></div>
 <label for="consent">Consent*</label><input id="consent" type="checkbox" checked required><button id="next" type="button">Save and Continue</button>`;
  h.root.querySelector("#next").onclick = () => h.events.push(["fixture_next"]);
  return h;
}

test("GM answered race group is one completed question and continues once with zero AI requests or checkbox changes", async () => {
  const h = gmDisclosures();
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root),
      rows = reader.scan();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].public.type, "select-multiple");
    assert.equal(rows[0].public.options.length, 8);
    assert.equal(
      rows[0].public.question,
      "What is / are your race(s) / ethnicity(ies)?*",
    );
    assert.equal(rows[0].public.required, true);
    assert.equal(rows[0].public.filled, true);
    assert.equal(rows[0].public.invalid, false);
    assert.equal(
      reader.response(rows[0]).response,
      "Asian (United States of America)",
    );
    assert.equal(reader.state().ready, true);
    assert.equal(
      rows.filter((row) => h.w.JobsControlFields.needsAnswer(row.public))
        .length,
      0,
    );
    let edits = 0;
    h.root.addEventListener("change", () => edits++);
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "next",
        selector: "#next",
      }),
      true,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(edits, 0);
    assert.equal(
      h.events.filter(([name]) => name === "fixture_next").length,
      1,
    );
    assert.deepEqual(
      [...h.root.querySelectorAll('[id^="race"]:checked')].map(
        (node) => node.id,
      ),
      ["race1"],
    );
  } finally {
    h.close();
  }
});

test("GM truly blank required race group produces one question with eight options rather than eight boolean questions", async () => {
  const h = gmDisclosures([]);
  try {
    const original = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = async (message) => {
      if (message.type !== "jobs:auto-answers") return original(message);
      h.requests.push(message);
      return {
        data: {
          answers: message.fields.map((field) => ({
            fieldId: field.fieldId,
            state: "needs_input",
            value: null,
            reason: "No confirmed choice",
          })),
        },
      };
    };
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "fill",
        resolveAnswers: async () => [],
      }),
      false,
    );
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].fields.length, 1);
    assert.equal(h.requests[0].fields[0].type, "select-multiple");
    assert.equal(h.requests[0].fields[0].options.length, 8);
    assert.equal(h.root.querySelectorAll('[id^="race"]:checked').length, 0);
  } finally {
    h.close();
  }
});

test("Workday multi-select preserves multiple selected options and records one combined response", () => {
  const h = gmDisclosures([1, 6]);
  try {
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root),
      row = reader.scan()[0];
    assert.equal(row.raw.length, 2);
    assert.equal(reader.state().ready, true);
    assert.equal(
      reader.response(row).response,
      "Asian (United States of America); Two or More Races (United States of America)",
    );
  } finally {
    h.close();
  }
});

test("Workday grouped choices do not swallow separate consent boxes or suppress actual group validation", () => {
  const h = gmDisclosures();
  try {
    h.root.querySelector("#consent").checked = false;
    const reader = h.w.JobsControlFields.create(h.w.document, () => h.root),
      rows = reader.scan();
    assert.equal(rows[3].public.type, "checkbox");
    assert.equal(rows[3].public.filled, false);
    assert.equal(reader.state().ready, false);
    h.root.querySelector("#consent").checked = true;
    h.root
      .querySelector('[data-automation-id="ethnicityMulti-CheckboxGroup"]')
      .setAttribute("aria-invalid", "true");
    assert.equal(reader.scan()[0].public.invalid, true);
    assert.equal(reader.state().ready, false);
  } finally {
    h.close();
  }
});

test("explicit manual review: Workday exclusive choice produces one readable item after the other choices disable", async () => {
  const h = selfIdentify(false);
  try {
    const send = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type !== "jobs:auto-answers") return send(msg);
      h.requests.push(msg);
      return {
        data: {
          answers: msg.fields.map((field) => ({
            fieldId: field.fieldId,
            state: "answer",
            value: field.options.find((o) => o.label === "Choice B").value,
            source: "profile",
            questionZh: "测试选择",
            answerZh: "选项乙",
          })),
        },
      };
    };
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile: h.profile,
        action: "fill",
        autoConfirm: false,
      }),
      false,
    );
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].fields.length, 1);
    const card = h.w.document.querySelector("#jobs-ai-review").shadowRoot;
    assert.equal(card.querySelectorAll(".answer").length, 1);
    assert.equal(card.querySelector(".answer").textContent, "选项乙");
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.w.document.getElementById("employee").value, "");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});
