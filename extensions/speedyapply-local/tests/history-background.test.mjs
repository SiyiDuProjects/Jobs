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
          getKeys: async () => Object.keys(local),
          get: async (keys) =>
            structuredClone(
              Object.fromEntries([keys].flat().map((k) => [k, local[k]])),
            ),
          remove: async (keys) => {
            for (const k of [keys].flat()) delete local[k];
          },
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
function archive(local) {
  const index = local.jobsDiagnosticHistoryV1;
  return index.version === 2
    ? {
        applications: Object.fromEntries(
          Object.entries(index.applications).map(([k, v]) => [
            k,
            local[v.storageKey],
          ]),
        ),
      }
    : index;
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
  const entry = Object.values(archive(h.local).applications)[0];
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
  const records = Object.values(archive(h.local).applications);
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
  const prototype = Object.values(archive(h.local).applications)[0];
  h.local.jobsDiagnosticHistoryV1 = {
    applications: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        "retained-" + i,
        { ...structuredClone(prototype), pinned: i % 2 === 0 },
      ]),
    ),
  };
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

test("a small capture reads and rewrites only its run plus a compact index", async () => {
  const h = setup();
  for (let i = 1; i <= 8; i++) await h.api.capture(report(i));
  const storage = h.context.chrome.storage.local,
    gets = [],
    sets = [];
  const get = storage.get,
    set = storage.set;
  storage.get = async (keys) => {
    gets.push(...[keys].flat());
    return get(keys);
  };
  storage.set = async (value) => {
    sets.push(value);
    return set(value);
  };
  await h.api.capture({ ...report(1), phase: "page-complete" });
  assert.equal(
    gets.filter((k) => k.startsWith("jobsDiagnosticRunV2:")).length,
    1,
  );
  assert.equal(
    sets
      .flatMap((v) => Object.keys(v))
      .filter((k) => k.startsWith("jobsDiagnosticRunV2:")).length,
    1,
  );
  const index = h.local.jobsDiagnosticHistoryV1;
  assert.equal(index.version, 2);
  assert(
    Object.values(index.applications).every(
      (row) =>
        !("signature" in row.summary) && !("snapshots" in row.summary.data),
    ),
  );
  const restarted = setup(h.local, h.session);
  assert.equal((await restarted.api.pending(300000)).items.length, 8);
});

test("failed index publication preserves the previous run and can retry after restart", async () => {
  const h = setup(),
    first = report();
  await h.api.capture(first);
  const old = JSON.stringify(h.local.jobsDiagnosticHistoryV1),
    set = h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set = async (value) => {
    if (value.jobsDiagnosticHistoryV1) throw Error("synthetic index failure");
    return set(value);
  };
  await assert.rejects(
    h.api.capture({ ...first, phase: "page-complete" }),
    /index failure/,
  );
  assert.equal(JSON.stringify(h.local.jobsDiagnosticHistoryV1), old);
  const restarted = setup(h.local, h.session);
  assert.equal(
    (await restarted.api.pending(300000)).items[0].snapshots.length,
    1,
  );
  await restarted.api.capture({ ...first, phase: "page-complete" });
  assert.equal(
    (await restarted.api.pending(300000)).items[0].snapshots.length,
    2,
  );
});

test("legacy archive upgrades losslessly and remains intact if payload persistence fails", async () => {
  const seed = setup();
  await seed.api.capture(report());
  const legacy = structuredClone(archive(seed.local));
  const h = setup({ jobsDiagnosticHistoryV1: legacy }, seed.session);
  h.context.chrome.storage.local.set = async () => {
    throw Error("synthetic disk failure");
  };
  await assert.rejects(
    h.api.capture({ ...report(), phase: "page-complete" }),
    /disk failure/,
  );
  assert.deepEqual(h.local.jobsDiagnosticHistoryV1, legacy);
  const restarted = setup(h.local, h.session);
  await restarted.api.capture({ ...report(), phase: "page-complete" });
  assert.equal(h.local.jobsDiagnosticHistoryV1.version, 2);
  assert.equal(
    (await restarted.api.pending(300000)).items[0].snapshots.length,
    2,
  );
});

