import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const modules = Object.fromEntries(
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "repro-case",
      "diagnostics",
      "control-fields",
      "workday-controls",
      "operation-context",
      "control-content",
      "answer-memory",
    ].map(async (name) => [
      name,
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ]),
  ),
);
function harness(
  html = "<label>Summary<input required></label>",
  {
    ats = "ashby",
    url = "https://jobs.ashbyhq.com/example/test/application?token=secret",
  } = {},
) {
  const dom = new JSDOM(
      '<form aria-labelledby="job-application-form">' + html + "</form>",
      { url, runScripts: "outside-only" },
    ),
    w = dom.window,
    listeners = [],
    sent = [];
  w.TextEncoder = TextEncoder;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version_name: "local.14" }),
      sendMessage: async (msg) => {
        sent.push(msg);
        return msg.type === "jobs:tab-profile"
          ? { data: { id: "ng", profile: { profileName: "Newgrad" } } }
          : {};
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  for (const name of [
    "job-match-rules",
    "job-match",
    "repro-case",
    "diagnostics",
    "control-fields",
    "workday-controls",
    "operation-context",
    "control-content",
  ])
    w.eval(modules[name]);
  const options = {
    autofillSettings: { autoSubmit: true, autoClickNextPage: true },
    ctx: { onInvalidated() {} },
    getProfile: async () => ({ profileName: "Newgrad" }),
    setMessage() {},
  };
  let actual;
  async function eL(opts) {
    actual = opts;
    await opts.getProfile();
    opts.setMessage("autofill-complete");
    return 42;
  }
  Object.defineProperty(eL, "name", { value: ats });
  const start = () =>
    w.JobsPageSession.run(eL, { ...options, jobsAdapterId: ats });
  const send = (msg) =>
    new Promise((resolve) => {
      for (const listener of listeners) listener(msg, { id: "test" }, resolve);
    });
  return {
    w,
    doc: w.document,
    sent,
    options,
    actual: () => actual,
    start,
    send,
    close() {
      w.JobsDiagnostics.stop();
      dom.window.close();
    },
  };
}
test("form mutation bursts share the scheduled diagnostic scan without losing changed fields", async () => {
  const h = harness(
    '<label>Answer<input value="Known"></label><span id="validation">Ready</span>',
  );
  try {
    await h.start();
    await new Promise((resolve) => setTimeout(resolve, 260));
    const reader = h.w.JobsControlFields.create(h.doc);
    let scans = 0;
    const scan = reader.scan;
    reader.scan = () => {
      scans++;
      return scan();
    };
    h.w.JobsDiagnostics.useReader(reader);
    const initial = h.w.JobsDiagnostics.snapshot();
    scans = 0;
    for (let i = 0; i < 40; i++) {
      h.doc.getElementById("validation").className = "status-" + i;
      await Promise.resolve();
    }
    h.doc.querySelector("input").value = "";
    h.doc.querySelector("input").setAttribute("aria-invalid", "true");
    h.doc
      .querySelector("form")
      .insertAdjacentHTML(
        "beforeend",
        "<label>Conditional<input required></label>",
      );
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert(
      scans <= 2,
      `diagnostics rescanned ${scans} times for one mutation burst`,
    );
    const report = h.sent
      .filter((item) => item.type === "jobs:diagnostics-push")
      .at(-1).report;
    assert.equal(report.fields.length, 2);
    assert.equal(report.fields[0].invalid, true);
    assert(
      report.events.some(
        (e) =>
          e.type === "field_value_lost" && e.fieldId === initial.fields[0].id,
      ),
    );
  } finally {
    h.close();
  }
});

