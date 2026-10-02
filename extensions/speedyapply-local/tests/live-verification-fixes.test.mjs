import { readWithDependencies } from "./helpers/runtime-source.mjs";
// Regressions from the 2026-09-23 live verification (notes/archive/live-verification-2026-09-23.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const custom = Object.fromEntries(
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "option-match",
      "profile-answers",
      "repro-case",
      "diagnostics",
      "dom-wait",
      "control-fields",
      "operation-context",
      "control-content",
    ].map(async (name) => [name, await read("src/custom/" + name + ".js")]),
  ),
);
const history = await read("src/custom/history-background.js");

function page(html, url) {
  const dom = new JSDOM(
      '<form aria-labelledby="job-application-form">' + html + "</form>",
      { url, runScripts: "outside-only" },
    ),
    w = dom.window;
  w.TextEncoder = TextEncoder;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version_name: "test" }),
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "ng", profile: { profileName: "Newgrad" } } }
          : {},
      onMessage: { addListener() {} },
    },
  };
  for (const name of Object.keys(custom)) w.eval(custom[name]);
  const options = {
    autofillSettings: {},
    ctx: { onInvalidated() {} },
    getProfile: async () => ({ profileName: "Newgrad" }),
    setMessage() {},
  };
  async function eL(opts) {
    await opts.getProfile();
    return true;
  }
  Object.defineProperty(eL, "name", { value: "ashby" });
  const reader = () =>
    w.JobsControlFields.create(
      w.document,
      () => w.document.querySelector("form"),
      { write: true },
    );
  return {
    w,
    doc: w.document,
    reader,
    start: () =>
      w.JobsPageSession.run(eL, { ...options, jobsAdapterId: "ashby" }),
    close() {
      w.JobsDiagnostics.stop();
      dom.window.close();
    },
  };
}

test('JazzHR "No answer" (value 0) is an empty required answer, not a completed one', async () => {
  const h = page(
    `<label for="resumator-education-value">What's your highest level of education completed? *</label>
    <select id="resumator-education-value" class="form-control"><option value="0">No answer</option><option value="30">Some College</option>
    <option value="50">College - Bachelor of Arts</option><option value="60">College - Bachelor of Science</option></select>`,
    "https://smartlightanalytics.applytojob.com/apply/m8ElvgaNby/Jr-Data-Engineer",
  );
  try {
    const row = h.reader().scan()[0];
    assert.equal(row.public.required, true);
    assert.equal(row.public.filled, false);
    assert(!row.public.options.some((option) => option.label === "No answer"));
    assert.equal(h.reader().state().phase, "complete-required");
    // The adapter's semantic write replaces the placeholder instead of keeping it.
    await h.w.JobsControlFields.chooseSpec(h.doc.querySelector("select"), {
      tiers: [["Some College"]],
    });
    assert.equal(h.doc.querySelector("select").value, "30");
    // "Completed" education is its own confirmed fact, never a degree in progress.
    const answers = h.w.JobsProfileAnswers;
    assert.equal(
      answers.classify("What's your highest level of education completed?")
        .topic,
      "completed_education",
    );
    const labels = [
      "Some College",
      "College - Bachelor of Arts",
      "College - Bachelor of Science",
    ];
    assert.equal(
      answers.select(
        answers.resolve(
          "What's your highest level of education completed?",
          { applicationData: { highestCompletedEducation: "Some College" } },
          { options: labels },
        ),
        labels,
      ),
      "Some College",
    );
    assert.equal(
      answers.resolve(
        "What's your highest level of education completed?",
        {
          educationData: [{ degree: "Bachelor of Arts" }],
          applicationData: {},
        },
        { options: labels },
      )?.answer ?? null,
      null,
    );
  } finally {
    h.close();
  }
});

test("a real first option is never taken for a placeholder", () => {
  const h = page(
    '<label>Answer<select><option value="0">No</option><option value="1">Yes</option></select></label>',
    "https://example.applytojob.com/apply/x",
  );
  try {
    assert.equal(h.reader().scan()[0].public.filled, true);
  } finally {
    h.close();
  }
});

