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
    "greenhouse-controls",
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
  ["dom-controls", "answer-helpers", "response-capture"].map((name) =>
    read("source/content/shared/" + name + ".js"),
  ),
);
const adapter = await read("source/content/adapters/greenhouse.js");
const profile = {
  profileName: "Fixture",
  nameData: { firstName: "Ada", lastName: "Lovelace", preferredName: false },
  contactData: { email: "ada@example.test", phoneNumber: "5550100" },
  addressData: {
    country: "United States",
    city: "Boston",
    state: "Massachusetts",
  },
  educationData: [
    {
      school: "Example University",
      degree: "Bachelor of Science",
      fieldOfStudy: "Physics",
      startDate: "2021-09",
      endDate: "2025-05",
    },
    {
      school: "Second University",
      degree: "Master of Science",
      fieldOfStudy: "Physics",
      startDate: "2025-09",
      endDate: "2027-05",
    },
  ],
  jobData: [],
  employmentData: { eligibilityUS: true, sponsorship: false },
  websiteData: {},
  resumeData: {},
};
const form = `<form id="application-form">
  <div class="application--questions">
    <div><label for="first_name">First Name*</label><input id="first_name" aria-required="true"></div>
    <div><label for="last_name">Last Name*</label><input id="last_name" aria-required="true"></div>
    <div><label for="preferred_name">Preferred First Name</label><input id="preferred_name" value="Existing"></div>
    <div><label for="email">Email*</label><input id="email" type="email" aria-required="true"></div>
    <div><label for="phone">Phone</label><input id="phone" type="tel"></div>
  </div>
  <div class="education--container"><div class="education--form"><label for="start-year--0">Start year</label><input id="start-year--0"></div>
    <button type="button" class="add-another-button">Add another</button></div>
  <div class="application--questions">
    <div><label id="question_1-label" for="question_1">Are you authorized to work in the United States?*</label>
      <select id="question_1" aria-required="true"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
    <div><label id="question_2-label" for="question_2">What excites you about this role?*</label><textarea id="question_2" aria-required="true"></textarea></div>
    <div><label id="question_3-label" for="question_3">Website</label><input id="question_3"></div>
  </div>
  <input type="file" id="resume" hidden>
  <div class="application--submit"><button type="submit">Submit application</button></div>
</form>`;

function fixture(
  t,
  {
    html = form,
    url = "https://job-boards.greenhouse.io/example/jobs/1",
    resume = {},
    uploadConfirms = true,
    saved = [],
  } = {},
) {
  const dom = new JSDOM("<!doctype html>" + html, {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  // Release the adapter's open-ended error watcher before closing the page.
  t.after(() => {
    w.jobsFindAllXPath = () => [w.document];
    w.close();
  });
  const requests = [],
    notes = [],
    traces = [],
    phases = [],
    current = { ...profile, resumeData: resume };
  let submits = 0;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile: current } };
        if (message.type === "jobs:auto-answers") {
          requests.push(message);
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "The team and its problems.",
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
  // Page chrome and the upstream date library are outside this pipeline.
  const uploads = [],
    captures = [];
  Object.assign(w, {
    jobsReportJobTitle: async () => false,
    jobsCaptureResponsesOnUnload: (selector, read) => captures.push(read),
    jobsMountManualAnswerControls: async () => {},
    jobsWatchXPathPresence: () => {},
    jobsFormatProfileMonth: (month, format) =>
      format === "yyyy" ? month.slice(0, 4) : month,
    jobsFormatCityRegion: (address) => address.city + ", " + address.state,
    // The page shows the attached file name only when the upload is accepted.
    jobsUploadResume: (file, selector) => {
      uploads.push(selector);
      if (uploadConfirms)
        doc
          .getElementById("resume")
          ?.insertAdjacentHTML(
            "afterend",
            '<div aria-labelledby="upload-label-resume"><div class="file-upload__filename">resume.pdf</div></div>',
          );
    },
  });
  // Upload confirmation waits up to 30 s on a real page; keep fixtures fast.
  const wait = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options = {}) =>
    wait(read, {
      ...options,
      timeout: options.timeout == null ? null : Math.min(options.timeout, 600),
    });
  doc
    .querySelector(".add-another-button")
    ?.addEventListener("click", () =>
      doc
        .querySelector(".add-another-button")
        .insertAdjacentHTML(
          "beforebegin",
          '<div class="education--form"><label for="start-year--1">Start year</label><input id="start-year--1"></div>',
        ),
    );
  doc.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  const run = (autoSubmit, saveResponses = false) =>
    w.greenhouseRunApplication({
      setMessage: (message) => phases.push(message),
      getProfile: async () => current,
      autofillSettings: { autoSubmit, saveResponses, saveApplications: false },
      ctx: {},
    });
  const until = async (check, label) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert(check(), label);
  };
  return {
    answerers,
    captures,
    w,
    doc,
    requests,
    notes,
    traces,
    phases,
    uploads,
    run,
    until,
    submits: () => submits,
    value: (id) => doc.getElementById(id).value,
  };
}

