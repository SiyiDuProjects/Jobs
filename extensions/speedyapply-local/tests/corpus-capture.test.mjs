import test from "node:test";
import assert from "node:assert/strict";
import {
  captureCorpus,
  corpusInputIssues,
  mountCorpus,
} from "../src/custom/corpus-case.js";
import { readerWindow, seedCorpus } from "../scripts/corpus-runner.mjs";
import { readModule } from "./helpers/module-source.mjs";
import { webcrypto } from "node:crypto";

function capture(html, profile = {}) {
  const dom = readerWindow(html);
  try {
    const w = dom.window;
    return captureCorpus({
      root: w.document.querySelector("form"),
      rows: w.JobsControlFields.create(w.document).scan(),
      profile,
    });
  } finally {
    dom.window.close();
  }
}

test("input values are removed at controls without rewriting public company, school or answer words", () => {
  const page = capture(
    `<form>
    <label for="company">Company</label><input id="company" value="Example Labs" title="Example Labs">
    <label for="school">School</label><input id="school" value="Example University">
    <label for="note">Notes</label><textarea id="note">N/A</textarea>
    <label for="free">Free response</label><input id="free" value="Yes">
    <label for="q">Have you worked at Example Labs or attended Example University?</label>
    <select id="q"><option>Yes</option><option>No</option><option>N/A</option></select>
    <p>Mobile office</p></form>`,
    { contactData: { phoneDeviceType: "Mobile" } },
  );
  const serialized = JSON.stringify(page);
  assert(!serialized.includes("[private]"));
  assert(
    page.fields.some((field) =>
      field.question.includes("Example Labs or attended Example University"),
    ),
  );
  assert(serialized.includes("Mobile office"));
  const trees = page.trees[0].children;
  for (const node of trees.filter((node) =>
    ["input", "textarea"].includes(node.tag),
  )) {
    assert.equal(node.attrs.value, undefined);
    assert.equal(node.attrs.title, undefined);
    assert.deepEqual(node.children, []);
  }
  assert.deepEqual(page.quality, { excluded: false, reasons: [] });
  assert.equal(page.redactionVersion, 2);
});

test("identity text is still redacted independently of displayed input formatting", () => {
  const page = capture(
    `<form><p>Welcome Sample Person, sample@example.test, (415) 555-0198, 123 Example Street</p>
    <label>Company<input value="Public Company"></label></form>`,
    {
      nameData: { fullName: "Sample Person" },
      contactData: { email: "sample@example.test", phoneNumber: "4155550198" },
      addressData: { line1: "123 Example Street", city: "Example City" },
    },
  );
  for (const value of [
    "Sample Person",
    "sample@example.test",
    "415",
    "123 Example Street",
  ]) {
    assert(!JSON.stringify(page).includes(value), value);
  }
  // A welcome message is not damaged question input.
  assert.deepEqual(corpusInputIssues(page), []);
});

test("legacy damaged prompts and options are excluded, never reconstructed", () => {
  const page = seedCorpus()[0].page;
  delete page.redactionVersion;
  page.fields[0].question = "Have you worked at [private]?";
  page.fields[0].options[0].label = "[private]";
  page.fields[0].description = "Contact [email]";
  page.fields[0].observations = [
    { query: "[private]", options: ["Public School"] },
  ];
  assert.deepEqual(corpusInputIssues(page), [
    "redacted_description",
    "redacted_options",
    "redacted_question",
    "redacted_search_results",
  ]);
  assert.equal(page.fields[0].question, "Have you worked at [private]?");
});

test("background archives the sender posting identity without session tokens or claimed page URLs", async () => {
  const dom = readerWindow();
  try {
    const w = dom.window;
    let listener;
    const requests = [];
    Object.defineProperty(w, "crypto", { value: webcrypto });
    w.chrome = {
      runtime: {
        id: "extension",
        onMessage: {
          addListener: (fn) => {
            listener = fn;
          },
        },
      },
    };
    w.JobsSync = {
      corpusRequest: async (_method, body) => {
        requests.push(body);
        return body.action === "probe" ? { known: false } : { stored: true };
      },
    };
    w.eval(
      await readModule(
        new URL("../src/custom/corpus-background.js", import.meta.url),
        "utf8",
      ),
    );
    w.initializeCorpusBackground();
    const page = seedCorpus()[0].page;
    page.jobIdentity = "https://wrong.example/claimed";
    const sender = {
      id: "extension",
      frameId: 1,
      tab: { id: 8, url: "https://careers.example/jobs/12345" },
      url: "https://job-boards.greenhouse.io/embed/job_app?for=example&token=12345&validityToken=PRIVATE_SESSION",
    };
    const call = (from) =>
      new Promise((resolve) =>
        listener({ type: "jobs:corpus-page", value: page }, from, resolve),
      );
    assert((await call(sender)).data.ok);
    const identity =
      "https://job-boards.greenhouse.io/embed/job_app?for=example&token=12345";
    assert.equal(requests[0].jobIdentity, identity);
    assert.equal(requests[1].page.jobIdentity, identity);
    assert(!JSON.stringify(requests).includes("PRIVATE_SESSION"));
    assert(!JSON.stringify(requests).includes("wrong.example"));
    requests.length = 0;
    assert(
      (
        await call({
          ...sender,
          url: "https://unknown.example/apply?token=PRIVATE_SESSION",
        })
      ).data.ok,
    );
    assert.equal(requests[1].page.jobIdentity, "");
    assert(!JSON.stringify(requests).includes("PRIVATE_SESSION"));
  } finally {
    dom.window.close();
  }
});

