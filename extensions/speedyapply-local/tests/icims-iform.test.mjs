import { fixtureAnswers } from "./helpers/fixture-provider.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const read = (name) =>
  readWithDependencies(new URL("../" + name, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "icims-controls",
    "form-pipeline",
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const shared = await read("source/content/shared/dom-controls.js");
const adapter = await read("source/content/adapters/icims.js");
const field = (caption, content) =>
  `<p>${caption}<br><span class="customFieldContainer">${content}</span></p>`;
const radio = (caption, name) =>
  `<p>${caption}<br>${["Yes", "No"].map((label) => `<span class="customFieldContainer iCIMS_Forms_RadioGroup"><input type="radio" name="${name}" value="${label}" i_required="true"></span> ${label} `).join("")}</p>`;
const section = (title, html) =>
  `<table><tbody><tr><td><strong>${title}</strong></td></tr><tr><td>${html}</td></tr></tbody></table>`;
const date = `<span class="iCIMS_Forms_DateOnlyField customFieldContainer"><select class="iCIMS_Forms_MonthInput" i_required="true"><option value="0"></option><option value="05">May</option></select><select class="iCIMS_Forms_DayInput" i_required="true"><option value="0"></option><option value="1">1</option></select><input class="iCIMS_Forms_YearInput" i_required="true"></span>`;

function fixture(
  t,
  html,
  {
    path = "/forms",
    autoClickNextPage = true,
    buttons = '<button type="submit">Submit</button>',
    profile = {
      nameData: { firstName: "Example", lastName: "Applicant" },
      addressData: { city: "Home City", country: "United States" },
      employmentData: { eligibilityUS: true },
    },
  } = {},
) {
  const w = new JSDOM(`<form>${html}${buttons}</form>`, {
    url: "https://fixture.icims.com" + path,
    runScripts: "outside-only",
  }).window;
  t.after(() => w.close());
  const doc = w.document,
    root = doc.querySelector("form"),
    tasks = [],
    phases = [],
    requests = [];
  let submits = 0;
  w.chrome = {
    runtime: {
      id: "fixture",
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:review-present") return { ok: true };
        requests.push(message);
        return {
          data: {
            answers: fixtureAnswers(
              w.JobsProfileAnswers,
              message.fields || [],
              profile,
              message.formContext,
            ),
          },
        };
      },
    },
  };
  for (const code of [...scripts, shared, adapter]) w.eval(code);
  installAnswerResolver(w, []);
  w.JobsPageSession = { root: () => root };
  Object.assign(w, {
    jobsReportJobTitle: async () => {},
    jobsMountManualAnswerControls: async () => {},
    jobsFillAccount: async () => {},
    jobsWaitForXPathNodes: (xpath) => {
      const nodes = w.jobsFindXPath(xpath);
      return nodes ? Promise.resolve([nodes]) : new Promise(() => {});
    },
  });
  const advance = w.JobsAutomatic.advance;
  w.JobsAutomatic = {
    ...w.JobsAutomatic,
    advance: (options) => {
      const task = advance(options);
      tasks.push(task);
      return task;
    },
  };
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  const reader = w.JobsControlFields.create(doc, () => root);
  return {
    w,
    doc,
    root,
    reader,
    tasks,
    phases,
    requests,
    submits: () => submits,
    async run() {
      await w.icimsRunApplication({
        getProfile: async () => profile,
        setMessage: (p) => phases.push(p),
        autofillSettings: { autoClickNextPage, autoSubmit: false },
        accountSettings: {},
        ctx: { isInvalid: false },
      });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      await Promise.all(tasks);
    },
  };
}

test("IForm fills shared Profile rules and uses Submit to continue once", async (t) => {
  const f = fixture(
    t,
    section(
      "PERSONAL",
      field("First Name", '<input aria-label="FirstName" required>'),
    ) + radio("Are you legally authorized to work in the U.S.?", "auth"),
  );
  await f.run();
  assert.equal(f.tasks.length, 1);
  assert.equal(
    f.doc.querySelector('input[aria-label="FirstName"]').value,
    "Example",
  );
  assert.equal(f.doc.querySelector('input[name="auth"]:checked')?.value, "Yes");
  assert.equal(f.submits(), 1);
  assert.equal(f.phases.includes("awaiting-transition"), true);
  assert.equal(f.phases.includes("complete-manually"), false);
});

test("IForm respects automatic-next off even when its Submit is available", async (t) => {
  const f = fixture(
    t,
    field("First Name", '<input value="Existing" required>'),
    {
      autoClickNextPage: false,
    },
  );
  await f.run();
  assert.equal(f.submits(), 0);
  assert.equal(f.phases.includes("page-complete"), true);
});

test("IForm clicks only the bottom Submit and leaves Save & Return Later alone", async (t) => {
  const f = fixture(
    t,
    '<input type="button" value="Save &amp; Return Later"><input type="button" value="Submit">' +
      field("First Name", '<input value="Existing" required>'),
    {
      buttons:
        '<input type="button" value="Save &amp; Return Later"><input type="button" value="Submit">',
    },
  );
  const clicked = [];
  f.root.addEventListener("click", (event) => clicked.push(event.target));
  await f.run();
  assert.deepEqual(clicked, [f.root.lastElementChild]);
  assert.equal(f.phases.includes("awaiting-transition"), true);
});

test("IForm radio questions retain their prompt instead of the first Yes caption", (t) => {
  const f = fixture(
    t,
    radio("Are you at least 18 years old?", "age") +
      radio("Have you worked for this Company before?", "prior"),
  );
  assert.deepEqual(
    Array.from(f.reader.scan(), (row) => row.public.question),
    [
      "Are you at least 18 years old?",
      "Have you worked for this Company before?",
    ],
  );
  assert.deepEqual(
    Array.from(f.reader.scan()[0].public.options, (option) => option.label),
    ["Yes", "No"],
  );
});

test("IForm education, employer, and reference captions cannot borrow applicant identity or address", async (t) => {
  const f = fixture(
    t,
    section(
      "EDUCATION",
      field("City", '<input id="school-city" required>') +
        field(
          "Country",
          '<select><option value=""></option><option>United States</option></select>',
        ),
    ) +
      section(
        "EMPLOYMENT RECORD",
        field("Address", '<input id="employer-address" required>'),
      ) +
      section(
        "PROFESSIONAL REFERENCES",
        field("First Name", '<input id="reference-name">'),
      ),
  );
  const rows = f.reader.scan();
  assert.deepEqual(
    Array.from(rows, (row) => row.public.question),
    [
      "EDUCATION — City",
      "EDUCATION — Country",
      "EMPLOYMENT RECORD — Address",
      "PROFESSIONAL REFERENCES — First Name",
    ],
  );
  await f.run();
  for (const id of ["school-city", "employer-address", "reference-name"])
    assert.equal(f.doc.getElementById(id).value, "");
  assert.equal(f.submits(), 0);
});

test("IForm segmented dates use the surrounding caption and keep incomplete precision unresolved", async (t) => {
  const f = fixture(t, section("EDUCATION", `<p>Start Date<br>${date}</p>`));
  const row = f.reader.scan()[0];
  assert.equal(row.public.question, "EDUCATION — Start Date");
  assert.equal(row.public.supported, true);
  assert.equal(row.public.type, "date");
  await f.run();
  assert.equal(f.doc.querySelector(".iCIMS_Forms_DayInput").value, "0");
  assert.equal(f.doc.querySelector(".iCIMS_Forms_YearInput").value, "");
});

test("IForm keeps entered answers and leaves an employment signature for confirmation", async (t) => {
  const f = fixture(
    t,
    field("First Name", '<input value="Existing" required>') +
      field(
        "Signature",
        '<input type="checkbox" id="icims_f_signature" class="iCIMS_Forms_Qsignature" aria-label="Signature" required>',
      ),
  );
  await f.run();
  assert.equal(
    f.doc.querySelector('input:not([type="checkbox"])').value,
    "Existing",
  );
  assert.equal(f.doc.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(f.submits(), 0);
});

test("IForm prefix reader does not borrow a prior field or change normal candidate labels", (t) => {
  const f = fixture(
    t,
    '<p>Previous question<span class="customFieldContainer"><input aria-label="Previous"></span><span class="customFieldContainer"><input id="unlabelled"></span></p>',
  );
  assert.equal(
    f.reader.scan().find((row) => row.node.id === "unlabelled").public
      .supported,
    false,
  );
  const regular = fixture(
    t,
    field("Decorative caption", '<input aria-label="Actual native label">'),
    { path: "/jobs/1/candidate" },
  );
  assert.equal(regular.reader.scan()[0].public.question, "Actual native label");
});

test("portal wrapper does not override its child with a manual-only status", async (t) => {
  const f = fixture(t, '<iframe id="icims_formFrame"></iframe>', {
    path: "/jobs/1/form",
  });
  await f.run();
  assert.equal(f.tasks.length, 0);
  assert.equal(f.phases.includes("complete-manually"), false);
});

test("an unrelated form at the forms endpoint does not start applicant autofill", async (t) => {
  const f = fixture(t, "<label>First name<input required></label>");
  await f.run();
  assert.equal(f.tasks.length, 0);
  assert.equal(f.doc.querySelector("input").value, "");
});

test("missing section headings do not turn a reference or unknown city into the applicant", async (t) => {
  const f = fixture(
    t,
    field("First Name", '<input aria-label="Ref1FirstName">') +
      field("City", "<input required>"),
  );
  assert.deepEqual(
    Array.from(f.reader.scan(), (row) => row.public.question),
    ["PROFESSIONAL REFERENCES — First Name", "IForm — City"],
  );
  await f.run();
  assert.equal(
    f.doc.querySelector('input[aria-label="Ref1FirstName"]').value,
    "",
  );
  assert.equal(f.doc.querySelector("input[required]").value, "");
});

test("nested IForm date wrappers retain the caption outside both wrappers", (t) => {
  const f = fixture(
    t,
    section(
      "EDUCATION",
      `<p>Start Date<br><span class="customFieldContainer">${date}</span></p>`,
    ),
  );
  const row = f.reader.scan()[0];
  assert.equal(row.public.question, "EDUCATION — Start Date");
  assert.equal(row.public.supported, true);
});