test("Greenhouse job boards fill in one pipeline run: bindings, history rows, rule answers, then AI for the required gap", async (t) => {
  const f = fixture(t);
  await f.run(false);
  await f.until(
    () => f.phases.includes("page-complete"),
    "the single run reaches page-complete",
  );
  assert.equal(f.value("first_name"), "Ada");
  assert.equal(f.value("last_name"), "Lovelace");
  assert.equal(f.value("email"), "ada@example.test");
  assert.equal(f.value("phone"), "5550100");
  assert.equal(
    f.value("preferred_name"),
    "Existing",
    "an existing answer is kept",
  );
  assert.equal(f.value("start-year--0"), "2021");
  assert.equal(
    f.value("start-year--1"),
    "2025",
    "a second history row is added and filled",
  );
  assert.equal(
    f.value("question_1"),
    "Yes",
    "a question answered by Profile rule",
  );
  assert.equal(
    f.value("question_2"),
    "The team and its problems.",
    "only the required gap goes to AI",
  );
  assert.equal(
    f.value("question_3"),
    "",
    "an optional question without a rule stays empty",
  );
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(f.requests[0].fields.map((field) => field.question)),
    ),
    ["What excites you about this role?*"],
  );
  assert.equal(
    f.notes.filter((note) => note.type === "auto_step_started").length,
    1,
    "fill, rules, AI and checks are one run",
  );
  assert(
    f.traces.some(
      (entry) =>
        entry.source === "binding:first-name" && entry.result === "committed",
    ),
  );
  assert(
    f.traces.some(
      (entry) =>
        entry.source === "rule:profile" &&
        entry.result === "committed" &&
        entry.chosen === "Yes",
    ),
  );
  assert.equal(f.submits(), 0, "fill-only never submits");
  f.answerers.check(f.doc.querySelector("form"));
});

test("with Auto-Submit the same run submits once after every field is filled", async (t) => {
  const f = fixture(t);
  await f.run(true);
  await f.until(() => f.submits() > 0, "the run submits");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.submits(), 1);
  for (const id of [
    "first_name",
    "last_name",
    "email",
    "question_1",
    "question_2",
  ])
    assert.notEqual(f.value(id), "", id + " filled before submit");
  assert.equal(
    f.notes.filter((note) => note.type === "auto_step_started").length,
    1,
  );
});

const resume = { resumeBase64: "JVBERg==", fileName: "resume.pdf" };
test("an upload that is never confirmed holds the step: rules and AI still run, nothing is submitted", async (t) => {
  const f = fixture(t, { resume, uploadConfirms: false });
  await f.run(true);
  await f.until(
    () => f.phases.includes("complete-manually"),
    "the step ends for manual handling",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(f.uploads)), ["#resume"]);
  assert.equal(f.value("question_1"), "Yes");
  assert.equal(f.value("question_2"), "The team and its problems.");
  assert.equal(f.requests.length, 1, "AI still answers the required gap");
  assert(
    f.notes.some(
      (note) =>
        note.type === "auto_navigation_held" &&
        note.detail === "resume_upload_unconfirmed",
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.submits(), 0, "an unconfirmed upload never submits");
});
test("a confirmed upload continues to one submit; a Profile without a resume skips the upload", async (t) => {
  const f = fixture(t, { resume });
  await f.run(true);
  await f.until(() => f.submits() > 0, "the confirmed step submits");
  assert.deepEqual(JSON.parse(JSON.stringify(f.uploads)), ["#resume"]);
  const g = fixture(t, { resume: {} });
  await g.run(false);
  await g.until(() => g.phases.includes("page-complete"), "no resume, no hold");
  assert.equal(g.uploads.length, 0);
  assert(g.notes.some((note) => note.type === "auto_upload_skipped"));
});
const legacy = `<div id="application"><form id="application_form">
  <div class="field"><label for="first_name">First Name *</label><input id="first_name" aria-required="true"></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" aria-required="true"></div>
  <div class="field"><label for="email">Email *</label><input id="email" aria-required="true"></div>
  <div class="field"><label for="phone">Phone</label><input id="phone"></div>
  <div id="education_section"><div class="education">
    <label for="education_degree_0">Degree</label><select id="education_degree_0"><option value="">--</option><option>Bachelor's Degree</option><option>Master's Degree</option></select>
    <label for="education_discipline_0">Discipline</label><select id="education_discipline_0"><option value="">--</option><option>Physics</option></select>
    <label>Start month<input type="text" class="month start-date-month"></label><label>Start year<input type="text" class="year start-date-year"></label>
  </div></div>
  <div id="custom_fields">
    <div class="field"><label>Are you authorized to work in the United States? *<select aria-required="true"><option value="">--</option><option>Yes</option><option>No</option></select></label></div>
    <div class="field"><label>Why this company? *<textarea aria-required="true"></textarea></label></div>
  </div>
  <label for="job_application_gender">Gender</label><select id="job_application_gender"><option value="">--</option><option>Male</option><option>Female</option><option>Decline To Self Identify</option></select>
  <input type="submit" id="submit_app" value="Submit Application">
</form></div>`;
test("the legacy boards form runs as the same single pipeline", async (t) => {
  const f = fixture(t, {
    html: legacy,
    url: "https://boards.greenhouse.io/example/jobs/1",
  });
  profile.employmentData.gender = "Male";
  try {
    await f.run(false);
    await f.until(
      () => f.phases.includes("page-complete"),
      "the legacy run completes",
    );
    assert.equal(f.value("first_name"), "Ada");
    assert.equal(f.value("email"), "ada@example.test");
    const doc = f.doc;
    assert.equal(doc.getElementById("education_discipline_0").value, "Physics");
    assert.equal(doc.querySelector(".start-date-month").value, "9");
    assert.equal(doc.querySelector(".start-date-year").value, "2021");
    assert.equal(doc.querySelector("#custom_fields select").value, "Yes");
    assert.equal(
      doc.querySelector("#custom_fields textarea").value,
      "The team and its problems.",
    );
    assert.equal(doc.getElementById("job_application_gender").value, "Male");
    assert.equal(
      f.notes.filter((note) => note.type === "auto_step_started").length,
      1,
    );
    assert(f.traces.some((entry) => entry.source === "binding:degree"));
    f.answerers.check(f.doc.querySelector("form"));
  } finally {
    delete profile.employmentData.gender;
  }
});

