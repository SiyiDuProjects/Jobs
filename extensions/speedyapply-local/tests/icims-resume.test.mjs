import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
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
const prefix = "PortalProfileFields.Resume";

function fixture(
  t,
  { selected = false, saved = false, upload = "ready" } = {},
) {
  const dom = new JSDOM(
    `<!doctype html><style>.iCIMS_NoDisplay{display:none}</style>
    <div class="iCIMS_CandidatePage"><form>
      <input type="file" id="optional-attachment">
      <div id="${prefix}_Loading" class="iCIMS_NoDisplay">Loading</div>
      <div id="${prefix}_Content">
        <input type="hidden" id="${prefix}" value="false">
        <input type="hidden" id="${prefix}_FileName" value="">
        <div id="${prefix}_CurrentFile" class="iCIMS_NoDisplay">
          <div id="${prefix}_FileNameLabel"></div>
          <button type="button" id="${prefix}_Button">Replace Resume</button>
        </div>
        <div id="${prefix}_UploadButtons">
          <label for="${prefix}_File">Resume</label>
          <input type="file" id="${prefix}_File" required>
        </div>
      </div>
      <label for="PersonProfileFields.AddressStreet1">Address</label>
      <input id="PersonProfileFields.AddressStreet1" required>
      <label for="PersonProfileFields.AddressCity">City</label>
      <input id="PersonProfileFields.AddressCity" required>
      <input type="submit" class="Primary" value="Submit Profile">
    </form></div>`,
    {
      url: "https://fixture.icims.com/jobs/1/candidate?resumeSubmitted=1",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    form = doc.querySelector("form");
  t.after(() => w.close());
  const profile = {
    nameData: {},
    contactData: {},
    addressData: { line1: "123 Example Street", city: "Boston" },
    educationData: [],
    jobData: [],
    employmentData: {},
    resumeData: { resumeBase64: "JVBERg==", fileName: "fixture.pdf" },
  };
  const uploads = [],
    phases = [],
    notes = [],
    tasks = [],
    writes = [];
  let submits = 0;
  w.chrome = {
    runtime: {
      id: "test",
      onMessage: { addListener() {} },
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "fixture", profile } }
          : {},
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace() {},
    perform: (operation, target, run) => run(),
  };
  for (const script of [...scripts, shared, adapter]) w.eval(script);
  installAnswerResolver(w, []);
  w.JobsPageSession = { root: () => form };
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (check, options = {}) =>
    until(check, {
      ...options,
      timeout: options.timeout == null ? null : Math.min(options.timeout, 100),
      interval: 5,
    });
  const get = (suffix) => doc.getElementById(prefix + suffix);
  const select = () =>
    Object.defineProperty(get("_File"), "files", {
      configurable: true,
      value: [new w.File(["fixture"], "fixture.pdf")],
    });
  const ready = () => {
    get("_CurrentFile").className = "";
    get("_FileNameLabel").textContent = "C:\\fakepath\\fixture.pdf";
    get("_UploadButtons").className = "iCIMS_NoDisplay";
    get("_Loading").className = "iCIMS_NoDisplay";
  };
  if (selected) {
    select();
    ready();
  }
  if (saved) {
    get("_FileName").value = "fixture.pdf";
    ready();
  }
  Object.assign(w, {
    jobsReportJobTitle: async () => {},
    jobsMountManualAnswerControls: async () => {},
    jobsFillAccount: async () => {},
    jobsWaitForXPathNodes: (xpath) =>
      xpath.includes("iCIMS_CandidatePage")
        ? Promise.resolve([doc.querySelector(".iCIMS_CandidatePage")])
        : new Promise(() => {}),
    jobsUploadResume: (resume, selector) => {
      uploads.push(doc.querySelector(selector)?.id);
      select();
      if (upload === "ready") ready();
      else if (upload === "pending") get("_Loading").className = "";
      else if (upload === "reload") w.dispatchEvent(new w.Event("pagehide"));
      else if (upload === "throw") throw Error("Fixture upload failure");
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
  form.addEventListener("input", (event) => writes.push(event.target.id));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  const run = async (autoClickNextPage = false) => {
    await w.icimsRunApplication({
      getProfile: async () => profile,
      setMessage: (phase) => phases.push(phase),
      autofillSettings: { autoClickNextPage, saveApplications: false },
      accountSettings: {},
      ctx: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      tasks.length,
      1,
      "Candidate step must enter the shared pipeline once",
    );
    return tasks[0];
  };
  return {
    w,
    doc,
    get,
    run,
    ready,
    select,
    tasks,
    uploads,
    phases,
    notes,
    writes,
    submits: () => submits,
  };
}

test("an in-place resume with an empty hidden filename proceeds once without uploading again", async (t) => {
  const f = fixture(t, { selected: true });
  await f.run();
  assert.deepEqual(f.uploads, []);
  assert.equal(
    f.doc.getElementById("PersonProfileFields.AddressCity").value,
    "Boston",
  );
  assert.equal(
    f.writes.filter((id) => id === "PersonProfileFields.AddressCity").length,
    1,
  );
  assert.equal(f.phases.at(-1), "page-complete");
  assert.equal(f.submits(), 0);
});

test("a saved resume is preserved and the address is filled", async (t) => {
  const f = fixture(t, { saved: true });
  await f.run();
  assert.deepEqual(f.uploads, []);
  assert.equal(
    f.doc.getElementById("PersonProfileFields.AddressStreet1").value,
    "123 Example Street",
  );
});

test("a fresh upload targets the resume even when an optional attachment comes first", async (t) => {
  const f = fixture(t);
  await f.run();
  assert.deepEqual(f.uploads, [prefix + "_File"]);
  assert.equal(f.doc.querySelector("#optional-attachment").files.length, 0);
  assert.equal(
    f.doc.getElementById("PersonProfileFields.AddressCity").value,
    "Boston",
  );
  assert.equal(f.phases.at(-1), "page-complete");
});

test("an existing pending upload is awaited without dispatching it again", async (t) => {
  const f = fixture(t, { selected: true });
  f.get("_Loading").className = "";
  const running = f.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.doc.getElementById("PersonProfileFields.AddressCity").value,
    "",
  );
  f.ready();
  await running;
  assert.deepEqual(f.uploads, []);
  assert.equal(f.phases.at(-1), "page-complete");
});

test("an unconfirmed upload returns a hold and cannot navigate", async (t) => {
  const f = fixture(t, { upload: "pending" });
  await f.run(true);
  assert.equal(f.submits(), 0);
  assert(
    f.notes.some(
      (note) =>
        note.type === "auto_fill_held" &&
        note.detail === "resume_upload_unconfirmed",
    ),
  );
  assert.notEqual(f.phases.at(-1), "in-progress");
  assert.notEqual(f.phases.at(-1), "page-complete");
});

test("a document leaving during upload cannot fill or navigate on its old pipeline", async (t) => {
  const f = fixture(t, { upload: "reload" });
  await f.run(true);
  assert.equal(
    f.doc.getElementById("PersonProfileFields.AddressCity").value,
    "",
  );
  assert.equal(f.submits(), 0);
  assert.deepEqual(f.uploads, [prefix + "_File"]);
});

test("upload errors exit the working state without navigating", async (t) => {
  const f = fixture(t, { upload: "throw" });
  await f.run(true);
  assert.equal(f.submits(), 0);
  assert.notEqual(f.phases.at(-1), "in-progress");
  assert.notEqual(f.phases.at(-1), "page-complete");
});
