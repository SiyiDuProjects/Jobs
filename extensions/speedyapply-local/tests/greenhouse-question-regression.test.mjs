import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "greenhouse-controls",
    "form-pipeline",
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const adapter = await read("source/content/adapters/greenhouse.js"),
  domControls = await read("source/content/shared/dom-controls.js");
const profile = {
  profileName: "Fixture",
  educationData: [{ degree: "Bachelor of Arts", fieldOfStudy: "Physics" }],
};
const internship =
  "Do you have relevant internship experience at a proprietary trading firm?";
const firm =
  "If yes, select your most recent proprietary trading firm experience";
const other = "If other, please specify";
const source = "How did you hear about Example Trading?";
const explain = "If other, please explain";
const id = {
  internship: "question_9068508005",
  firm: "question_9068509005",
  other: "question_9068510005",
  source: "question_9068517005",
  explain: "question_9068518005",
};
function field(key, label, labels, selected = "") {
  const name = id[key];
  return `<div><label id="${name}-label" for="${name}">${label}</label>${labels ? `<select id="${name}"><option value="">Select</option>${labels.map((text) => `<option ${selected === text ? "selected" : ""}>${text}</option>`).join("")}</select>` : `<input id="${name}">`}</div>`;
}
const conditional = (answer = "No", company = "") =>
  field("internship", internship, ["Yes", "No"], answer) +
  field("firm", firm, ["Example Firm", "Other"], company) +
  field("other", other) +
  field("source", source, ["LinkedIn", "Other"], "Other") +
  field("explain", explain);
function discipline(count = 83) {
  const labels = [
    "Computer Science",
    "Applied Physics",
    "Physics",
    "Theoretical Physics",
    ...Array.from(
      { length: count - 4 },
      (_, i) => `Unrelated subject ${i + 1}`,
    ),
  ];
  return `<label id="question_9068507005[]-label" for="question_9068507005[]">Undergrad Discipline(s) *</label><div id="question_9068507005[]" role="group" aria-labelledby="question_9068507005[]-label" aria-describedby="disc-help"><p id="disc-help">If you have multiple disciplines, please select all that apply.</p>${labels.map((label, i) => `<label><input id="question_9068507005[]_${i}" type="checkbox" name="question_9068507005[]" aria-required="true" aria-invalid="true">${label}</label>`).join("")}</div>`;
}
function fixture(
  t,
  html,
  { saved = [], url = "https://job-boards.greenhouse.io/fixture/jobs/1" } = {},
) {
  const dom = new JSDOM(
      `<form><div class="application--questions"></div><div class="application--questions">${html}</div><button type="button">Submit</button></form>`,
      { url, runScripts: "outside-only" },
    ),
    w = dom.window;
  t.after(() => w.close());
  let ai = 0,
    submits = 0;
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        ai++;
        throw Error("Confirmed answers must not call AI");
      },
    },
  };
  scripts.forEach((code) => w.eval(code));
  w.eval(domControls);
  w.eval(adapter);
  installAnswerResolver(w, saved);
  // jsdom has no layout innerText; expose the visible fixture caption.
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  const doc = w.document,
    root = doc.querySelector("form"),
    reader = w.JobsControlFields.create(doc, () => root, { write: true });
  doc.querySelector("button").onclick = () => submits++;
  root.addEventListener("change", () => {
    const group = doc.getElementById("question_9068507005[]");
    if (group)
      for (const box of group.querySelectorAll("input"))
        box.setAttribute(
          "aria-invalid",
          String(!group.querySelector(":checked")),
        );
  });
  const fill = () =>
    w.JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      retry: true,
      resolveAnswers: w.JobsAnswerResolver.resolve,
      fill: () => w.greenhouseFillCustomQuestions(profile, false),
    });
  return {
    fill,
    w,
    doc,
    root,
    reader,
    ai: () => ai,
    submits: () => submits,
    find: (key) => reader.scan().find((row) => row.node.id === id[key]),
  };
}
test("observed 83-option discipline is one required group and fills exact Physics through the automatic loop", async (t) => {
  const f = fixture(t, discipline()),
    rows = f.reader.scan();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public.type, "select-multiple");
  assert.equal(rows[0].public.options.length, 83);
  assert.equal(
    await f.w.JobsAutomatic.advance({
      root: f.root,
      profile,
      action: "submit",
      target: f.doc.querySelector("button"),
      resolveAnswers: f.w.JobsAnswerResolver.resolve,
    }),
    true,
  );
  assert.deepEqual(
    Array.from(
      f.doc.querySelectorAll("input:checked"),
      (node) => node.parentElement.textContent,
    ),
    ["Physics"],
  );
  assert.equal(f.reader.state().ready, true);
  assert.equal(f.ai(), 0);
  assert.equal(f.submits(), 1);
});
test("first-pass Greenhouse adapter also fills the native discipline group", async (t) => {
  const f = fixture(t, discipline(4) + conditional());
  await f.fill();
  assert.deepEqual(
    Array.from(
      f.doc.querySelectorAll("input:checked"),
      (node) => node.parentElement.textContent,
    ),
    ["Physics"],
  );
});

