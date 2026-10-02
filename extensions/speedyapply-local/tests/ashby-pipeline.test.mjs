import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { inspectAnswerers } from "./helpers/one-answerer.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "ashby-controls",
    "legacy-select-controls",
    "aria-controls",
    "form-pipeline",
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const shared = await Promise.all(
  ["dom-controls", "answer-helpers"].map((name) =>
    read("source/content/shared/" + name + ".js"),
  ),
);
const adapter = await read("source/content/adapters/ashby.js");
const profile = {
  profileName: "Fixture",
  nameData: { firstName: "Ada", lastName: "Lovelace" },
  contactData: { email: "ada@example.test", phoneNumber: "5550100" },
  addressData: {
    country: "United States",
    city: "Boston",
    state: "Massachusetts",
  },
  websiteData: { linkedin: "https://linkedin.example/ada" },
  educationData: [],
  jobData: [],
  employmentData: { eligibilityUS: true, sponsorship: false },
  resumeData: {},
};
const entry = (id, title, control) =>
  `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title" for="${id}">${title}</label>${control}</div>`;
const form = `<form aria-labelledby="job-application-form"><div class="ashby-application-form-section-container">
  ${entry("_systemfield_name", "Name *", '<input id="_systemfield_name" type="text" required>')}
  ${entry("_systemfield_email", "Email *", '<input id="_systemfield_email" type="email" required>')}
  ${entry("phone", "Phone", '<input id="phone" type="tel">')}
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">LinkedIn</label><input id="linkedin" type="text"></div>
  <fieldset class="ashby-application-form-field-entry"><legend class="ashby-application-form-question-title">Will you be able to work onsite? *</legend>
    <label><input type="radio" name="onsite" value="a" required>Yes, I am able to work onsite</label><label><input type="radio" name="onsite" value="b">No</label></fieldset>
  ${entry("why", "Why do you want to join? *", '<textarea id="why" required></textarea>')}
  <button type="submit" class="ashby-application-form-submit-button">Submit Application</button>
</div></form>`;

function fixture(t, saved = []) {
  const dom = new JSDOM("<!doctype html>" + form, {
      url: "https://jobs.ashbyhq.com/example/1b2c3d4e-0000-4000-8000-000000000000/application",
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  const requests = [],
    notes = [],
    traces = [],
    phases = [],
    stops = [];
  let submits = 0;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          requests.push(message);
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "The mission and the team.",
                source: "ai",
                reason: "fixture",
                needsConfirmation: false,
              })),
            },
          };
        }
        return {};
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace: (node, entry) => traces.push(entry),
    perform: (operation, target, run) => run(),
  };
  for (const code of [...scripts, ...shared]) w.eval(code);
  w.eval(adapter);
  installAnswerResolver(w, saved);
  const answerers = inspectAnswerers(w);
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  // Page chrome outside this pipeline; the location widget is absent here.
  Object.assign(w, {
    jobsReportJobTitle: async () => false,
    jobsMountManualAnswerControls: async () => {},
    jobsFormatCityRegion: (address) => address.city + ", " + address.state,
    jobsUploadResume: () => null,
  });
  doc.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  t.after(() => {
    w.jobsFindAllXPath = () => [w.document];
    for (const stop of stops) stop();
    w.close();
  });
  const run = (autoSubmit) =>
    w.ashbyRunApplication({
      setMessage: (message) => phases.push(message),
      getProfile: async () => profile,
      autofillSettings: {
        autoSubmit,
        saveResponses: false,
        saveApplications: false,
      },
      ctx: { onInvalidated: (stop) => stops.push(stop) },
    });
  const until = async (check, label) => {
    for (let i = 0; i < 250 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert(check(), label);
  };
  return {
    w,
    answerers,
    doc,
    requests,
    notes,
    traces,
    phases,
    run,
    until,
    submits: () => submits,
    value: (id) => doc.getElementById(id).value,
  };
}

const onsite = "Will you be able to work onsite?";
test("an Ashby form fills in one pipeline run: bindings, rule answers with the Yes/No policy, then AI for the gap", async (t) => {
  const f = fixture(t, [
    { question: onsite, response: "Yes", keywords: ["onsite"], appearances: 1 },
  ]);
  await f.run(false);
  await f.until(
    () => f.phases.includes("page-complete"),
    "the single run reaches page-complete",
  );
  assert.equal(f.value("_systemfield_name"), "Ada Lovelace");
  assert.equal(f.value("_systemfield_email"), "ada@example.test");
  assert.equal(f.value("phone"), "5550100");
  assert.equal(f.value("linkedin"), "https://linkedin.example/ada");
  assert.equal(
    f.doc.querySelector('input[name="onsite"]:checked')?.value,
    "a",
    "an exact saved Yes selects the unique Yes option",
  );
  assert.equal(f.value("why"), "The mission and the team.");
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.notes.filter((note) => note.type === "auto_step_started").length,
    1,
  );
  assert(
    f.traces.some(
      (entry) =>
        entry.source === "binding:name" && entry.result === "committed",
    ),
  );
  assert.equal(f.submits(), 0);
  f.answerers.check(f.doc.querySelector("form"));
});

test("with Auto-Submit the Ashby run submits once, without the old fixed delay", async (t) => {
  const f = fixture(t, [
    { question: onsite, response: "Yes", keywords: ["onsite"], appearances: 1 },
  ]);
  const start = Date.now();
  await f.run(true);
  await f.until(() => f.submits() > 0, "the run submits");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.submits(), 1);
  f.answerers.check(f.doc.querySelector("form"));
  assert.equal(
    f.notes.filter((note) => note.type === "auto_step_started").length,
    1,
  );
  assert(Date.now() - start < 4000);
});

test("Ashby optional keyword memory stays blank while the exact saved question fills", async (t) => {
  const f = fixture(t, [
    { question: onsite, response: "Yes", keywords: ["onsite"], appearances: 1 },
    { keywords: ["favorite"], response: "Python", appearances: 1 },
    {
      question: "Preferred team",
      keywords: ["team"],
      response: "Platform",
      appearances: 1,
    },
  ]);
  f.doc
    .querySelector(".ashby-application-form-section-container")
    .insertAdjacentHTML(
      "afterbegin",
      entry("favorite", "Favorite tool", '<input id="favorite">') +
        entry("team", "Preferred team", '<input id="team">'),
    );
  await f.run(false);
  await f.until(() => f.phases.includes("page-complete"), "form completes");
  assert.equal(f.value("favorite"), "");
  assert.equal(f.value("team"), "Platform");
  assert(
    f.requests.every((request) =>
      request.fields.every((field) => field.required),
    ),
  );
  f.answerers.check(f.doc.querySelector("form"));
});

test("manual Ashby refill uses the same single run without submitting", async (t) => {
  const f = fixture(t, [
    { question: onsite, response: "Yes", keywords: ["onsite"], appearances: 1 },
  ]);
  let refill;
  f.w.JobsPageSession = {
    setAutofill: (callback) => {
      refill = callback;
    },
  };
  await f.run(false);
  await f.until(
    () => f.phases.includes("page-complete"),
    "initial form completes",
  );
  f.doc.querySelector("#why").value = "";
  await refill();
  assert.equal(f.value("why"), "The mission and the team.");
  assert.equal(f.submits(), 0);
  assert.equal(
    f.notes.filter((note) => note.type === "auto_step_started").length,
    2,
  );
});
