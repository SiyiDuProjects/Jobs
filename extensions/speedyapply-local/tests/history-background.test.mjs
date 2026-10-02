import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
const source = await readWithDependencies(
  new URL("../src/custom/history-background.js", import.meta.url),
  "utf8",
);
function setup(local = {}, session = {}, now = Date.now()) {
  const context = vm.createContext({
    URL,
    TextEncoder,
    console,
    crypto: webcrypto,
    JobsBuildInfo: { id: "build-fixture" },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    chrome: {
      storage: {
        local: {
          get: async () => structuredClone(local),
          set: async (data) => Object.assign(local, structuredClone(data)),
        },
        session: {
          getKeys: async () => Object.keys(session),
          get: async () => structuredClone(session),
          remove: async (keys) => {
            for (const key of keys) delete session[key];
          },
          set: async (data) => Object.assign(session, structuredClone(data)),
        },
      },
    },
  });
  vm.runInContext(source, context);
  return { api: context.JobsDiagnosticHistory, local, session, context };
}
function report(job = 1, at = Date.now()) {
  return {
    valuePolicy: "fill_trace_values_only",
    sessionId: "doc-1",
    runId: "run-1",
    ats: "workday",
    startedAt: at,
    observedAt: at,
    pageUrl: `https://example.wd1.myworkdayjobs.com/en-US/careers/job/Role_R${job}/apply`,
    phase: "complete-manually",
    step: "myExperiencePage",
    fields: [
      {
        id: "f1",
        question: "Company",
        kind: "text",
        required: true,
        hasValue: true,
        invalid: true,
        status: "validation_error",
        attempts: 1,
        value: "PRIVATE_ANSWER",
      },
    ],
    events: [
      { at, type: "phase", detail: "complete-manually" },
      {
        at: at + 1,
        type: "auto_known_answer_applied",
        fieldId: "f1",
        detail: "PRIVATE_EVENT_DETAIL",
      },
    ],
  };
}

test("storage property reordering cannot duplicate cumulative diagnostic events", async () => {
  const h = setup();
  const first = report();
  await h.api.capture(first);
  const entry = Object.values(h.local.jobsDiagnosticHistoryV1.applications)[0];
  entry.data.events = entry.data.events.map((event) =>
    Object.fromEntries(Object.entries(event).reverse()),
  );
  entry.data.events.push({ ...entry.data.events[0] });
  const restarted = setup(h.local, h.session);
  await restarted.api.capture({ ...first, observedAt: first.observedAt + 10 });
  const batch = await restarted.api.pending(300000);
  assert.equal(batch.items[0].events.length, 2);
  await restarted.api.capture({
    ...first,
    observedAt: first.observedAt + 20,
    events: [
      ...first.events,
      { at: first.events[0].at, type: "phase", detail: "page-complete" },
    ],
  });
  assert.equal((await restarted.api.pending(300000)).items[0].events.length, 3);
});
test("closed-tab records survive worker restart as synthetic values, without arbitrary details", async () => {
  const h = setup();
  await h.api.capture(report());
  const restarted = setup(h.local, h.session),
    pending = await restarted.api.pending(300000);
  assert.equal(pending.items.length, 1);
  assert(!JSON.stringify(h.local).includes("PRIVATE_"));
  assert.match(
    pending.items[0].snapshots[0].fields[0].value,
    /^synthetic-[a-f0-9]{32}$/,
  );
  assert.equal(pending.items[0].schemaVersion, 2);
  assert.equal(pending.items[0].runId, "run-1");
  assert.equal(pending.items[0].build, "build-fixture");
  assert.equal(pending.items[0].events[0].phase, "complete-manually");
  await restarted.api.acknowledge(pending.ack);
  assert.equal((await restarted.api.pending(300000)).items.length, 0);
});

