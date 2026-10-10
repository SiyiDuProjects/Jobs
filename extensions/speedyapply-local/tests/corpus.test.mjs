import test from "node:test";
import assert from "node:assert/strict";
import { captureCorpus, mountCorpus } from "../src/custom/corpus-case.js";
import { recordCorpusOptions } from "../src/custom/corpus-observations.js";
import {
  readerWindow,
  seedCorpus,
  syntheticProfiles,
  hash,
  corpusQuestionKey,
  corpusReport,
  replaySearch,
} from "../scripts/corpus-runner.mjs";

function syntheticCache(pages) {
  const aiRevision = { promptHash: "fixture-prompt", model: "fixture-model" };
  const aiAnswers = [];
  for (const { id, page } of pages)
    for (const field of page.fields) {
      const values = {
        "Are you legally authorized to work in the United States?": [
          "Yes",
          "Yes",
          "Yes",
          null,
        ],
        "Will you require sponsorship in the future?": [
          "No",
          "Yes",
          "No",
          null,
        ],
        "Will you be able to work without future sponsorship?": [
          "Yes",
          "No",
          "Yes",
          null,
        ],
      }[field.question];
      if (!values) continue;
      syntheticProfiles.forEach((profile, i) =>
        aiAnswers.push({
          pageId: id,
          questionId: corpusQuestionKey(field),
          identity: profile.id,
          profileHash: hash(profile),
          ...aiRevision,
          answer: {
            kind: values[i] === null ? "unknown" : "answer",
            value: values[i],
          },
        }),
      );
    }
  return { aiRevision, aiAnswers };
}
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
    ...syntheticCache(pages),
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
  assert.equal(after.summary.answerAccuracy, null);
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

test("corpus refuses answers for another identity revision or page and never treats cache as gold", () => {
  const pages = seedCorpus(),
    corpus = { pages, ...syntheticCache(pages) };
  corpus.aiAnswers[0].profileHash = "outdated";
  const report = corpusReport(corpus);
  assert(report.summary.missingAI > 0);
  assert.equal(report.summary.answerAccuracy, null);
  const good = corpus.aiAnswers.find((row) => row.identity === "opt");
  corpus.goldAnswers = [
    { ...good, value: "Wrong fixture gold", confirmed: true, origin: "person" },
  ];
  assert.equal(corpusReport(corpus).summary.answerAccuracy, 0);
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

function workdayDropdown(selected = "Female") {
  return readerWindow(
    `<form><div data-automation-id="formField-gender"><label for="gender">Gender</label><button id="gender" aria-haspopup="listbox" aria-label="Gender Required ${selected}" title="${selected}"><span>${selected}</span></button></div></form>`,
    "https://example.myworkdayjobs.com/apply",
  );
}

test("Workday selected text and accessible attributes are absent from inert snapshots", () => {
  const dom = workdayDropdown();
  try {
    const w = dom.window,
      rows = w.JobsControlFields.create(w.document).scan();
    assert.equal(rows[0].public.type, "combobox");
    recordCorpusOptions(rows[0].node, ["Female", "Male"]);
    const page = captureCorpus({
      root: w.document.querySelector("form"),
      rows,
      platform: "workday",
    });
    assert(!JSON.stringify(page.trees).includes("Female"));
    assert.equal(page.fields[0].question, "Gender");
    assert.deepEqual(
      page.fields[0].options.map((o) => o.label),
      ["Female", "Male"],
    );
    assert.equal(rows[0].node.textContent, "Female");
  } finally {
    dom.window.close();
  }
});

test("Workday non-search dropdown replays its full recorded option list", async () => {
  const { replayCorpusPage } = await import("../scripts/corpus-runner.mjs");
  const dom = workdayDropdown("Select One");
  try {
    const w = dom.window,
      rows = w.JobsControlFields.create(w.document).scan();
    recordCorpusOptions(rows[0].node, ["Female", "Male"]);
    const page = captureCorpus({
      root: w.document.querySelector("form"),
      rows,
      platform: "workday",
    });
    const report = replayCorpusPage(page, [
      { id: "synthetic", employmentData: { gender: "Female" } },
    ]);
    assert.equal(report.fields[0].answers[0].answer, "Female");
    assert.equal(report.fields[0].meaningMatches, true);
    assert.equal(report.fields[0].actual.required, true);
  } finally {
    dom.window.close();
  }
});