test("unrelated DOM animation skips full scans while new fields and ancestor visibility still trigger observation", async () => {
  const h = harness();
  try {
    await h.start();
    await new Promise((resolve) => setTimeout(resolve, 260));
    let scans = 0;
    const query = h.doc.querySelectorAll.bind(h.doc);
    h.doc.querySelectorAll = (...args) => {
      scans++;
      return query(...args);
    };
    const noise = h.doc.createElement("div");
    h.doc.body.append(noise);
    for (let i = 0; i < 40; i++) {
      noise.className = "animation" + i;
      noise.textContent = String(i);
    }
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(scans, 0);
    h.doc
      .querySelector("form")
      .insertAdjacentHTML(
        "beforeend",
        "<label>New question<input required></label>",
      );
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert(scans > 0);
    assert.equal(h.w.JobsDiagnostics.snapshot().fields.length, 2);
    scans = 0;
    h.doc.body.setAttribute("aria-hidden", "true");
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert(scans > 0);
  } finally {
    h.close();
  }
});

test("read-only diagnostics preserve upstream flags and expose no writable field API", async () => {
  const h = harness();
  try {
    assert.equal(await h.start(), 42);
    assert.equal(h.actual().autofillSettings, h.options.autofillSettings);
    assert.equal(h.w.JobsControlFields.create(h.doc).apply, undefined);
    const snapshot = (await h.send({ type: "jobs:control-inspect" })).data;
    assert.deepEqual([...snapshot.actions], ["inspect"]);
    const blocked = await h.send({
      type: "jobs:control-execute",
      command: { id: "not-authorized" },
    });
    assert.match(blocked.error, /disabled/);
    assert.equal(h.doc.querySelector("input").value, "");
  } finally {
    h.close();
  }
});

for (const phase of ["complete-required", "ai-review"])
  test(`${phase} archives an inert case automatically and manual capture rejects a replaced page`, async () => {
    const h = harness(
      '<label>Private employer<input required aria-invalid="true" value="PRIVATE_ANSWER"></label>',
    );
    try {
      await h.start();
      h.actual().setMessage(phase);
      await new Promise((r) => setTimeout(r, 260));
      const cases = h.sent.filter((m) => m.type === "jobs:repro-push");
      assert(cases.length > 0);
      assert(!JSON.stringify(cases).includes("PRIVATE_ANSWER"));
      assert.equal(h.doc.querySelector("input").value, "PRIVATE_ANSWER");
      const sessionId = h.w.JobsDiagnostics.snapshot().sessionId;
      assert.match(
        (
          await h.send({
            type: "jobs:repro-capture",
            sessionId: "old-document",
          })
        ).error,
        /页面已切换/,
      );
      assert.equal(
        (await h.send({ type: "jobs:repro-capture", sessionId })).data.captured,
        true,
      );
    } finally {
      h.close();
    }
  });

test("Workday grouped input links to the question and records a later property-only reset without filling or navigating", async () => {
  const h = harness(
    '<div data-automation-id="applyFlowPage"><fieldset><legend>Please check one of the boxes below:</legend><fieldset id="choice" data-automation-id="choice-CheckboxGroup" aria-required="true"><div role="cell"><input type="checkbox" id="a"><label for="a">Choice A</label></div><div role="cell"><input type="checkbox" id="b"><label for="b">Choice B</label></div></fieldset></fieldset><button type="button">Save and Continue</button></div>',
    { ats: "workday", url: "https://fixture.myworkdayjobs.com/apply" },
  );
  try {
    await h.start();
    const field = (await h.send({ type: "jobs:control-inspect" })).data
        .fields[0],
      node = h.doc.getElementById("b");
    let clicks = 0;
    h.doc.querySelector("button").onclick = () => clicks++;
    node.checked = true;
    node.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    node.checked = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const report = h.w.JobsDiagnostics.snapshot();
    assert(
      report.events.some(
        (e) => e.type === "field_event" && e.fieldId === field.id,
      ),
    );
    const lost = report.events.find(
      (e) => e.type === "field_value_lost" && e.fieldId === field.id,
    );
    assert(lost);
    const detail = JSON.parse(lost.detail);
    assert.equal(detail.before.checked, 1);
    assert.equal(detail.after.checked, 0);
    assert.equal(detail.after.connected, true);
    const shape = h.w.JobsDiagnostics.recentEvents().find(
      (e) => e.type === "field_structure" && e.fieldId === field.id,
    );
    assert(shape);
    assert.match(shape.detail, /checkbox/);
    assert.equal(clicks, 0);
    assert.equal(node.checked, false);
    assert.equal(h.sent.filter((m) => m.type === "saveResponses").length, 0);
  } finally {
    h.close();
  }
});