test("diagnostic recovery pause stops the page but keeps the unacknowledged diagnostic run", async () => {
  const h = setup(
    { jobsSyncV1: { profileToken: "x".repeat(64) } },
    { profile_1: { profile: "Synthetic" } },
  );
  h.context.JobsSync = { ready: Promise.resolve() };
  h.context.JobsManagementSync = { pendingSnapshot: async () => ({}) };
  h.context.AbortSignal = AbortSignal;
  h.context.fetch = async () =>
    Response.json({ code: "recovery_application_pause" }, { status: 503 });
  await h.api.capture(report());
  await assert.rejects(h.api.sync(), { code: "recovery_application_pause" });
  assert.equal(h.session.profile_1, undefined);
  assert.equal((await h.api.pending(300000)).items.length, 1);
});

test("one run merges steps, a later run remains distinct, and a stale ack cannot discard changes", async () => {
  const h = setup(),
    first = report();
  await h.api.capture(first);
  await h.api.capture(first);
  const next = {
    ...first,
    observedAt: first.observedAt + 1000,
    phase: "ai-filling",
    pageUrl: first.pageUrl + "/questions",
  };
  await h.api.capture(next);
  const pending = await h.api.pending(300000);
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].snapshots.length, 2);
  const later = {
    ...next,
    observedAt: next.observedAt + 1000,
    phase: "page-complete",
  };
  await h.api.capture(later);
  await h.api.acknowledge(pending.ack);
  assert.equal((await h.api.pending(300000)).items.length, 1);
  await h.api.capture({ ...later, runId: "run-2" });
  assert.equal((await h.api.pending(300000)).items.length, 2);
});

test("ordinary acknowledged records expire after 30 days; offline and unresolved cases remain", async () => {
  const now = Date.now(),
    old = now - 31 * 86400000,
    h = setup({}, {}, now);
  for (let i = 1; i <= 4; i++) await h.api.capture(report(i, old));
  const sent = await h.api.pending(300000);
  await h.api.pin(report(2).pageUrl);
  await h.api.acknowledge(sent.ack.filter((_, i) => i < 3));
  await h.api.capture(report(5, now));
  const records = Object.values(h.local.jobsDiagnosticHistoryV1.applications);
  assert.equal(records.length, 3);
  assert(records.some((row) => row.pinned));
  assert(
    records.some(
      (row) => row.ack !== row.revision && row.data.lastSeen === old,
    ),
  );
  const p = report(5, now + 1);
  p.fields.push({
    ...p.fields[0],
    id: "secret",
    question: "Verification code",
    value: "123456",
  });
  await h.api.capture(p);
  assert(!JSON.stringify(h.local).includes("Verification code"));
  assert.equal((await h.api.pending(1)).items.length, 0);
});

test("history has bounded snapshots and payloads with explicit truncation", async () => {
  const h = setup();
  for (let i = 0; i < 75; i++) {
    const p = report(1, 1000 + i);
    p.phase = "phase-" + i;
    await h.api.capture(p);
  }
  const item = (await h.api.pending(300000)).items[0];
  assert(item.truncated);
  assert.equal(item.snapshots.length, 60);
  assert(Buffer.byteLength(JSON.stringify(item)) <= 150000);
});

test("synthetic tokens retain equality and distinctions across traces and restart without leaking options", async () => {
  const h = setup(),
    r = report();
  r.fields[0].decision = {
    status: "answered",
    source: "profile",
    reason: "profile",
    field: "educationData.degree",
    extra: "dropped",
  };
  r.fields[0].traces = [
    {
      source: "adapter",
      topic: "degree",
      answer: "PRIVATE_ANSWER",
      result: "committed",
      chosen: "PRIVATE_OPTION",
      readback: "PRIVATE_ANSWER",
      method: "exact",
      optionCount: 30,
      options: ["PRIVATE_OPTION", "OTHER_OPTION"],
      at: 5,
    },
  ];
  await h.api.capture(r);
  const field = (await h.api.pending(300000)).items[0].snapshots[0].fields[0];
  assert.deepEqual(
    { ...field.decision },
    {
      status: "answered",
      source: "profile",
      reason: "profile",
      field: "educationData.degree",
    },
  );
  assert.equal(field.trace.answer, field.value);
  assert.equal(field.trace.readback, field.value);
  assert.equal(field.trace.options[0], field.trace.chosen);
  assert.notEqual(field.trace.options[1], field.trace.chosen);
  assert.equal(field.trace.at, 5);
  const restarted = setup(h.local, h.session);
  await restarted.api.capture({
    ...r,
    observedAt: r.observedAt + 1000,
    phase: "checked",
  });
  assert.equal(
    (await restarted.api.pending(300000)).items[0].snapshots.at(-1).fields[0]
      .value,
    field.value,
  );
  assert(!JSON.stringify(h.local).includes("PRIVATE_"));
  assert(!JSON.stringify(h.local).includes("OTHER_OPTION"));
  const anotherSession = setup();
  await anotherSession.api.capture(r);
  assert.notEqual(
    (await anotherSession.api.pending(300000)).items[0].snapshots[0].fields[0]
      .value,
    field.value,
  );
});