function requiredCheckboxes() {
  // DoorDash's fieldset gives every option native required even though the
  // question requires a selected subset. All answers here are synthetic.
  return `<fieldset class="checkbox" id="question_101[]" aria-required="true"><legend id="question_101[]-label">Select up to 3 areas *</legend>${["Area A", "Area B", "Area C", "Area D"].map((label, index) => `<label><input type="checkbox" id="question_101[]_${index}" name="question_101[]" required aria-invalid="false">${label}</label>`).join("")}</fieldset>`;
}

test("Greenhouse required checkbox subsets commit and clear readiness without selecting every option", async (t) => {
  const f = fixture(t, requiredCheckboxes());
  const row = f.reader.scan()[0];
  assert.equal(row.public.required, true);
  assert.equal(f.reader.state().ready, false);
  const selected = row.public.options.slice(0, 3).map((option) => option.value);
  await f.reader.apply(row, selected);
  assert.equal(f.doc.querySelectorAll("input:checked").length, 3);
  assert.ok([...f.doc.querySelectorAll("input")].every((box) => box.required));
  assert.equal(f.reader.scan()[0].public.invalid, false);
  assert.equal(f.reader.state().ready, true);
  for (const box of f.doc.querySelectorAll("input")) box.checked = false;
  assert.equal(f.reader.state().ready, false);
});

test("Greenhouse populated checkbox groups still respect explicit ARIA and native custom errors", (t) => {
  const f = fixture(t, requiredCheckboxes());
  const boxes = [...f.doc.querySelectorAll("input")];
  boxes[0].checked = true;
  assert.equal(f.reader.state().ready, true);
  boxes[1].setAttribute("aria-invalid", "true");
  assert.equal(f.reader.state().ready, false);
  boxes[1].setAttribute("aria-invalid", "false");
  boxes[1].setCustomValidity("Synthetic selection error");
  assert.equal(f.reader.state().ready, false);
  boxes[1].setCustomValidity("");
  f.doc.querySelector("fieldset").setAttribute("aria-invalid", "true");
  assert.equal(f.reader.state().ready, false);
});