test("Ashby required questions marked only by the title class are required", () => {
  const h = page(
    `<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry">
      <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="auth">Are you authorized to work in the United States&nbsp; without restriction?</label>
      <div class="ashby-application-form-input-yesno"><button data-option="Yes">Yes</button><button data-option="No">No</button><input type="checkbox" id="auth" hidden></div></div>
    <div class="ashby-application-form-field-entry"><label class="_heading_f7cvd_52 ashby-application-form-question-title" for="nick">Nickname</label><input id="nick"></div>`,
    "https://jobs.ashbyhq.com/g2/64dcc04a-a0e7-493b-b899-dd4c56e561fd/application",
  );
  try {
    const rows = h.reader().scan();
    assert.equal(
      rows.find((row) => /authorized/.test(row.public.question)).public
        .required,
      true,
    );
    assert.equal(
      rows.find((row) => row.public.question === "Nickname").public.required,
      false,
    );
  } finally {
    h.close();
  }
});

test("Ashby and Greenhouse pages keep their own history; fill records mask contact data only", async () => {
  const ashby =
    "https://jobs.ashbyhq.com/g2/64dcc04a-a0e7-493b-b899-dd4c56e561fd/application";
  const h = page(
    '<label>Email<input type="email" id="email"></label><label>Start date<input id="start"></label>',
    ashby,
  );
  try {
    await h.start();
    const report = h.w.JobsDiagnostics.snapshot();
    assert.equal(
      report.pageUrl,
      ashby,
      "the job path is kept, the URL stays valid",
    );
    const reader = h.reader(),
      rows = reader.scan();
    await reader.apply(rows[0], "person@example.com", () => true, {
      source: "rule:profile",
    });
    await reader.apply(rows[1], "2027-05-17", () => true, {
      source: "rule:profile",
    });
    const fields = h.w.JobsDiagnostics.snapshot().fields;
    const email = fields.find((field) => field.question === "Email"),
      start = fields.find((field) => field.question === "Start date");
    assert(!JSON.stringify(email).includes("person@example.com"));
    assert.match(email.traces.at(-1).answer, /\[email\]/);
    assert.equal(start.value, "2027-05-17");
    assert.equal(start.traces.at(-1).answer, "2027-05-17");
    // Retained history: this posting's own entry, with ordered decision/write times.
    const local = {},
      session = {};
    const c = vm.createContext({
      URL,
      TextEncoder,
      console,
      crypto: webcrypto,
      chrome: {
        storage: {
          session: {
            get: async () => structuredClone(session),
            set: async (data) => Object.assign(session, structuredClone(data)),
          },
          local: {
            get: async () => structuredClone(local),
            set: async (data) => Object.assign(local, structuredClone(data)),
          },
        },
      },
    });
    vm.runInContext(history, c);
    await c.JobsDiagnosticHistory.capture(h.w.JobsDiagnostics.snapshot());
    const entry = (await c.JobsDiagnosticHistory.pending(300000)).items[0];
    assert.equal(entry.url, ashby);
    const kept = entry.snapshots
      .at(-1)
      .fields.find((field) => field.question === "Start date");
    assert.equal(kept.trace.source, "rule:profile");
    assert(Number.isInteger(kept.trace.at));
  } finally {
    h.close();
  }
  const greenhouse = page(
    "<label>Name<input></label>",
    "https://job-boards.greenhouse.io/singlestore/jobs/8220863",
  );
  try {
    await greenhouse.start();
    assert.equal(
      greenhouse.w.JobsDiagnostics.snapshot().pageUrl,
      "https://job-boards.greenhouse.io/singlestore/jobs/8220863",
    );
  } finally {
    greenhouse.close();
  }
});

test("a supplement or remote write records the options it chose from and its readback", async () => {
  const h = page(
    '<label>Willing to relocate to NYC?<select id="q"><option value="">Select...</option><option value="y">Yes</option><option value="n">No</option></select></label>',
    "https://job-boards.greenhouse.io/acme/jobs/4114318009",
  );
  try {
    await h.start();
    const reader = h.reader(),
      row = reader.scan()[0];
    await reader.apply(row, "y", () => true, {
      source: "ai:profile",
      reason: "Profile states willingness",
    });
    const trace = h.w.JobsDiagnostics.snapshot().fields[0].traces.find(
      (item) => item.source === "ai:profile",
    );
    assert.deepEqual([...trace.options], ["Yes", "No"]);
    assert.match(trace.method, /exact/);
    assert.equal(trace.chosen, "Yes");
    await reader.apply(reader.scan()[0], "n", () => true, {
      source: "remote",
      replace: true,
    });
    assert.equal(
      h.w.JobsDiagnostics.snapshot().fields[0].traces.at(-1).readback,
      "No",
    );
  } finally {
    h.close();
  }
});