test("replaced controls retain the link to the previous field without exposing the answer", async () => {
  const h = harness(
    '<label for="summary">Summary</label><input id="summary" value="private content">',
  );
  try {
    await h.start();
    const old = h.doc.getElementById("summary"),
      before = h.w.JobsDiagnostics.snapshot().fields[0].id;
    const replacement = old.cloneNode();
    replacement.value = "";
    old.replaceWith(replacement);
    const report = h.w.JobsDiagnostics.snapshot();
    const changed = report.events.find((e) => e.type === "field_replaced");
    assert(changed);
    assert.equal(JSON.parse(changed.detail).previousId, before);
    assert.notEqual(changed.fieldId, before);
    assert(
      report.events.some(
        (e) => e.type === "field_detached" && e.fieldId === before,
      ),
    );
    assert(!JSON.stringify(report).includes("private content"));
  } finally {
    h.close();
  }
});

test("custom choice reset follows the shared field value, not an absent native input value", async () => {
  const h = harness(
    '<div class="ashby-application-form-field-entry"><div class="ashby-application-form-question-title">Can you travel?</div><div class="ashby-application-form-input-yesno"><button data-option="yes" aria-pressed="true">Yes</button><button data-option="no" aria-pressed="false">No</button></div></div>',
  );
  try {
    await h.start();
    const before = h.w.JobsDiagnostics.snapshot().fields[0];
    assert.equal(before.kind, "yesno");
    assert.equal(before.hasValue, true);
    h.doc
      .querySelector('[aria-pressed="true"]')
      .setAttribute("aria-pressed", "false");
    const report = h.w.JobsDiagnostics.snapshot();
    assert.equal(report.fields[0].hasValue, false);
    assert(
      report.events.some(
        (event) =>
          event.type === "field_value_lost" && event.fieldId === before.id,
      ),
    );
  } finally {
    h.close();
  }
});