test("an interrupted payload cleanup is retried and missing live data never becomes an empty run", async () => {
  const h = setup(),
    first = report();
  await h.api.capture(first);
  const remove = h.context.chrome.storage.local.remove;
  h.context.chrome.storage.local.remove = async () => {
    throw Error("cleanup interrupted");
  };
  await h.api.capture({ ...first, phase: "page-complete" });
  const garbage = [...h.local.jobsDiagnosticHistoryV1.garbage];
  assert(garbage.length);
  const restarted = setup(h.local, h.session);
  await restarted.api.pending(300000);
  assert(garbage.every((key) => !h.local[key]));
  const live = Object.values(h.local.jobsDiagnosticHistoryV1.applications)[0]
    .storageKey;
  await remove(live);
  const before = JSON.stringify(h.local.jobsDiagnosticHistoryV1);
  await assert.rejects(restarted.api.capture(first), /诊断记录不完整/);
  assert.equal(JSON.stringify(h.local.jobsDiagnosticHistoryV1), before);
});

function connectedHistory() {
  const h = setup({ jobsSyncV1: { profileToken: "synthetic-old-grant" } });
  h.context.JobsSync = { ready: Promise.resolve() };
  h.context.JobsBrand = { origin: "https://synthetic.example" };
  h.context.AbortSignal = AbortSignal;
  h.context.fetch = async () => ({
    ok: true,
    json: async () => ({ historyAccepted: true }),
  });
  return h;
}

function timedReport() {
  const value = report();
  value.events.push(
    { at: value.startedAt + 2, type: "visibility_changed", detail: "hidden" },
    {
      at: value.startedAt + 3,
      type: "auto_write_timing",
      fieldId: "f1",
      detail: JSON.stringify({
        ms: 1234567,
        heldMs: 20,
        scans: 2,
        answer: "PRIVATE_TIMING_TEXT",
      }),
    },
    {
      at: value.startedAt + 4,
      type: "auto_run_timing",
      detail: JSON.stringify({
        ms: 1234600,
        scans: 9,
        structuralScans: 3,
        writes: {
          writes: 1,
          ms: 1234567,
          heldMs: 20,
          scans: 2,
          url: "PRIVATE_TIMING_TEXT",
        },
        profileChecks: { count: 2, fresh: 1, ms: 30, reused: 1 },
      }),
    },
  );
  return value;
}

test("bounded timings and visibility survive archive restart without arbitrary detail", async () => {
  const h = setup(),
    value = timedReport();
  await h.api.capture(value);
  const restarted = setup(h.local, h.session);
  await restarted.api.capture(value);
  const events = (await restarted.api.pending(300000)).items[0].events;
  assert.equal(events.length, value.events.length);
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-2).timing)), {
    ms: 1234567,
    heldMs: 20,
    scans: 2,
  });
  assert.equal(events.at(-3).visibility, "hidden");
  assert.equal(events.at(-1).timing.profileChecks.fresh, 1);
  assert(!JSON.stringify(h.local).includes("PRIVATE_TIMING_TEXT"));
  const invalid = [
    { type: "visibility_changed", detail: "PRIVATE_TIMING_TEXT" },
    {
      type: "auto_write_timing",
      detail: JSON.stringify({ ms: -1, heldMs: "12", scans: true }),
    },
    {
      type: "auto_run_timing",
      detail: JSON.stringify({
        ms: 86400001,
        scans: 1.5,
        writes: { scans: 1000001 },
      }),
    },
    { type: "auto_run_timing", detail: "{broken JSON" },
    { type: "arbitrary_event", detail: '{"ms":12}' },
  ];
  await restarted.api.capture({
    ...value,
    events: invalid.map((event, index) => ({
      ...event,
      at: value.startedAt + 10 + index,
    })),
  });
  const bad = (await restarted.api.pending(300000)).items[0].events.slice(
    -invalid.length,
  );
  assert(
    bad.every((event) => !event.timing && !event.visibility && !event.detail),
  );
});

