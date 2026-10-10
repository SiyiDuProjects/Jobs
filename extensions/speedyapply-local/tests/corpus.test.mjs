import test from "node:test";
import assert from "node:assert/strict";
import { captureCorpus, mountCorpus } from "../src/custom/corpus-case.js";
import { recordCorpusOptions } from "../src/custom/corpus-observations.js";
import {
  readerWindow,
  seedCorpus,
  seedBindings,
  corpusReport,
  replaySearch,
} from "../scripts/corpus-runner.mjs";

test("corpus keeps prompts but removes values, selections, credentials and file names without page writes", () => {
  const dom = readerWindow(
    '<form><p>Welcome Sample Person</p><div class="field"><label for="email">Email</label><input id="email" type="email" value="private@example.test"></div><div class="field"><label for="s">Work authorization</label><select id="s"><option value="yes" selected>Yes</option><option value="no">No</option></select></div><input type="password" value="secret"><textarea>Private narrative</textarea><span data-automation-id="fileName">resume.pdf</span></form>',
  );
  try {
    const w = dom.window,
      root = w.document.querySelector("form"),
      reader = w.JobsControlFields.create(w.document);
    let writes = 0;
    root.addEventListener("input", () => writes++);
    const page = captureCorpus({
      root,
      rows: reader.scan(),
      profile: { nameData: { fullName: "Sample Person" } },
    });
    const serialized = JSON.stringify(page);
    for (const secret of [
      "Sample Person",
      "private@example.test",
      "Private narrative",
      "resume.pdf",
      '"selected"',
      '"checked"',
      '"password"',
    ])
      assert(!serialized.includes(secret), secret);
    assert(serialized.includes("Work authorization"));
    assert(serialized.includes('"Yes"'));
    assert.equal(writes, 0);
    assert.equal(
      w.document.querySelector("input").value,
      "private@example.test",
    );
    assert.equal(
      captureCorpus({ root, rows: reader.scan(), review: true }),
      null,
    );
  } finally {
    dom.window.close();
  }
});

test("search observations remain associated with their exact control and are never mounted as markup", () => {
  const dom = readerWindow(
    '<form><label>School<input id="school"></label></form>',
  );
  try {
    const w = dom.window,
      rows = w.JobsControlFields.create(w.document).scan();
    recordCorpusOptions(rows[0].node, ["Example University"], "Example");
    const page = captureCorpus({
      root: w.document.querySelector("form"),
      rows,
    });
    assert.deepEqual(page.fields[0].observations, [
      { query: "Example", options: ["Example University"] },
    ]);
    const malicious = structuredClone(page);
    malicious.trees[0].attrs.onclick = "alert(1)";
    assert.throws(() => mountCorpus(w.document, malicious), /Unsafe/);
  } finally {
    dom.window.close();
  }
});

test("bootstrap corpus runs the real scanner on three platforms and compares stable results", () => {
  const pages = seedCorpus();
  const corpus = {
    source: "synthetic-bootstrap",
    pages,
    bindings: seedBindings(pages),
  };
  const before = corpusReport(corpus),
    after = corpusReport(corpus, before);
  assert.equal(after.summary.pages, 3);
  assert(after.summary.questions >= 5);
  assert.equal(after.summary.changedQuestions, 0);
  assert.equal(after.summary.missedControls, 0);
  assert.equal(after.summary.violations, 0);
  assert(
    after.pages.every((page) => page.fields.every((field) => field.actual)),
  );
  const positive = after.pages[0].fields.find((field) =>
    field.captured.question.startsWith("Will you require"),
  );
  const negative = after.pages[0].fields.find((field) =>
    field.captured.question.includes("without future sponsorship"),
  );
  assert.equal(
    positive.answers.find((answer) => answer.identity === "citizen").answer,
    "No",
  );
  assert.equal(
    negative.answers.find((answer) => answer.identity === "citizen").answer,
    "Yes",
  );
  assert.equal(
    positive.answers.find((answer) => answer.identity === "opt").answer,
    "Yes",
  );
  assert.equal(
    negative.answers.find((answer) => answer.identity === "unknown").answer,
    null,
  );
  assert.equal(after.summary.mappingAccuracy, null);
});

test("search replay only selects from observed results and identifies missing recordings", () => {
  const records = [
    { query: "Example", options: ["Example University", "Example College"] },
  ];
  assert.deepEqual(
    replaySearch(records, "Example", (options) =>
      options.find((option) => option.endsWith("University")),
    ),
    { status: "recorded", answer: "Example University" },
  );
  assert.deepEqual(
    replaySearch(records, "Different", () => {
      throw Error("No unseen search may run");
    }),
    { status: "unrecorded", answer: null },
  );
  assert.deepEqual(
    replaySearch(records, "Example", () => "Invented"),
    { status: "invalid-option", answer: null },
  );
});

