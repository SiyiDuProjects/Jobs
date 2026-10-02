import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const read = (name) =>
  readWithDependencies(new URL("../" + name, import.meta.url), "utf8");
const codes = await Promise.all(
  [
    "dom-wait",
    "control-fields",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const adapter = await read("source/content/adapters/breezy.js");
const shared = await read("source/content/shared/dom-controls.js");
const capture = await read("source/content/shared/response-capture.js");
const question = `<div class="questionnaire-section"><li class="question"><div><h3>What excites you about Lava?<span>*</span></h3><textarea name="motivation" required></textarea></div></li><li class="question"><div class="multiplechoice"><h3>Are you willing to work onsite in New York City 4-5 days a week?<span>*</span></h3><ul class="options"><li class="option"><input type="checkbox" name="onsite" required><span>Yes</span></li><li class="option"><input type="checkbox" name="onsite" required><span>No</span></li></ul></div></li></div>`;
function fixture(t, html = question) {
  const attached =
    '<div class="file-input-container"><input name="cResume" type="file" hidden><a ng-if="candidate.resume.file_name">Fixture.pdf</a></div><div class="resume"><span ng-if="!uploadingResume && candidate.resume.file_name">Attached</span></div>';
  const dom = new JSDOM(
    '<style>.ng-hide{display:none}</style><div class="application-container">' +
      html +
      attached +
      '<button ng-click="apply()">提交申请</button></div>',
    {
      url: "https://fixture.breezy.hr/p/example/apply",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = w.document,
    root = doc.querySelector(".application-container");
  const profile = {
    profileName: "Intern",
    employmentData: {},
    contactData: { email: "test@example.com", phoneNumber: "5555550100" },
    nameData: {},
    addressData: {
      line1: "Street",
      city: "City",
      postalCode: "12345",
      country: "US",
    },
    jobData: [],
    educationData: [],
  };
  let submits = 0,
    aiCalls = 0;
  const events = [];
  w.JobsDiagnostics = {
    note: (...args) => events.push(args),
    perform: (_type, _node, run) => run(),
  };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "intern", profile } };
        aiCalls++;
        return {
          data: {
            answers: message.fields.map((f) => ({
              fieldId: f.fieldId,
              state: "needs_input",
              value: null,
              reason: "No confirmed answer",
            })),
          },
        };
      },
    },
  };
  w.JobsControlConfig = { enabled: false };
  w.JobsAnswerMemory = { remember() {}, confirmReview() {} };
  codes.forEach((code) => w.eval(code));
  w.eval(shared);
  w.jobsReportJobTitle = async () => false;
  w.eval(capture);
  w.eval(adapter);
  const reader = w.JobsControlFields.create(doc, () => root, { write: true });
  doc.querySelector("button").onclick = () => submits++;
  return {
    w,
    doc,
    root,
    reader,
    profile,
    events,
    submits: () => submits,
    aiCalls: () => aiCalls,
  };
}
test("Breezy question headings and checkbox options become one answerable group", async (t) => {
  const f = fixture(t);
  const rows = f.reader.scan();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].public.question, "What excites you about Lava?");
  assert.equal(rows[1].public.type, "select-multiple");
  assert.deepEqual(
    Array.from(rows[1].public.options, (o) => o.label),
    ["Yes", "No"],
  );
  assert.ok(
    rows.every(
      (r) => r.public.supported && f.w.JobsControlFields.needsAnswer(r.public),
    ),
  );
  await f.reader.apply(rows[1], [rows[1].public.options[0].value]);
  const after = f.reader.scan()[1];
  assert.equal(after.public.invalid, false);
  assert.deepEqual(
    Array.from(f.doc.querySelectorAll("[name=onsite]"), (e) => e.checked),
    [true, false],
  );
  f.doc.querySelectorAll("[name=onsite]")[1].checked = true;
  assert.equal(
    f.reader.scan()[1].public.invalid,
    true,
    "Conflicting Yes/No cannot pass readiness",
  );
});
test("normal automatic pipeline uses saved answers then clicks localized submit once without AI", async (t) => {
  const f = fixture(t);
  const result = await f.w.JobsAutomatic.advance({
    root: f.root,
    profile: f.profile,
    action: "submit",
    target: f.doc.querySelector("button"),
    resolveAnswers: async (questions) =>
      questions.map((q, index) => ({
        index,
        status: "answered",
        answer: q.options?.length
          ? "Yes"
          : "A previously confirmed motivation.",
        source: "saved",
        reason: "exact",
      })),
  });
  assert.equal(result, true, JSON.stringify(f.events));
  assert.equal(f.submits(), 1);
  assert.equal(f.aiCalls(), 0);
});
test("missing answers and visible Breezy errors prevent automatic submission", async (t) => {
  const f = fixture(t);
  assert.equal(
    await f.w.JobsAutomatic.advance({
      root: f.root,
      profile: f.profile,
      action: "submit",
      target: f.doc.querySelector("button"),
      resolveAnswers: async () => [],
    }),
    false,
  );
  assert.equal(f.submits(), 0);
  f.doc.querySelector("textarea").value = "Existing answer";
  f.doc.querySelector("input").checked = true;
  f.root.insertAdjacentHTML(
    "beforeend",
    '<div class="error-container"><span class="error">请检查答案</span></div>',
  );
  assert.equal(f.reader.state().ready, false);
});
test("adapter preserves existing contact values and produces summary from profile before automatic submission", async (t) => {
  const f = fixture(
    t,
    '<input name="cName" aria-label="Name"><input name="cEmail" aria-label="Email" value="kept@example.com"><input name="cPhoneNumber" aria-label="Phone"><input name="cAddress" aria-label="Address"><textarea name="cSummary" required></textarea>',
  );
  f.w.jobsFormatFullName = () => "Test Person";
  f.profile.jobData = [
    { company: "Example", jobTitle: "Engineer", description: "Built tools." },
  ];
  await f.w.breezyFillApplication(f.profile);
  assert.equal(f.doc.querySelector("[name=cEmail]").value, "kept@example.com");
  assert.equal(f.doc.querySelector("[name=cPhoneNumber]").value, "5555550100");
  assert.equal(
    f.doc.querySelector("[name=cSummary]").value,
    "Engineer at Example\nBuilt tools.",
  );
  f.w.breezyUploadResume = async () => true;
  f.w.breezyFillEmploymentHistory = async () => {};
  f.w.breezyFillEducationHistory = async () => {};
  f.w.breezyFillDisclosures = async () => {};
  f.w.jobsMountManualAnswerControls = async () => {};
  await f.w.breezyRunApplication({
    getProfile: async () => f.profile,
    setMessage() {},
    autofillSettings: { autoSubmit: true },
    ctx: {},
  });
  assert.equal(f.submits(), 1, JSON.stringify(f.events));
  assert.equal(f.aiCalls(), 0);
});
test("autoSubmit off fills required gaps without clicking Submit", async (t) => {
  const f = fixture(
    t,
    '<input name="cName" aria-label="Name"><input name="cEmail" aria-label="Email"><input name="cPhoneNumber" aria-label="Phone"><input name="cAddress" aria-label="Address">',
  );
  f.w.jobsFormatFullName = () => "Test Person";
  f.w.breezyUploadResume = async () => true;
  f.w.breezyFillEmploymentHistory = async () => {};
  f.w.breezyFillEducationHistory = async () => {};
  f.w.breezyFillDisclosures = async () => {};
  f.w.jobsMountManualAnswerControls = async () => {};
  await f.w.breezyRunApplication({
    getProfile: async () => f.profile,
    setMessage() {},
    autofillSettings: { autoSubmit: false },
    ctx: {},
  });
  assert.equal(f.submits(), 0);
  assert.equal(f.doc.querySelector("[name=cEmail]").value, "test@example.com");
});
test("localized history keeps parsed entries and dates, only repairing matching empty fields", async (t) => {
  const f = fixture(
    t,
    `<ul><li ng-repeat="candidatePosition in candidate.work_history"><input ng-model="candidatePosition.company_name" value="Example"><input ng-model="candidatePosition.title"><textarea ng-model="candidatePosition.summary">Keep original description</textarea><input type="date" value="2026-05-01"></li></ul><a ng-click="e.preventDefault(); addPosition()">添加职位</a>`,
  );
  f.doc.querySelector("a").onclick = () =>
    assert.fail("Existing history must not be recreated");
  await f.w.breezyFillEmploymentHistory([
    { company: "Example", jobTitle: "Engineer", description: "Replacement" },
  ]);
  assert.equal(
    f.doc.querySelector('[ng-model="candidatePosition.title"]').value,
    "Engineer",
  );
  assert.equal(
    f.doc.querySelector("textarea").value,
    "Keep original description",
  );
  assert.equal(f.doc.querySelector("[type=date]").value, "2026-05-01");
});
test("multi-section Breezy advances through current visible page before submitting once", async (t) => {
  const f = fixture(
    t,
    '<section id="first"><label>Name<input required value="Existing name"></label><button ng-click="nextSection()">继续</button></section><section id="last" style="display:none"><label>Answer<input required value="Confirmed answer"></label></section>',
  );
  const submit = f.doc.querySelector('[ng-click="apply()"]');
  submit.style.display = "none";
  let nextCount = 0;
  // Fixture's first button is Next; install the distinct final action explicitly.
  submit.onclick = () => {
    nextCount += 100;
  };
  f.doc.querySelector('[ng-click="nextSection()"]').onclick = () => {
    nextCount++;
    f.doc.querySelector("#first").style.display = "none";
    f.doc.querySelector("#last").style.display = "block";
    submit.style.display = "block";
  };
  for (const name of [
    "breezyFillContact",
    "breezyFillEmploymentHistory",
    "breezyFillEducationHistory",
    "breezyFillDisclosures",
    "jobsMountManualAnswerControls",
  ])
    f.w[name] = async () => {};
  f.w.breezyUploadResume = async () => true;
  await f.w.breezyRunApplication({
    getProfile: async () => f.profile,
    setMessage() {},
    autofillSettings: { autoSubmit: true, autoClickNextPage: true },
    ctx: {},
  });
  assert.equal(nextCount, 101);
  assert.equal(f.aiCalls(), 0);
});
