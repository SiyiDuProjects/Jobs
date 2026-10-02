import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const adapter = await readWithDependencies(
  new URL("../source/content/adapters/breezy.js", import.meta.url),
  "utf8",
);
const wait = await readWithDependencies(
  new URL("../src/custom/dom-wait.js", import.meta.url),
  "utf8",
);
const fields = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const tick = () => new Promise(setImmediate);

function fixture(t) {
  // Structural attributes captured read-only from Lava; no applicant data.
  const dom = new JSDOM(
    `<style>.ng-hide { display:none }</style>
    <div class="application-container">
      <a class="button resume"><div ng-if="!uploadingResume && !candidate.resume.file_name">Upload Resume</div></a>
      <div class="file-input-container">
        <input name="cResume" type="file" style="display:none">
        <div class="error-container ng-hide"><span>File attachment limit is 50MB</span></div>
      </div>
    </div>`,
    {
      url: "https://fixture.breezy.hr/p/test/apply",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = w.document,
    messages = [],
    calls = [],
    timers = new Map();
  let nextTimer = 0,
    uploads = 0,
    onUpload = () => {};
  w.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.eval(wait);
  w.eval(fields);
  w.eval(adapter);
  w.jobsUploadResume = () => {
    uploads++;
    return onUpload();
  };
  w.jobsWaitForCssNodes = async () => [
    doc.querySelector(".application-container"),
  ];
  w.jobsWaitForXPathNodes = () => {
    throw Error("Resume must not wait on English text");
  };
  w.jobsTrackApplicationOnUnload = async () => calls.push("track-application");

  w.JobsAutomatic = {
    advance: async () => {
      calls.push("advance");
      return false;
    },
  };
  for (const name of [
    "jobsMountManualAnswerControls",
    "breezyTrackApplication",
  ]) {
    w[name] = async () => calls.push(name);
  }
  const context = { isInvalid: false };
  return {
    w,
    doc,
    messages,
    calls,
    context,
    timers,
    get uploads() {
      return uploads;
    },
    onUpload(fn) {
      onUpload = fn;
    },
    attach(label = "已附加", ready = true) {
      if (
        !doc.querySelector(
          '.file-input-container [ng-if="candidate.resume.file_name"]',
        )
      )
        doc
          .querySelector(".file-input-container")
          .insertAdjacentHTML(
            "afterbegin",
            '<a ng-if="candidate.resume.file_name"><span class="fa fa-paperclip"></span><span>Example_Resume.pdf</span></a>',
          );
      if (ready)
        doc.querySelector(".resume").innerHTML =
          `<div ng-if="!uploadingResume && candidate.resume.file_name"><span>${label}</span></div>`;
    },
    uploading() {
      doc.querySelector(".resume").innerHTML =
        '<div ng-if="uploadingResume"><span>正在上传简历</span></div>';
    },
    fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert(entry, `Expected timer ${delay}`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    upload() {
      return w.breezyUploadResume(
        {},
        (message) => messages.push(message),
        context,
        45000,
      );
    },
    run() {
      return w.breezyRunApplication({
        getProfile: async () => ({
          resumeData: {},
          jobData: [],
          educationData: [],
          employmentData: {},
        }),
        setMessage: (message) => messages.push(message),
        autofillSettings: { saveApplications: true, autoSubmit: true },
        ctx: context,
      });
    },
  };
}

for (const label of ["已附加", "Attached"]) {
  test(`already attached (${label}) proceeds without re-uploading or requiring an uploading frame`, async (t) => {
    const f = fixture(t);
    f.attach(label);
    assert.equal(await f.upload(), true);
    assert.equal(f.uploads, 0);
    assert.equal(f.timers.size, 0);
  });
}

test("fast upload can go straight to localized attachment success", async (t) => {
  const f = fixture(t);
  f.onUpload(() => f.attach());
  assert.equal(await f.upload(), true);
  assert.equal(f.uploads, 1);
  assert.equal(f.timers.size, 0);
});

test("upload and parsing must settle before filling, even when the filename is already rendered", async (t) => {
  const f = fixture(t);
  f.onUpload(() => {
    f.uploading();
    f.attach("已附加", false);
  });
  const done = f.run();
  await tick();
  assert.deepEqual(f.messages, ["uploading-resume"]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.uploads, 1);
  // Avoid the unrelated post-submit observer: the test exercises continuation,
  // but not an ATS submission or receipt.
  f.w.jobsWaitForXPathNodes = () => new Promise(() => {});
  f.attach();
  await done;
  // The step's run (here a stub) fills the form and reports its own status.
  assert.deepEqual(f.messages, ["uploading-resume"]);
  assert.equal(f.calls.filter((name) => name === "advance").length, 1);
  assert.equal(f.timers.size, 0);
});

test("an upload already in progress is awaited without replacing its file", async (t) => {
  const f = fixture(t);
  f.uploading();
  const done = f.upload();
  await tick();
  assert.equal(f.uploads, 0);
  f.attach();
  assert.equal(await done, true);
  assert.equal(f.timers.size, 0);
});

test("visible upload error wins over a stale attachment and stops the application", async (t) => {
  const f = fixture(t);
  f.onUpload(() => {
    f.attach();
    f.doc.querySelector(".error-container").classList.remove("ng-hide");
  });
  await f.run();
  assert.deepEqual(f.messages, ["uploading-resume", "resume-upload-failed"]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.timers.size, 0);
});

test("upload exception produces a failure instead of leaving uploading status", async (t) => {
  const f = fixture(t);
  f.onUpload(() => {
    throw Error("Invalid resume data");
  });
  await f.run();
  assert.deepEqual(f.messages, ["uploading-resume", "resume-upload-failed"]);
  assert.deepEqual(f.calls, []);
});

test("missing completion times out without filling, tracking, or submitting", async (t) => {
  const f = fixture(t);
  const done = f.run();
  await tick();
  f.fire(45000);
  await done;
  assert.deepEqual(f.messages, ["uploading-resume", "resume-upload-timeout"]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.uploads, 1);
  assert.equal(f.timers.size, 0);
});

test("a filename alone is not completion while the upload control has not settled", async (t) => {
  const f = fixture(t);
  f.onUpload(() => f.attach("Attached", false));
  const done = f.upload();
  await tick();
  f.fire(45000);
  assert.equal(await done, false);
  assert.deepEqual(f.messages, ["resume-upload-timeout"]);
});

test("hidden attachment and unrelated attachment cannot count as resume success", async (t) => {
  const f = fixture(t);
  f.doc.body.insertAdjacentHTML(
    "beforeend",
    '<a ng-if="candidate.resume.file_name">Other.pdf</a>',
  );
  f.onUpload(() => {
    f.attach();
    f.doc.querySelector(".file-input-container a").hidden = true;
  });
  const done = f.upload();
  await tick();
  f.fire(45000);
  assert.equal(await done, false);
  assert.deepEqual(f.messages, ["resume-upload-timeout"]);
});

test("detaching the form ends the wait without continuing or reporting a stale error", async (t) => {
  const f = fixture(t);
  const done = f.run();
  await tick();
  f.doc.querySelector(".application-container").remove();
  await done;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, ["uploading-resume"]);
  assert.equal(f.timers.size, 0);
});

test("invalidated extension context does not continue from a later attachment", async (t) => {
  const f = fixture(t);
  const done = f.run();
  await tick();
  f.context.isInvalid = true;
  f.attach();
  await done;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, ["uploading-resume"]);
  assert.equal(f.timers.size, 0);
});