for (const old of [false, true])
  test(
    "Greenhouse " +
      (old ? "legacy" : "new") +
      " capture excludes rule/binding answers and saves only manual responses",
    async (t) => {
      const f = fixture(t, {
        html: old ? legacy : form,
        url: old
          ? "https://boards.greenhouse.io/example/jobs/1"
          : "https://job-boards.greenhouse.io/example/jobs/1",
      });
      const block = f.doc.querySelector(
        old
          ? "#custom_fields"
          : ".application--questions + .education--container + .application--questions",
      );
      block.insertAdjacentHTML(
        "beforeend",
        '<div class="field"><label id="question_manual-label" for="question_manual">Office preference (optional)</label><input id="question_manual"></div>',
      );
      await f.run(false, true);
      await f.until(() => f.phases.includes("page-complete"), "fill completes");
      f.answerers.check(f.doc.querySelector("form"));
      const handlers = {},
        captured = [];
      const add = f.doc.addEventListener.bind(f.doc);
      f.doc.addEventListener = (type, listener, ...args) => {
        handlers[type] = listener;
        return add(type, listener, ...args);
      };
      f.w.JobsPageSession = { profile: () => profile };
      f.w.JobsAnswerMemory.start(
        f.doc,
        true,
        (rows) => captured.push(...rows),
        () => f.doc.querySelector("form"),
      );
      f.doc.querySelector("#question_manual").value = "A manual answer";
      for (const target of f.doc.querySelectorAll(
        "input:not([type]),textarea,select",
      ))
        handlers.change({ type: "change", isTrusted: true, target });
      f.w.JobsAnswerMemory.flush();
      await Promise.resolve();
      assert(captured.some((item) => item.response === "A manual answer"));
      assert(
        !captured.some((item) =>
          ["Yes", "Ada", "2021"].includes(item.response),
        ),
      );
    },
  );

test("legacy demographic bindings use the shared unique-option rules once", async (t) => {
  const html = legacy.replace(
    '<div id="custom_fields">',
    '<div id="demographic_questions"><div class="field"><label>Gender</label><label><input type="radio" name="gender" value="Male">Male</label><label><input type="radio" name="gender" value="Female">Female</label></div><div class="field"><label>Ethnicity</label><label><input type="checkbox" name="ethnic" value="Asian">Asian</label><label><input type="checkbox" name="ethnic" value="Asian alternative">Asian alternative</label></div></div><div id="custom_fields">',
  );
  const f = fixture(t, {
    html,
    url: "https://boards.greenhouse.io/example/jobs/1",
  });
  Object.assign(profile.employmentData, {
    gender: "Female",
    ethnicity: "Asian",
  });
  try {
    await f.run(false);
    await f.until(
      () => f.phases.includes("page-complete"),
      "demographics completes",
    );
    assert.deepEqual(
      [...f.doc.querySelectorAll("#demographic_questions input:checked")].map(
        (node) => node.value,
      ),
      ["Female", "Asian"],
    );
    f.answerers.check(f.doc.querySelector("form"));
  } finally {
    delete profile.employmentData.gender;
    delete profile.employmentData.ethnicity;
  }
});