test("a batch of field reset probes shares scans instead of scanning once per field", async () => {
  const h = harness(
    Array.from(
      { length: 20 },
      (_, i) => `<label>Answer ${i}<input value="Known"></label>`,
    ).join(""),
  );
  try {
    await h.start();
    const reader = h.w.JobsControlFields.create(h.doc);
    let scans = 0;
    const scan = reader.scan;
    reader.scan = () => {
      scans++;
      return scan();
    };
    h.w.JobsDiagnostics.useReader(reader);
    for (const input of h.doc.querySelectorAll("input")) {
      input.dispatchEvent(new h.w.Event("input", { bubbles: true }));
      input.value = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert(
      scans <= 4,
      `20 fields should share bounded reads, observed ${scans}`,
    );
    const report = h.w.JobsDiagnostics.snapshot();
    assert.equal(
      report.events.filter((event) => event.type === "field_value_lost").length,
      20,
    );
  } finally {
    h.close();
  }
});

test("a late field retains its full reset probe window within a shared batch", async () => {
  const h = harness(
    '<label>First<input value="Known"></label><label>Second<input value="Known"></label>',
  );
  try {
    await h.start();
    const [first, second] = h.doc.querySelectorAll("input");
    first.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    second.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    second.value = "";
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Reading the wire events must not itself refresh the controls and hide a
    // missing timer: the late reset has to have been observed already.
    assert(
      h.w.JobsDiagnostics.recentEvents().some(
        (event) => event.type === "field_value_lost",
      ),
    );
  } finally {
    h.close();
  }
});

test("build identity and reset evidence survive noise while secrets are excluded", async () => {
  const h = harness(
    '<label>Summary<input></label><label>Password<input type="password"></label>',
  );
  try {
    h.w.JobsBuildInfo = { id: "0123456789abcdef" };
    await h.start();
    const secret = h.doc.querySelector('[type="password"]');
    secret.value = "private-password";
    secret.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    h.w.JobsDiagnostics.note(
      "field_value_lost",
      h.doc.querySelector("input"),
      "observed reset",
    );
    for (let i = 0; i < 70; i++)
      h.w.JobsDiagnostics.note("input", h.doc.querySelector("input"));
    const report = h.w.JobsDiagnostics.recentEvents();
    assert(report.length <= 50);
    assert(report.some((e) => e.type === "field_value_lost"));
    assert(
      report.some(
        (e) => e.type === "build_info" && e.detail.includes("0123456789abcdef"),
      ),
    );
    assert(
      !JSON.stringify(h.w.JobsDiagnostics.snapshot()).includes(
        "private-password",
      ),
    );
  } finally {
    h.close();
  }
});
test("one shared field ID links original answer lookup, input action, current value and later validation error", async () => {
  const h = harness();
  try {
    await h.start();
    const node = h.doc.querySelector("input");
    h.w.JobsDiagnostics.answers([{ question: "Summary" }], []);
    assert.equal(
      h.w.JobsDiagnostics.snapshot().fields[0].status,
      "validation_error",
    );
    const promise = Promise.resolve(node);
    assert.equal(
      h.w.JobsDiagnostics.perform(
        "text",
        () => node,
        () => {
          node.value = "Example private answer";
          node.dispatchEvent(new h.w.Event("input", { bubbles: true }));
          return promise;
        },
      ),
      promise,
    );
    await promise;
    await Promise.resolve();
    const diagnostic = h.w.JobsDiagnostics.snapshot(),
      wire = (await h.send({ type: "jobs:control-inspect" })).data;
    assert.equal(diagnostic.fields[0].id, wire.fields[0].id);
    assert.equal(diagnostic.fields[0].attempts, 1);
    assert(
      diagnostic.events.some(
        (e) =>
          e.type === "answer_resolution" && e.fieldId === wire.fields[0].id,
      ),
    );
    // The field's own record shows what it holds; the event stream never carries values.
    assert.equal(diagnostic.fields[0].value, "Example private answer");
    assert(
      !JSON.stringify(diagnostic.events).includes("Example private answer"),
    );
    assert.equal(wire.fields[0].value, "Example private answer");
    assert(!JSON.stringify(wire).includes("token=secret"));
    node.setAttribute("aria-invalid", "true");
    assert.equal(
      h.w.JobsDiagnostics.snapshot().fields[0].status,
      "validation_error",
    );
  } finally {
    h.close();
  }
});
test("logger preserves original errors and bounds metadata-only event history", async () => {
  const h = harness(
    '<label>Summary<input></label><label>Password<input type="password" value="must-not-leak"></label>',
  );
  try {
    await h.start();
    const original = Error("original");
    assert.throws(
      () =>
        h.w.JobsDiagnostics.perform(
          "text",
          () => h.doc.querySelector("input"),
          () => {
            throw original;
          },
        ),
      (error) => error === original,
    );
    for (let i = 0; i < 340; i++)
      h.w.JobsDiagnostics.note("sample", h.doc.querySelector("input"));
    const report = h.w.JobsDiagnostics.snapshot();
    assert.equal(report.events.length, 300);
    assert(report.droppedEvents > 0);
    assert(!JSON.stringify(report).includes("must-not-leak"));
  } finally {
    h.close();
  }
});

test("exact Profile version survives the event ring without retaining personal facts", async () => {
  const h = harness();
  try {
    await h.start();
    const id = "0da50c18-59a3-4f7f-9fa7-123456789012",
      revision = "2026-09-20T05:41:03.884037+00:00";
    h.w.JobsDiagnostics.profile({
      id,
      profileName: "Intern",
      revision,
      profile: { applicationData: { aiNotes: "PRIVATE_PROFILE_FACTS" } },
    });
    for (let i = 0; i < 350; i++)
      h.w.JobsDiagnostics.note(
        "auto_control_result",
        h.doc.querySelector("input"),
        "activity",
      );
    for (const events of [
      h.w.JobsDiagnostics.recentEvents(),
      h.w.JobsDiagnostics.snapshot().events,
    ]) {
      const found = events.filter((event) => event.type === "profile_version");
      assert.equal(found.length, 1);
      const detail = JSON.parse(found[0].detail);
      assert.equal(detail.profileId, id);
      assert.equal(detail.revision, revision);
      assert.equal(detail.hasAdditional, true);
      assert.equal(detail.hasAiNotes, true);
      assert(!JSON.stringify(events).includes("PRIVATE_PROFILE_FACTS"));
    }
    assert(h.w.JobsDiagnostics.recentEvents().length <= 50);
    assert(h.w.JobsDiagnostics.snapshot().events.length <= 300);
    await h.start();
    assert(
      !h.w.JobsDiagnostics.recentEvents().some(
        (event) => event.type === "profile_version",
      ),
    );
  } finally {
    h.close();
  }
});

test("answer decisions retain per-field provenance for duplicate labels without logging answer values", async () => {
  const h = harness(
    '<label for="first">Graduation date</label><input id="first" type="month"><label for="second">Graduation date</label><input id="second" type="date">',
  );
  try {
    await h.start();
    const rows = h.w.JobsControlFields.create(h.doc).scan();
    h.w.JobsDiagnostics.answers(
      rows.map((row) => ({ ...row.public, fieldId: row.public.id })),
      [{ index: 0, answer: "2027-05" }],
      [
        {
          index: 0,
          status: "answered",
          source: "profile",
          field: "educationData.endDate",
          reason: "profile",
          answer: "private-answer",
        },
        {
          index: 1,
          status: "needs-input",
          source: "profile",
          field: "educationData.endDate",
          reason: "missing_day_precision",
        },
      ],
    );
    for (let i = 0; i < 65; i++)
      h.w.JobsDiagnostics.note("input", h.doc.querySelector("input"));
    const events = h.w.JobsDiagnostics.recentEvents().filter(
      (event) => event.type === "answer_decision",
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].fieldId, rows[0].public.id);
    assert.equal(events[1].fieldId, rows[1].public.id);
    assert.equal(JSON.parse(events[0].detail).inputType, "month");
    assert.equal(JSON.parse(events[1].detail).reason, "missing_day_precision");
    assert(
      !JSON.stringify(h.w.JobsDiagnostics.snapshot()).includes(
        "private-answer",
      ),
    );
  } finally {
    h.close();
  }
});