for (const mode of ["old", "new", "rollback"]) {
  test(`timing upload negotiates ${mode} service while keeping the local metrics`, async () => {
    const h = connectedHistory(),
      calls = [];
    await h.api.capture(timedReport());
    h.context.fetch = async (_, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (mode === "rollback" && calls.length === 2)
        return Response.json(
          { error: "Invalid browser control shape" },
          { status: 400 },
        );
      return Response.json({
        historyAccepted: true,
        ...(mode !== "old" ? { historyEventMetrics: 1 } : {}),
      });
    };
    await h.api.sync();
    assert.deepEqual(calls[0], { protocolVersion: 1, history: [] });
    assert.equal(calls.length, mode === "rollback" ? 3 : 2);
    const delivered = calls.at(-1).history[0].events;
    assert.equal(
      delivered.some((event) => !!event.timing),
      mode === "new",
    );
    assert.equal(
      delivered.some((event) => !!event.visibility),
      mode === "new",
    );
    assert.equal((await h.api.pending(300000)).items.length, 0);
    assert(
      Object.values(archive(h.local).applications)[0].data.events.some(
        (event) => !!event.timing,
      ),
    );
    // A later snapshot resends the cumulative run after a server upgrade.
    const next = timedReport();
    next.phase = "page-complete";
    await h.api.capture(next);
    assert(
      (await h.api.pending(300000)).items[0].events.some(
        (event) => !!event.timing,
      ),
    );
  });
}

for (const [boundary, status] of [
  ["probe", 401],
  ["probe", 500],
  ["rich", 401],
  ["rich", 503],
  ["fallback", 500],
]) {
  test(`failed ${boundary} upload (${status}) leaves timing pending and does not silently downgrade`, async () => {
    const h = connectedHistory();
    let calls = 0;
    await h.api.capture(timedReport());
    const failureAt = boundary === "probe" ? 1 : boundary === "rich" ? 2 : 3;
    h.context.fetch = async () => {
      calls++;
      if (calls === failureAt) return Response.json({}, { status });
      if (boundary === "fallback" && calls === 2)
        return Response.json({}, { status: 400 });
      return Response.json({ historyAccepted: true, historyEventMetrics: 1 });
    };
    await assert.rejects(h.api.sync(), new RegExp(String(status)));
    assert.equal(calls, failureAt);
    assert.equal((await h.api.pending(300000)).items.length, 1);
  });
}

test("a connection changed during the capability response cannot send the old batch", async () => {
  const h = connectedHistory(),
    started = Promise.withResolvers(),
    finish = Promise.withResolvers();
  await h.api.capture(timedReport());
  let calls = 0;
  h.context.fetch = async () => {
    calls++;
    return {
      ok: true,
      json: async () => {
        started.resolve();
        return finish.promise;
      },
    };
  };
  const task = h.api.sync();
  await started.promise;
  await h.context.JobsPrivateSession.clear();
  finish.resolve({ historyAccepted: true, historyEventMetrics: 1 });
  await assert.rejects(task, /连接已改变/);
  assert.equal(calls, 1);
  assert.equal((await h.api.pending(300000)).items.length, 1);
});

test("a connection change during acknowledgement reads leaves history pending", async () => {
  const h = connectedHistory();
  await h.api.capture(report());
  const storage = h.context.chrome.storage.local,
    get = storage.get;
  let reads = 0;
  storage.get = async (keys) => {
    const result = await get(keys);
    if (keys === "jobsDiagnosticHistoryV1" && ++reads === 2) {
      await h.context.JobsPrivateSession.clear();
      h.local.jobsSyncV1.profileToken = "synthetic-new-grant";
    }
    return result;
  };
  await assert.rejects(h.api.sync(), /连接已改变/);
  assert.equal((await h.api.pending(300000)).items.length, 1);
});

