import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
const code = {};
for (const name of [
  "response-contract",
  "document-store",
  "answer-memory",
  "control-fields",
  "workday-controls",
  "operation-context",
  "control-content",
  "diagnostics",
  "management-model",
  "management-sync",
  "dom-wait",
  "ashby-controls",
])
  code[name] = await readWithDependencies(
    new URL("../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const writer = await readWithDependencies(
  new URL("../source/saved-responses.js", import.meta.url),
  "utf8",
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function page(html, url = "https://jobs.ashbyhq.com/example/test/application") {
  const dom = new JSDOM(html, {
      url,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }),
    w = dom.window,
    listeners = [],
    events = {},
    saved = [];
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      id: "audit",
      getManifest: () => ({ version_name: "local.15" }),
      sendMessage: async () => ({
        data: { id: "ng", profile: { profileName: "Newgrad" } },
      }),
      onMessage: { addListener: (f) => listeners.push(f) },
    },
  };
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, fn, ...args) => {
    events[type] = fn;
    return add(type, fn, ...args);
  };
  for (const name of [
    "diagnostics",
    "control-fields",
    "workday-controls",
    "answer-memory",
    "operation-context",
    "control-content",
    "dom-wait",
    "ashby-controls",
  ])
    w.eval(code[name]);
  const invoke = (m) =>
    new Promise((resolve) =>
      listeners.forEach((f) => f(m, { id: "audit" }, resolve)),
    );
  async function activate(name = "ashby") {
    const run = async (options) => {
      await options.getProfile();
      options.setMessage("autofill-complete");
    };
    Object.defineProperty(run, "name", { value: name });
    await w.JobsPageSession.run(run, {
      jobsAdapterId: name,
      getProfile: async () => ({ profileName: "Newgrad" }),
      setMessage() {},
      autofillSettings: {},
      ctx: { onInvalidated() {} },
    });
  }
  return {
    w,
    doc: w.document,
    events,
    saved,
    activate,
    invoke,
    close() {
      w.JobsDiagnostics.stop();
      dom.window.close();
    },
  };
}
test("actual emitted file snapshot passes the actual Python server contract", async () => {
  const h = page(
    '<form aria-labelledby="job-application-form"><label>Resume<input type="file"></label><label>Motivation<textarea></textarea></label></form>',
  );
  try {
    await h.activate();
    const snapshot = (await h.invoke({ type: "jobs:control-inspect" })).data;
    assert(
      !Object.hasOwn(
        snapshot.fields.find((f) => f.type === "file"),
        "value",
      ),
    );
    const backend = fileURLToPath(
      new URL("../../../services/jobs-radar/", import.meta.url),
    );
    const python = fileURLToPath(
      new URL(
        "../../../services/jobs-radar/.venv/Scripts/python.exe",
        import.meta.url,
      ),
    );
    const run = spawnSync(
      python,
      [
        "-c",
        'import json,sys; from jobs_radar.browser_control import page; s=json.load(sys.stdin); page(s,s["observedAt"]); print("accepted")',
      ],
      {
        cwd: backend,
        input: JSON.stringify({ ...snapshot, tabId: 1, frameId: 0 }),
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, run.stderr || String(run.error));
    assert.match(run.stdout, /accepted/);
  } finally {
    h.close();
  }
});
test("unknown adapter still observes a unique visible form and stable labels omit option text", async () => {
  const h = page(
    '<form><label>Source?<select><option value="">Choose</option><option value="ref">Referral</option></select></label></form>',
  );
  try {
    await h.activate("unknown_fixture");
    const report = h.w.JobsDiagnostics.snapshot();
    assert.equal(report.fields.length, 1);
    assert.equal(report.fields[0].question, "Source?");
  } finally {
    h.close();
  }
});

test("Workday optional-field supplement policy stays local and the emitted snapshot matches the server contract", async () => {
  const h = page(
    '<div data-automation-id="applyFlowPage"><label>Optional ID<input></label></div>',
    "https://fixture.myworkdayjobs.com/apply",
  );
  try {
    await h.activate("workday");
    const snapshot = (await h.invoke({ type: "jobs:control-inspect" })).data;
    assert.equal(snapshot.fields.length, 1);
    assert(!Object.hasOwn(snapshot.fields[0], "supplement"));
    const backend = fileURLToPath(
      new URL("../../../services/jobs-radar/", import.meta.url),
    );
    const python = fileURLToPath(
      new URL(
        "../../../services/jobs-radar/.venv/Scripts/python.exe",
        import.meta.url,
      ),
    );
    const run = spawnSync(
      python,
      [
        "-c",
        'import json,sys; from jobs_radar.browser_control import page; s=json.load(sys.stdin); page(s,s["observedAt"]); print("accepted")',
      ],
      {
        cwd: backend,
        input: JSON.stringify({ ...snapshot, tabId: 1, frameId: 0 }),
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, run.stderr || String(run.error));
  } finally {
    h.close();
  }
});
test("delayed custom choice is saved; changing another form is not", async () => {
  const h = page(
    '<form aria-labelledby="job-application-form"><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Onsite willingness?</label><div class="ashby-application-form-input-yesno"><button data-option="yes" aria-pressed="false">Yes</button><button data-option="no" aria-pressed="false">No</button></div></div></form><form id="other"><label>Newsletter preference<input></label></form>',
  );
  try {
    await h.activate();
    h.w.JobsAnswerMemory.start(
      h.doc,
      true,
      (rows) => h.saved.push(...rows),
      () => h.w.JobsPageSession.root(),
    );
    const target = h.doc.querySelector("button");
    h.events.pointerdown({ type: "pointerdown", isTrusted: true, target });
    h.events.click({ type: "click", isTrusted: true, target });
    await wait(20);
    target.setAttribute("aria-pressed", "true");
    await wait(30);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].response, "Yes");
    const other = h.doc.querySelector("#other input");
    other.value = "Unrelated";
    h.events.change({ type: "change", isTrusted: true, target: other });
    await wait(10);
    assert.equal(h.saved.length, 1);
  } finally {
    h.close();
  }
});
test("diagnostic failure cannot interrupt a wrapped operation or replace its own error", async () => {
  const h = page("<form><label>Answer<input></label></form>");
  try {
    await h.activate();
    h.w.JobsDiagnostics.useReader({
      scan() {
        throw Error("reader failed");
      },
      identify() {
        throw Error("mapping failed");
      },
    });
    let called = 0;
    const value = h.w.JobsDiagnostics.perform(
      "text",
      () => h.doc.querySelector("input"),
      () => {
        called++;
        return "done";
      },
    );
    assert.equal(called, 1);
    assert.equal(value, "done");
    assert.throws(
      () =>
        h.w.JobsDiagnostics.perform(
          "text",
          () => h.doc.querySelector("input"),
          () => {
            throw Error("actual failure");
          },
        ),
      /actual failure/,
    );
  } finally {
    h.close();
  }
});
test("full question identity preserves reversed-direction answers", async () => {
  const responseKey = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    data = { [responseKey]: [] };
  const c = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    structuredClone,
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: {
          getKeys: async () => Object.keys(data),
          get: async () => structuredClone(data),
          set: async (update) => Object.assign(data, structuredClone(update)),
        },
      },
    },
    JobsResponseScope: {
      storageKey: async () => responseKey,
      scopeFor: () => ({}),
    },
  });
  vm.runInContext(
    code["response-contract"] + "\n" + code["document-store"] + "\n" + writer,
    c,
  );
  await c.saveResponses([
    { question: "Relocate from Canada to Australia?", response: "Yes" },
    { question: "Relocate from Australia to Canada?", response: "No" },
  ]);
  assert.equal(data[responseKey].length, 2);
  assert.equal(new Set(data[responseKey].map((row) => row.key)).size, 2);
});
test("a save arriving during final sync commit queues behind it and cannot be lost", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    key = "jobsResponses:" + id;
  const initial = {
    question: "Initial question",
    response: "A",
    keywords: ["initial"],
    key: "initial",
    appearances: 1,
  };
  const remoteAdded = {
    question: "Remote question",
    response: "B",
    keywords: ["remote"],
    key: "remote",
    appearances: 1,
  };
  const data = {
    profile_1: { id, profile: {} },
    [key]: [initial],
    jobsManagementBaseV1: { [key]: { value: [initial], revision: 1 } },
    jobsManagementBeforeMigrationV1: {},
  };
  const remote = { [key]: { value: [initial, remoteAdded], revision: 2 } };
  let paused, release;
  const atCommit = new Promise((resolve) => (paused = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const area = {
    getKeys: async () => Object.keys(data),
    remove: async (keys) => {
      for (const key of [keys].flat()) delete data[key];
    },
    get: async (keys) =>
      keys === null
        ? structuredClone(data)
        : Object.fromEntries(
            [keys].flat().map((k) => [k, structuredClone(data[k])]),
          ),
    set: async (values) => {
      if (values.jobsManagementBaseV1) {
        paused();
        await gate;
      }
      Object.assign(data, structuredClone(values));
    },
  };
  const c = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    chrome: {
      storage: { local: area, session: area, onChanged: { addListener() {} } },
      runtime: { id: "audit", onMessage: { addListener() {} } },
      alarms: { onAlarm: { addListener() {} } },
    },
    Date,
    URLSearchParams,
    structuredClone,
    setTimeout: () => 0,
    clearTimeout() {},
    JobsResponseScope: {
      ready: Promise.resolve(),
      storageKey: async () => key,
      scopeFor: () => ({}),
    },
    JobsSync: {
      ready: Promise.resolve(),
      profileRequest: async () => [],
      managementRequest: async () => structuredClone(remote),
    },
  });
  vm.runInContext(
    code["response-contract"] +
      "\n" +
      code["document-store"] +
      "\n" +
      code["management-model"] +
      "\n" +
      code["management-sync"] +
      "\n" +
      writer,
    c,
  );
  const sync = c.JobsManagementSync.sync();
  await Promise.race([
    atCommit,
    sync.then(() => {
      throw Error(
        "Sync completed before reaching the commit barrier: " +
          JSON.stringify(data.jobsManagementStatus),
      );
    }),
  ]);
  const save = c.saveResponses([
    { question: "New local response", response: "C" },
  ]);
  release();
  await Promise.all([sync, save]);
  assert.deepEqual(
    new Set(data[key].map((row) => row.response)),
    new Set(["A", "B", "C"]),
  );
});
test("replacing an Ashby form cancels its old run before any pending write", async () => {
  const h = page(
    '<form aria-labelledby="job-application-form"><button id="submit">Submit</button></form>',
  );
  let release;
  const gate = new Promise((resolve) => (release = resolve)),
    lives = [],
    writes = [];
  try {
    const stop = h.w.JobsAshbyControls.watch(
      '//button[@id="submit"]',
      async (life) => {
        lives.push(life);
        await gate;
        if (life.current()) writes.push(life.root);
      },
      () => {},
    );
    await wait(5);
    const old = h.doc.querySelector("form");
    old.outerHTML =
      '<form aria-labelledby="job-application-form"><button id="submit">Submit</button></form>';
    await wait(5);
    release();
    await wait(5);
    assert.equal(lives.length, 2);
    assert.equal(lives[0].signal.aborted, true);
    assert.equal(writes.length, 1);
    assert.notEqual(writes[0], old);
    stop();
  } finally {
    h.close();
  }
});