test("waiting and failure evidence survive noisy input events in the remote observation window", async () => {
  const h = harness();
  try {
    await h.start();
    h.w.JobsDiagnostics.note(
      "auto_options_wait",
      h.doc.querySelector("input"),
      "Waiting for options",
    );
    for (let i = 0; i < 70; i++)
      h.w.JobsDiagnostics.note("input", h.doc.querySelector("input"));
    const events = h.w.JobsDiagnostics.recentEvents();
    assert(events.length <= 50);
    assert(events.some((event) => event.type === "auto_options_wait"));
  } finally {
    h.close();
  }
});

test("answer provenance survives later control activity and the bounded event ring", async () => {
  const h = harness(
    '<label for="referral">If you were referred by someone, please list them here:</label><input id="referral">',
  );
  try {
    await h.start();
    const node = h.doc.getElementById("referral");
    h.w.JobsDiagnostics.answers(
      [
        {
          question: "If you were referred by someone, please list them here:",
          type: "text",
        },
      ],
      [{ index: 0, answer: "private answer" }],
      [
        {
          index: 0,
          status: "answered",
          source: "saved",
          reason: "keyword_match",
          ruleId: "fixture-rule",
        },
      ],
    );
    h.w.JobsDiagnostics.note("auto_control_write", node, "text");
    h.w.JobsDiagnostics.answers(
      [
        {
          question: "If you were referred by someone, please list them here:",
          type: "text",
        },
      ],
      [],
      [
        {
          index: 0,
          status: "unmatched",
          source: "none",
          reason: "no_matching_rule",
        },
      ],
    );
    for (let i = 0; i < 350; i++)
      h.w.JobsDiagnostics.note("auto_control_result", node, "later activity");
    const report = h.w.JobsDiagnostics.snapshot(),
      wire = h.w.JobsDiagnostics.recentEvents();
    const decision = wire.find((event) => event.type === "answer_decision");
    assert(decision);
    assert.equal(JSON.parse(decision.detail).ruleId, "fixture-rule");
    assert.equal(report.fields[0].decision.source, "none");
    assert.equal(report.fields[0].writeDecision.source, "saved");
    assert(wire.length <= 50);
    assert(!JSON.stringify(report).includes("private answer"));
  } finally {
    h.close();
  }
});