for (const boundary of ["payload", "index"])
  test(`a connection change during acknowledgement ${boundary} publication survives restart`, async () => {
    const h = connectedHistory();
    await h.api.capture(report());
    const storage = h.context.chrome.storage.local,
      set = storage.set;
    let changed = false;
    storage.set = async (value) => {
      await set(value);
      const target =
        boundary === "index"
          ? value.jobsDiagnosticHistoryV1
          : Object.keys(value).some((key) =>
              key.startsWith("jobsDiagnosticRunV2:"),
            );
      if (!changed && target) {
        changed = true;
        await h.context.JobsPrivateSession.clear();
        h.local.jobsSyncV1.profileToken = "synthetic-new-grant";
      }
    };
    await assert.rejects(h.api.sync(), /连接已改变/);
    const restarted = setup(h.local, h.session);
    const batch = await restarted.api.pending(300000);
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].snapshots.length, 1);
    await restarted.api.acknowledge(batch.ack);
    assert.equal((await restarted.api.pending(300000)).items.length, 0);
  });

test("failed acknowledgement confirmation remains pending after cleanup and another capture", async () => {
  const h = connectedHistory(),
    first = report();
  await h.api.capture(first);
  const storage = h.context.chrome.storage.local,
    set = storage.set;
  let indexes = 0;
  storage.set = async (value) => {
    if (value.jobsDiagnosticHistoryV1 && ++indexes === 2)
      throw Error("synthetic acknowledgement confirmation failure");
    await set(value);
  };
  await assert.rejects(h.api.sync(), /confirmation failure/);
  h.local["jobsDiagnosticRunV2:synthetic-orphan"] = { synthetic: true };
  const restarted = setup(h.local, h.session);
  let batch = await restarted.api.pending(300000);
  assert.equal(batch.items.length, 1);
  assert.equal(h.local["jobsDiagnosticRunV2:synthetic-orphan"], undefined);
  await restarted.api.capture(report(2));
  batch = await setup(h.local, h.session).api.pending(300000);
  assert.equal(batch.items.length, 2);
  assert(batch.items.every((item) => item.snapshots.length === 1));
});

test("a worker stopped after staging acknowledgements restores pending runs before cleanup", async () => {
  const h = connectedHistory();
  await h.api.capture(report());
  const storage = h.context.chrome.storage.local,
    set = storage.set,
    staged = Promise.withResolvers(),
    continueWrite = Promise.withResolvers();
  let captured = false;
  storage.set = async (value) => {
    await set(value);
    if (value.jobsDiagnosticHistoryV1 && !captured) {
      captured = true;
      staged.resolve(structuredClone(h.local));
      await continueWrite.promise;
    }
  };
  const upload = h.api.sync();
  const stoppedStorage = await staged.promise;
  const restarted = setup(stoppedStorage, structuredClone(h.session));
  const batch = await restarted.api.pending(300000);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].snapshots.length, 1);
  const live = Object.values(
    stoppedStorage.jobsDiagnosticHistoryV1.applications,
  )[0].storageKey;
  assert(stoppedStorage[live]);
  assert(
    stoppedStorage.jobsDiagnosticHistoryV1.garbage.every(
      (key) => !stoppedStorage[key],
    ),
  );
  continueWrite.resolve();
  await upload;
});

test("a confirmed old connection acknowledgement stays valid if connection changes while finalizing", async () => {
  const h = connectedHistory();
  await h.api.capture(report());
  const storage = h.context.chrome.storage.local,
    set = storage.set;
  let indexes = 0;
  storage.set = async (value) => {
    await set(value);
    if (value.jobsDiagnosticHistoryV1 && ++indexes === 2) {
      await h.context.JobsPrivateSession.clear();
      h.local.jobsSyncV1.profileToken = "synthetic-new-grant";
    }
  };
  await h.api.sync();
  assert.equal(indexes, 2);
  assert.equal(
    (await setup(h.local, h.session).api.pending(300000)).items.length,
    0,
  );
});