test("native required checkboxes on unrelated sites are not relaxed into group validation", (t) => {
  const f = fixture(t, requiredCheckboxes(), {
    url: "https://fixture.invalid/apply",
  });
  f.doc.querySelector("input").checked = true;
  assert.equal(f.reader.state().ready, false);
  assert.equal(f.reader.scan().length, 4);
});
test("a retained native checkbox commit error blocks submission without preventing later source filling", async (t) => {
  const f = fixture(t, discipline(4) + conditional(), { saved: memories });
  f.root.addEventListener("change", () =>
    f.doc
      .querySelector('input[type="checkbox"]')
      .setAttribute("aria-invalid", "true"),
  );
  await f.fill();
  assert.equal(f.reader.state().ready, false);
  assert.equal(f.doc.getElementById(id.explain).value, "Source Portal");
});
test("group keeps actual validation errors and existing selections; unrelated sites keep independent checkboxes", async (t) => {
  const f = fixture(t, discipline(4));
  f.doc.querySelectorAll("input")[2].checked = true;
  assert.equal(
    f.reader.scan()[0].public.invalid,
    true,
    "persistent ATS error must remain visible",
  );
  await f.fill();
  assert.equal(f.doc.querySelectorAll(":checked").length, 1);
  const otherSite = fixture(t, discipline(4), {
    url: "https://fixture.test/apply",
  });
  assert.equal(otherSite.reader.scan().length, 4);
});
const memories = [
  {
    question: other,
    keywords: ["other"],
    appearances: 1,
    response: "Source Portal",
    fromAutofill: true,
  },
  { keywords: ["other"], appearances: 1, response: "Source Portal" },
  {
    question: source + " — " + explain,
    keywords: ["how did you hear", "other"],
    appearances: 2,
    response: "Source Portal",
    fromAutofill: true,
  },
];
test("No internship omits both dependent fields while real source follow-up still fills", async (t) => {
  const f = fixture(t, conditional(), { saved: memories }),
    decisions = [];
  await f.w.JobsAnswerResolver.resolve(
    [{ node: f.find("other").node, question: other }],
    profile,
    { onDecision: (d) => decisions.push(d) },
  );
  assert.equal(decisions[0].status, "omit");
  await f.fill();
  assert.equal(f.doc.getElementById(id.other).value, "");
  assert.equal(f.doc.getElementById(id.firm).value, "");
  assert.equal(f.doc.getElementById(id.explain).value, "Source Portal");
});
test("active internship Other cannot reuse generic/source memory; exact contextual firm answer works", async (t) => {
  const f = fixture(t, conditional("Yes", "Other"), { saved: [...memories] });
  await f.fill();
  assert.equal(f.doc.getElementById(id.other).value, "");
  const scoped = internship + " — " + firm + " — " + other;
  f.w.fixtureSavedResponses.push({
    question: scoped,
    keywords: ["firm"],
    appearances: 1,
    response: "Confirmed Firm",
    fromAutofill: true,
  });
  await f.fill();
  assert.equal(f.doc.getElementById(id.other).value, "Confirmed Firm");
  const captured = await f.w.greenhouseReadUnresolvedResponses(new Set());
  assert(
    captured.some(
      (row) => row.question === scoped && row.response === "Confirmed Firm",
    ),
    "captured answers retain parent question scope",
  );
  assert(
    !captured.some((row) => row.question === other),
    "generic Other is not captured as a reusable answer",
  );
});
test("same first pass rechecks conditions after answering parent, and preserves existing text", async (t) => {
  const f = fixture(t, conditional("", ""), {
    saved: [
      ...memories,
      {
        question: internship,
        response: "No",
        keywords: ["internship"],
        appearances: 1,
      },
    ],
  });
  f.doc.getElementById(id.explain).value = "Existing source";
  await f.fill();
  assert.equal(f.doc.getElementById(id.internship).value, "No");
  assert.equal(f.doc.getElementById(id.other).value, "");
  assert.equal(f.doc.getElementById(id.explain).value, "Existing source");
});
test("parent change invalidates a pending conditional write and uncommitted parent never activates it", async (t) => {
  const f = fixture(t, conditional("Yes", "Other"), { saved: memories }),
    row = f.find("other");
  f.doc.getElementById(id.internship).value = "No";
  await assert.rejects(
    f.reader.apply(row, "Confirmed Firm"),
    /changed|condition/i,
  );
  f.doc.getElementById(id.internship).value = "";
  const answers = await f.w.JobsAnswerResolver.resolve(
    [{ question: other, node: f.find("other").node }],
    profile,
  );
  assert.equal(answers.length, 0);
  assert.equal(f.doc.getElementById(id.other).value, "");
});
test("Other conditions with no proven adjacent choice do not borrow unrelated field context", async (t) => {
  const f = fixture(t, field("internship", "Name") + field("other", other), {
    saved: memories,
  });
  f.doc.getElementById(id.internship).value = "Example Applicant";
  await f.fill();
  assert.equal(f.doc.getElementById(id.other).value, "");
});
test("an unlocated generic conditional cannot bypass context through a legacy collector", async (t) => {
  const f = fixture(t, conditional(), { saved: memories });
  const answers = await f.w.JobsAnswerResolver.resolve(
    [{ question: other, node: f.root }],
    profile,
  );
  assert.equal(answers.length, 0);
});
test("React Select parent uses its committed value, never typed search text or an open menu", async (t) => {
  const combo = `<div class="select"><label id="${id.source}-label" for="${id.source}">${source}</label><div class="select__value-container"><input class="select__input" role="combobox" aria-required="false" aria-expanded="false" id="${id.source}" aria-labelledby="${id.source}-label" value="Other"></div></div>`;
  const f = fixture(t, combo + field("explain", explain), { saved: memories });
  assert.equal(f.find("explain").public.conditional.active, null);
  f.doc
    .querySelector(".select__value-container")
    .insertAdjacentHTML(
      "afterbegin",
      '<div class="select__single-value">Other</div>',
    );
  assert.equal(f.find("explain").public.conditional.active, true);
  f.doc.getElementById(id.source).setAttribute("aria-expanded", "true");
  assert.equal(f.find("explain").public.conditional.active, null);
  f.doc.getElementById(id.source).setAttribute("aria-expanded", "false");
  const answers = await f.w.JobsAnswerResolver.resolve(
    [{ node: f.find("explain").node, question: explain }],
    profile,
  );
  assert.equal(answers[0].answer, "Source Portal");
});
test("discipline retains its linked label when the non-labelable group uses description only", async (t) => {
  const f = fixture(
    t,
    discipline(4).replace(
      'aria-labelledby="question_9068507005[]-label"',
      'aria-describedby="question_9068507005[]-label"',
    ),
  );
  assert.equal(f.reader.scan()[0].public.question, "Undergrad Discipline(s) *");
});
test("manual/generated answer capture also saves contextual keys and refuses an inactive follow-up", async (t) => {
  const f = fixture(t, conditional("Yes", "Other")),
    saved = [];
  f.w.JobsJobMatch = {
    key: () => JSON.stringify(["greenhouse", "fixture", "1"]),
  };
  const session = f.w.JobsAnswerMemory.start(f.root, true, async (records) => {
    saved.push(...records);
  });
  f.doc.getElementById(id.other).value = "Confirmed Firm";
  session.remember(other, f.doc.getElementById(id.other));
  await Promise.resolve();
  assert.equal(saved[0].question, internship + " — " + firm + " — " + other);
  f.doc.getElementById(id.internship).value = "No";
  session.remember(other, f.doc.getElementById(id.other));
  await Promise.resolve();
  assert.equal(saved.length, 1);
  session.stop();
});