test("case retention persists monotonic revisions before capture and after resolution without losing late updates", async () => {
  const h = setup(),
    r = report();
  await h.api.caseRetention(r.pageUrl, r.runId, ["case-a"]);
  await h.api.capture(r);
  let batch = await h.api.pending(300000);
  assert.deepEqual(
    {
      ...batch.items[0].caseRetention,
      unresolvedCaseIds: [...batch.items[0].caseRetention.unresolvedCaseIds],
    },
    { revision: 1, unresolvedCaseIds: ["case-a"] },
  );
  await h.api.acknowledge(batch.ack);
  assert.equal((await h.api.pending(300000)).items.length, 0);
  const reboot = setup(h.local, h.session);
  await reboot.api.caseRetention(r.pageUrl, r.runId, ["case-a"]);
  assert.equal((await reboot.api.pending(300000)).items.length, 0);
  await reboot.api.caseRetention(r.pageUrl, r.runId, ["case-b", "case-a"]);
  batch = await reboot.api.pending(300000);
  assert.equal(batch.items[0].caseRetention.revision, 2);
  await reboot.api.caseRetention(r.pageUrl, r.runId, []);
  await reboot.api.acknowledge(batch.ack);
  batch = await reboot.api.pending(300000);
  assert.equal(batch.items[0].caseRetention.revision, 3);
  assert.equal(batch.items[0].caseRetention.unresolvedCaseIds.length, 0);
  await assert.rejects(
    reboot.api.caseRetention(r.pageUrl, r.runId, [
      "private email@example.test",
    ]),
    /Invalid/,
  );
});

test("an entirely unrecognized form still retains diagnostic evidence", async () => {
  const h = setup(),
    r = report();
  r.fields = [];
  r.unansweredContainers = [
    {
      question: "Start date",
      reason: "interactive-without-field",
      structure: "div[role=spinbutton]",
    },
  ];
  await h.api.capture(r);
  const item = (await h.api.pending(300000)).items[0];
  assert.equal(item.snapshots[0].unrecognized[0].question, "Start date");
});

test("archive capacity never evicts pinned or unacknowledged runs", async () => {
  const h = setup();
  await h.api.capture(report());
  const prototype = Object.values(
    h.local.jobsDiagnosticHistoryV1.applications,
  )[0];
  h.local.jobsDiagnosticHistoryV1.applications = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      "retained-" + i,
      { ...structuredClone(prototype), pinned: i % 2 === 0 },
    ]),
  );
  const before = JSON.stringify(h.local);
  await assert.rejects(h.api.capture(report(2)), /存储已满/);
  assert.equal(JSON.stringify(h.local), before);
});

test("an old connection acknowledgement leaves synthetic history pending for the current connection", async () => {
  const h = setup({ jobsSyncV1: { profileToken: "old-grant" } });
  await h.api.capture(report());
  const started = Promise.withResolvers(),
    late = Promise.withResolvers();
  h.context.JobsSync = { ready: Promise.resolve() };
  h.context.JobsBrand = { origin: "https://synthetic.example" };
  h.context.AbortSignal = AbortSignal;
  h.context.fetch = async () => {
    started.resolve();
    return late.promise;
  };
  const task = h.api.sync();
  await started.promise;
  await h.context.JobsPrivateSession.clear();
  late.resolve({ ok: true, json: async () => ({ historyAccepted: true }) });
  await assert.rejects(task, /连接已改变/);
  assert.equal((await h.api.pending(300000)).items.length, 1);
});
