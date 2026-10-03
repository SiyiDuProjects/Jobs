import { readModule } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const read = (name) =>
  readWithDependencies(
    new URL("../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const scanner = await Promise.all(
  ["dom-wait", "option-match", "control-fields", "aria-controls"].map(read),
);
const diagnostics = await Promise.all(
  [
    "job-match-rules",
    "job-match",
    "repro-case",
    "diagnostics",
    "control-fields",
    "operation-context",
    "control-content",
  ].map(read),
);
const historySource = await readWithDependencies(
  new URL("../src/custom/history-background.js", import.meta.url),
  "utf8",
);

function reader(body, url = "https://careers.example.test/apply") {
  const dom = new JSDOM("<!doctype html><form>" + body + "</form>", {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window;
  for (const source of scanner) w.eval(source);
  const fields = w.JobsControlFields.create(w.document, () =>
    w.document.querySelector("form"),
  );
  return {
    w,
    fields,
    found: () =>
      JSON.parse(
        JSON.stringify(fields.unrecognized().map(({ node, ...item }) => item)),
      ),
    close: () => w.close(),
  };
}

test("a required question rendered by an unknown widget is reported with its structure, never its value", () => {
  const h =
    reader(`<div class="row"><label for="name">Full name *</label><input id="name" required></div>
    <div class="question"><div class="title">Preferred shift <span class="required">*</span></div>
      <div class="shift-picker" data-choice="night"><div class="chip selected">Night shift</div><div class="chip">Day shift</div></div></div>`);
  try {
    const found = h.found();
    assert.equal(found.length, 1);
    assert.equal(found[0].question, "Preferred shift");
    assert.equal(found[0].reason, "required-title-without-field");
    assert.match(found[0].structure, /div\.shift-picker/);
    assert.match(found[0].structure, /div\.chip\.selected/);
    assert.doesNotMatch(found[0].structure, /Night shift|night/);
  } finally {
    h.close();
  }
});

test("an interactive element no reader owns is reported; a hidden native select behind a custom widget too", () => {
  const h =
    reader(`<div class="field"><span id="sw-label">Open to relocation</span><div role="switch" aria-labelledby="sw-label" aria-checked="false" tabindex="0"></div></div>
    <div class="field"><label for="country">Country *</label><select id="country" hidden><option>US</option></select>
      <div class="fancy-select" tabindex="0"><span>Choose…</span></div></div>`);
  try {
    const found = h.found();
    assert.deepEqual(
      found.map((item) => [item.question, item.reason]),
      [
        ["Open to relocation", "interactive-without-field"],
        ["Country", "required-title-without-field"],
      ],
    );
    assert.match(found[1].structure, /select \(hidden\)/);
  } finally {
    h.close();
  }
});

test("a read-only review summary is not a page of missed questions; an unknown control on it still is", () => {
  // RTX Workday Review step: required titles followed by the given answers, no fields.
  const summary =
    `<div data-automation-id="applyFlowReviewPage">` +
    [
      "Are you a citizen of the United States?",
      "Did you previously work for RTX?",
    ]
      .map(
        (title) =>
          `<div class="css-7t35fz"><div class="css-f6y8ld"><div class="css-1gj0xqm"><p>${title}*</p></div></div><div class="css-233int"><span class="css-1ccsoih">Yes</span></div></div>`,
      )
      .join("") +
    "</div>";
  const h = reader(summary, "https://fixture.myworkdayjobs.com/apply");
  try {
    assert.deepEqual(h.found(), []);
  } finally {
    h.close();
  }
  const unknown = reader(
    summary +
      '<div class="question"><p>Start date *</p><div class="picker" role="spinbutton" tabindex="0"></div></div>',
    "https://fixture.myworkdayjobs.com/apply",
  );
  try {
    const found = unknown.found();
    assert.equal(found.length >= 1, true);
    assert(found.some((item) => item.reason === "interactive-without-field"));
  } finally {
    unknown.close();
  }
});

test("scanned fields, file uploads, secrets and extension UI are not reported", () => {
  const h =
    reader(`<div class="field"><label for="email">Email *</label><input id="email" type="email" required></div>
    <div class="field"><label>Resume/CV *</label><input type="file" hidden><button type="button">Attach</button></div>
    <div class="field"><label>Password *</label><input type="password" required></div>
    <fieldset><legend>Work authorization *</legend><label><input type="radio" name="auth" value="y">Yes</label><label><input type="radio" name="auth" value="n">No</label></fieldset>
    <div id="jobs-ai-review"><div class="card"><div>Answer needed *</div><div role="switch" tabindex="0"></div></div></div>
    <div class="file-upload" role="group" aria-required="true"><div class="label upload-label">Resume/CV<span class="required">*</span></div>
      <div class="file-upload__wrapper"><div class="file-upload__filename"><p>resume.pdf</p><button type="button">Remove</button></div></div></div>
    <div class="field"><label>Profile summary *</label><div class="profile-editor" tabindex="0"></div></div>`);
  try {
    assert.deepEqual(
      h.found().map((item) => item.question),
      ["Profile summary"],
      'an attached upload is not reported; a "profile" class is not an upload',
    );
  } finally {
    h.close();
  }
});

test("the diagnostics report and retained history carry unrecognized questions", async () => {
  const dom = new JSDOM(
    `<form aria-labelledby="job-application-form"><label>Summary<input required></label>
    <div class="q"><div class="t">Preferred shift *</div><div class="picker"><div class="chip">Night</div></div></div></form>`,
    {
      url: "https://jobs.ashbyhq.com/example/test/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version_name: "local.1" }),
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "ng", profile: { profileName: "Newgrad" } } }
          : {},
      onMessage: { addListener() {} },
    },
  };
  for (const source of diagnostics) w.eval(source);
  try {
    async function eL(options) {
      await options.getProfile();
      options.setMessage("autofill-complete");
    }
    await w.JobsPageSession.run(eL, {
      jobsAdapterId: "ashby",
      autofillSettings: {},
      ctx: { onInvalidated() {} },
      getProfile: async () => ({ profileName: "Newgrad" }),
      setMessage() {},
    });
    const report = JSON.parse(JSON.stringify(w.JobsDiagnostics.snapshot()));
    assert.deepEqual(
      report.unansweredContainers.map((item) => [item.question, item.reason]),
      [["Preferred shift", "required-title-without-field"]],
    );
    const local = {},
      context = vm.createContext({
        URL,
        TextEncoder,
        console,
        crypto: webcrypto,
        chrome: {
          storage: {
            session: { get: async () => ({}), set: async () => {} },
            local: {
              get: async () => structuredClone(local),
              set: async (data) => Object.assign(local, structuredClone(data)),
            },
          },
        },
      });
    vm.runInContext(historySource, context);
    await context.JobsDiagnosticHistory.capture(report);
    const snapshot = (await context.JobsDiagnosticHistory.pending(300000))
      .items[0].snapshots[0];
    assert.equal(snapshot.unrecognized[0].question, "Preferred shift");
    assert.match(snapshot.unrecognized[0].structure, /div\.picker/);
    assert.doesNotMatch(JSON.stringify(snapshot.unrecognized), /Night/);
  } finally {
    w.JobsDiagnostics.stop();
    w.close();
  }
});