test("cleared native input surfaces retain the exact question and required semantics on replay", () => {
  const page = capture(
    '<form><label for="first">First name</label><input id="first" required value="Sample" title="Sample"><output for="first">Sample</output></form>',
  );
  const dom = readerWindow();
  try {
    mountCorpus(dom.window.document, page);
    const rows = dom.window.JobsControlFields.create(
      dom.window.document,
    ).scan();
    assert.equal(rows[0].public.question, page.fields[0].question);
    assert.equal(rows[0].public.question, "First name");
    assert.equal(rows[0].public.required, true);
    assert(!JSON.stringify(page.trees).includes("Sample"));
  } finally {
    dom.window.close();
  }
});

test("failure pages require a server failure acknowledgement and private UI access", async () => {
  const dom = readerWindow();
  try {
    const w = dom.window;
    let listener;
    let accepted = false;
    const requests = [];
    Object.defineProperty(w, "crypto", { value: webcrypto });
    w.chrome = {
      runtime: {
        id: "extension",
        getURL: (path) => "chrome-extension://extension/" + path,
        onMessage: {
          addListener: (fn) => {
            listener = fn;
          },
        },
      },
    };
    w.JobsSync = {
      corpusRequest: async (_method, body) => {
        requests.push(body);
        return accepted
          ? { stored: true, failureId: "failure-1" }
          : { stored: true };
      },
    };
    w.eval(
      await readModule(
        new URL("../src/custom/corpus-background.js", import.meta.url),
        "utf8",
      ),
    );
    w.initializeCorpusBackground();
    const sender = {
      id: "extension",
      tab: { id: 8 },
      url: "https://jobs.ashbyhq.com/example/job",
    };
    const message = {
      type: "jobs:corpus-page",
      value: seedCorpus()[0].page,
      failure: {
        runId: "run-1",
        documentId: "doc-1",
        fieldIds: ["field-1"],
        reason: "site_error",
      },
    };
    const send = (msg, from = sender) =>
      new Promise((resolve) => listener(msg, from, resolve));
    assert((await send(message)).error);
    accepted = true;
    assert.equal((await send(message)).data.failureId, "failure-1");
    assert(requests.every((item) => item.action === "capture"));
    assert.deepEqual(requests[0].failure, message.failure);
    assert((await send({ type: "jobs:corpus-failures" })).error);
    assert(
      (
        await send(
          { type: "jobs:corpus-failures" },
          {
            id: "extension",
            url: "chrome-extension://extension/diagnostics.html",
          },
        )
      ).data,
    );
  } finally {
    dom.window.close();
  }
});

test("an unacknowledged page outcome is kept per page, retried, and replaced by a newer state", async () => {
  const dom = readerWindow();
  try {
    const w = dom.window;
    let listener, alarm;
    let accepted = false;
    const requests = [],
      stored = {},
      alarms = new Set();
    Object.defineProperty(w, "crypto", { value: webcrypto });
    w.chrome = {
      runtime: {
        id: "extension",
        getURL: (path) => "chrome-extension://extension/" + path,
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      storage: {
        local: {
          get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
          set: async (value) => Object.assign(stored, structuredClone(value)),
          remove: async (key) => delete stored[key],
        },
      },
      alarms: {
        create: (name) => alarms.add(name),
        clear: (name) => alarms.delete(name),
        onAlarm: { addListener: (fn) => (alarm = fn) },
      },
    };
    w.JobsSync = {
      corpusRequest: async (_method, body) => {
        requests.push(body);
        if (!accepted) throw Error("offline");
        return { stored: true, failureId: "outcome-1" };
      },
    };
    w.eval(
      await readModule(
        new URL("../src/custom/corpus-background.js", import.meta.url),
        "utf8",
      ),
    );
    w.initializeCorpusBackground();
    const sender = {
      id: "extension",
      tab: { id: 8 },
      url: "https://jobs.ashbyhq.com/example/job",
    };
    const outcome = (observedAt, by) => ({
      type: "jobs:corpus-page",
      value: seedCorpus()[0].page,
      failure: {
        runId: "run-1",
        documentId: "doc-1",
        fieldIds: ["field-1"],
        reason: "incomplete",
        outcomes: { "field-1": { state: "decided", by, taken: true } },
        observedAt,
      },
    });
    const send = (msg) =>
      new Promise((resolve) => listener(msg, sender, resolve));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const pending = () => stored.jobsCorpusOutcomeRetryV1 || {};
    assert((await send(outcome(1, "user"))).error);
    assert.deepEqual(Object.keys(pending()), ["run-1|doc-1"]);
    assert(alarms.has("jobs-corpus-outcomes"));
    accepted = true;
    alarm({ name: "jobs-corpus-outcomes" });
    await settle();
    assert.deepEqual(pending(), {});
    assert(!alarms.has("jobs-corpus-outcomes"));
    assert.equal(requests.at(-1).failure.observedAt, 1);
    accepted = false;
    assert((await send(outcome(2, "user"))).error);
    accepted = true;
    assert.equal((await send(outcome(3, "agent"))).data.failureId, "outcome-1");
    await settle();
    assert.deepEqual(pending(), {});
    assert.equal(requests.at(-1).failure.observedAt, 3);
  } finally {
    dom.window.close();
  }
});