test("independent readers cannot assign one field identity to different controls", async () => {
  const h = harness(
    '<label for="name">Full Name</label><input id="name"><section><label for="referral">Referral</label><input id="referral"></section>',
  );
  try {
    await h.start();
    const narrow = h.w.JobsControlFields.create(h.doc, () =>
      h.doc.querySelector("section"),
    ).scan();
    const broad = h.w.JobsControlFields.create(h.doc).scan();
    assert.equal(
      narrow[0].public.id,
      broad.find((row) => row.node.id === "referral").public.id,
    );
    assert.notEqual(
      narrow[0].public.id,
      broad.find((row) => row.node.id === "name").public.id,
    );
  } finally {
    h.close();
  }
});
test("Luna completion uses ordinary saveResponses, respects disabled saving and skips invalid or detached inputs", async () => {
  const dom = new JSDOM("<textarea></textarea>", {
      url: "https://jobs.ashbyhq.com/test/role/application",
      runScripts: "outside-only",
    }),
    w = dom.window,
    sent = [],
    tasks = new Map();
  let id = 0;
  w.setTimeout = (fn) => {
    tasks.set(++id, fn);
    return id;
  };
  w.clearTimeout = (n) => tasks.delete(n);
  w.chrome = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        return { ok: true };
      },
    },
  };
  w.JobsControlConfig = { observe: true };
  w.eval(modules["control-fields"]);
  w.eval(modules["job-match-rules"]);
  w.eval(modules["job-match"]);
  w.eval(modules["answer-memory"]);
  const node = w.document.querySelector("textarea"),
    memory = w.JobsAnswerMemory;
  const flush = () => {
    for (const [key, fn] of [...tasks]) {
      tasks.delete(key);
      fn();
    }
  };
  try {
    node.value = "Known answer";
    memory.configure(false);
    memory.remember("Question", node);
    flush();
    assert.equal(sent.length, 0);
    memory.configure(true);
    memory.remember("Question", node);
    flush();
    assert.equal(sent[0].type, "saveResponses");
    assert.equal(sent[0].data[0].response, "Known answer");
    await Promise.resolve();
    await Promise.resolve();
    node.setAttribute("aria-invalid", "true");
    memory.remember("Question", node);
    flush();
    assert.equal(sent.length, 1);
    node.removeAttribute("aria-invalid");
    node.remove();
    memory.remember("Question", node);
    flush();
    assert.equal(sent.length, 1);
  } finally {
    dom.window.close();
  }
});

test("connection invalidation clears raw diagnostics and pending manual answers", async () => {
  const h = harness();
  try {
    h.w.eval(modules["answer-memory"]);
    await h.start();
    const saves = [];
    h.w.JobsAnswerMemory.start(h.doc, true, (entries) => saves.push(entries));
    const input = h.doc.querySelector("input");
    input.value = "SYNTHETIC_PRIVATE_ANSWER";
    h.w.JobsDiagnostics.note("manual_input", input, "synthetic");
    h.w.JobsAnswerMemory.remember("Synthetic summary", input, {
      requireReview: true,
    });
    await h.send({ type: "jobs:private-session-invalidated" });
    h.w.JobsAnswerMemory.confirmReview([input]);
    h.w.JobsAnswerMemory.flush();
    assert.equal(saves.length, 0);
    assert.throws(() => h.w.JobsDiagnostics.snapshot(), /No matched ATS/);
    assert.equal(input.value, "SYNTHETIC_PRIVATE_ANSWER");
  } finally {
    h.close();
  }
});