test("corpus replay never expands an ambiguous country mapping or invents a graduation day", () => {
  const pages = seedCorpus(),
    bindings = seedBindings(pages);
  const first = bindings[0];
  const conflicting = {
    ...first,
    country: "CA",
    meaning: { ...first.meaning, country: "CA" },
  };
  const report = corpusReport({ pages, bindings: [...bindings, conflicting] });
  assert.equal(report.summary.ambiguousMappings, 1);
  const field = report.pages[0].fields.find(
    (field) => field.key === first.questionId,
  );
  assert(field.answers.every((answer) => answer.answer === null));
  const graduation = report.pages[0].fields.find(
    (field) => field.captured.question === "Graduation Date",
  );
  assert.equal(
    graduation.answers.find((answer) => answer.identity === "citizen").answer,
    null,
  );
  assert.equal(
    graduation.answers.find((answer) => answer.identity === "opt").answer,
    "2027-05-21",
  );
});

test("independent labels detect an inverted model mapping", () => {
  const pages = seedCorpus(),
    bindings = seedBindings(pages),
    first = bindings[0];
  const labels = {
    [first.questionId]: { binding: first.binding, meaning: first.meaning },
  };
  const wrong = {
    ...first,
    binding: { ...first.binding, options: ["false", "true"] },
  };
  const report = corpusReport({
    pages,
    bindings: [wrong, ...bindings.slice(1)],
    labels,
  });
  assert.equal(report.summary.mappingAccuracy, 0);
  assert.equal(report.goldChecks.length, 1);
});

test("capture context survives same-Profile refreshes and stops after a Profile switch", async () => {
  const { readModule } = await import("./helpers/module-source.mjs");
  const dom = readerWindow(
    "<form><label>School<input></label></form>",
    "https://example.myworkdayjobs.com/apply",
  );
  try {
    const w = dom.window,
      messages = [];
    let change;
    w.JobsBuildInfo = { id: "synthetic" };
    w.chrome = {
      storage: {
        onChanged: {
          addListener: (listener) => {
            change = listener;
          },
        },
      },
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return { data: {} };
        },
      },
    };
    w.eval(
      await readModule(
        new URL("../src/custom/corpus-content.js", import.meta.url),
        "utf8",
      ),
    );
    const root = w.document.querySelector("form"),
      profile = { nameData: { firstName: "Li" } };
    w.bindCorpusPage(
      root,
      profile,
      w.JobsControlFields.create(w.document),
      () => false,
    );
    w.captureCorpusPage();
    assert.equal(messages.length, 1);
    change({ profile_1: { newValue: { profile } } }, "session");
    w.captureCorpusPage();
    assert.equal(messages.length, 2);
    change(
      {
        profile_1: {
          newValue: { profile: { nameData: { firstName: "Other" } } },
        },
      },
      "session",
    );
    w.captureCorpusPage();
    assert.equal(messages.length, 2);
    w.bindCorpusPage(
      root,
      profile,
      w.JobsControlFields.create(w.document),
      () => true,
    );
    w.captureCorpusPage();
    assert.equal(messages.length, 2);
  } finally {
    dom.window.close();
  }
});

test("background probes before upload, deduplicates known pages, and rejects external senders", async () => {
  const { readModule } = await import("./helpers/module-source.mjs");
  const { webcrypto } = await import("node:crypto");
  const dom = readerWindow();
  try {
    const w = dom.window,
      requests = [];
    let listener,
      known = false;
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
        return body.action === "probe" ? { known } : { stored: true };
      },
    };
    w.eval(
      await readModule(
        new URL("../src/custom/corpus-background.js", import.meta.url),
        "utf8",
      ),
    );
    w.initializeCorpusBackground();
    const message = { type: "jobs:corpus-page", value: seedCorpus()[0].page };
    const sender = {
      id: "extension",
      tab: { id: 1 },
      url: "https://job-boards.greenhouse.io/example",
    };
    const call = (from = sender) =>
      new Promise((resolve) => listener(message, from, resolve));
    assert((await call()).data.ok);
    assert.deepEqual(
      requests.map((r) => r.action),
      ["probe", "capture"],
    );
    assert.equal(requests[0].page, undefined);
    known = true;
    requests.length = 0;
    assert((await call()).data.ok);
    assert.deepEqual(
      requests.map((r) => r.action),
      ["probe"],
    );
    requests.length = 0;
    assert((await call({ ...sender, id: "external" })).error);
    assert.equal(requests.length, 0);
  } finally {
    dom.window.close();
  }
});
