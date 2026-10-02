import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
const sources = await Promise.all(
  ["job-match-rules", "job-match", "repro-case", "repro-background"].map((n) =>
    readModule(new URL("../src/custom/" + n + ".js", import.meta.url), "utf8"),
  ),
);
const historySource = await readWithDependencies(
  new URL("../src/custom/history-background.js", import.meta.url),
  "utf8",
);
function setup(local = {}, now = Date.now()) {
  const listeners = [],
    ctx = vm.createContext({
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      URL,
      TextEncoder,
      crypto: webcrypto,
      JobsSync: { ready: Promise.resolve() },
      chrome: {
        runtime: {
          id: "test",
          getURL: (p) => "chrome-extension://test/" + p,
          onMessage: { addListener: (fn) => listeners.push(fn) },
        },
        storage: {
          session: { get: async () => ({}), set: async () => {} },
          local: {
            get: async () => structuredClone(local),
            set: async (v) => Object.assign(local, structuredClone(v)),
          },
        },
      },
    });
  vm.runInContext(historySource, ctx);
  sources.forEach((s) => vm.runInContext(s, ctx));
  return {
    local,
    history: ctx.JobsDiagnosticHistory,
    send: (
      m,
      sender = { id: "test", url: "chrome-extension://test/diagnostics.html" },
    ) => new Promise((resolve) => listeners[0](m, sender, resolve)),
  };
}
function value(i = 1) {
  return {
    schemaVersion: 1,
    valuePolicy: "synthetic_fixture",
    capturedAt: i,
    origin: "https://fixture.invalid",
    build: "unbuilt",
    ats: "fixture",
    fields: [
      {
        id: "case-field-1",
        observed: {
          kind: "text",
          required: true,
          hasValue: false,
          invalid: true,
          completion: "invalid",
        },
        tree: {
          tag: "input",
          attrs: { required: "", "data-jobs-repro-target": "true" },
          children: [],
        },
        portals: [],
      },
    ],
    timeline: [{ ms: i, type: "action_failed" }],
    coverage: { truncated: false },
    limitations: [],
  };
}
const sender = (i) => ({
  id: "test",
  tab: { id: i },
  frameId: 0,
  url: `https://fixture.invalid/jobs/${i}?token=secret`,
});
test("cases persist across worker restart and preserve unresolved applications and distinct snapshots", async () => {
  const h = setup();
  for (let i = 1; i <= 4; i++)
    assert(
      !(await h.send({ type: "jobs:repro-push", value: value(i) }, sender(i)))
        .error,
    );
  const reboot = setup(h.local),
    rows = (await reboot.send({ type: "jobs:repro-list" })).data;
  assert.equal(rows.length, 4);
  const one = (await reboot.send({ type: "jobs:repro-get", id: rows[0].id }))
    .data;
  assert.equal(one.valuePolicy, "synthetic_fixture");
  assert(!JSON.stringify(h.local).includes("token=secret"));
  for (let i = 0; i < 5; i++) {
    const v = value(i);
    v.fields[0].observed.hasValue = !!(i % 2);
    v.timeline[0].type = "event_" + i;
    await reboot.send({ type: "jobs:repro-push", value: v }, sender(4));
  }
  assert.equal(
    Object.values(h.local.jobsReproCasesV1.applications).find(
      (r) => r.cases.length === 6,
    ).cases.length,
    6,
  );
});
test("webpages cannot read archives and cross-origin or unsafe captures are rejected", async () => {
  const h = setup();
  assert.match(
    (await h.send({ type: "jobs:repro-list" }, sender(1))).error,
    /Private/,
  );
  const v = value();
  v.origin = "https://another.invalid";
  assert.match(
    (await h.send({ type: "jobs:repro-push", value: v }, sender(1))).error,
    /origin mismatch/,
  );
  v.origin = "https://fixture.invalid";
  v.fields[0].tree.attrs.src = "https://secret.invalid";
  assert.match(
    (await h.send({ type: "jobs:repro-push", value: v }, sender(1))).error,
    /Unsafe/,
  );
});
test("query-based ATS job identities stay separate without storing query parameters", async () => {
  const h = setup(),
    v = value();
  v.origin = "https://workforcenow.adp.com";
  for (const job of ["1", "2", "1"])
    assert(
      !(
        await h.send(
          { type: "jobs:repro-push", value: v },
          {
            ...sender(1),
            url: v.origin + "/jobs?cid=example&jobId=" + job + "&token=private",
          },
        )
      ).error,
    );
  const items = h.local.jobsReproCasesV1.applications;
  assert.equal(Object.keys(items).length, 2);
  assert(Object.keys(items).every((k) => /^[a-f0-9]{64}$/.test(k)));
  assert(!JSON.stringify(items).includes("token=private"));
  assert.equal((await h.send({ type: "jobs:repro-list" })).data.length, 2);
});
test("application steps share one job archive and a new build is retained", async () => {
  const h = setup(),
    v = value();
  v.origin = "https://fixture.myworkdayjobs.com";
  for (const step of ["contact", "experience", "review"])
    assert(
      !(
        await h.send(
          { type: "jobs:repro-push", value: v },
          {
            ...sender(1),
            url: v.origin + "/en-US/jobs/job/fixture_123/apply/" + step,
          },
        )
      ).error,
    );
  assert.equal(Object.keys(h.local.jobsReproCasesV1.applications).length, 1);
  assert.equal((await h.send({ type: "jobs:repro-list" })).data.length, 1);
  v.build = "0123456789abcdef";
  await h.send(
    { type: "jobs:repro-push", value: v },
    {
      ...sender(1),
      url: v.origin + "/en-US/jobs/job/fixture_123/apply/review",
    },
  );
  assert.equal((await h.send({ type: "jobs:repro-list" })).data.length, 2);
});

test("only cases explicitly marked resolved expire after thirty days and may be reopened", async () => {
  const now = Date.now(),
    h = setup({}, now);
  await h.send({ type: "jobs:repro-push", value: value() }, sender(1));
  await h.send({ type: "jobs:repro-push", value: value(2) }, sender(2));
  const rows = (await h.send({ type: "jobs:repro-list" })).data;
  await h.send({ type: "jobs:repro-resolve", id: rows[0].id, resolved: true });
  assert((await h.send({ type: "jobs:repro-list" })).data[0].resolved);
  await h.send({ type: "jobs:repro-resolve", id: rows[0].id, resolved: false });
  assert(!(await h.send({ type: "jobs:repro-list" })).data[0].resolved);
  await h.send({ type: "jobs:repro-resolve", id: rows[0].id, resolved: true });
  const later = setup(h.local, now + 31 * 86400000);
  const retained = (await later.send({ type: "jobs:repro-list" })).data;
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, rows[1].id);
  assert.match(
    (
      await later.send(
        { type: "jobs:repro-resolve", id: rows[1].id, resolved: true },
        sender(1),
      )
    ).error,
    /Private/,
  );
});

test("native reproduction capture, resolution and reopen update the same retained run", async () => {
  const h = setup(),
    v = value(),
    url = "https://jobs.ashbyhq.com/fixture/role/application",
    runId = "run-fixture";
  v.origin = new URL(url).origin;
  const event = { ...sender(1), url };
  await h.history.capture({
    valuePolicy: "fill_trace_values_only",
    sessionId: "doc-fixture",
    runId,
    pageUrl: url,
    ats: "ashby",
    startedAt: Date.now(),
    observedAt: Date.now(),
    fields: [{ id: "field-1", question: "Start date", kind: "date" }],
    events: [],
  });
  assert(
    !(await h.send({ type: "jobs:repro-push", runId, value: v }, event)).error,
  );
  const id = (await h.send({ type: "jobs:repro-list" })).data[0].id;
  let item = (await h.history.pending(300000)).items[0];
  assert.deepEqual([...item.caseRetention.unresolvedCaseIds], [id]);
  assert.equal(item.caseRetention.revision, 1);
  await h.send({ type: "jobs:repro-resolve", id, resolved: true });
  item = (await h.history.pending(300000)).items[0];
  assert.equal(item.caseRetention.revision, 2);
  assert.deepEqual([...item.caseRetention.unresolvedCaseIds], []);
  await h.send({ type: "jobs:repro-resolve", id, resolved: false });
  item = (await h.history.pending(300000)).items[0];
  assert.equal(item.caseRetention.revision, 3);
  assert.deepEqual([...item.caseRetention.unresolvedCaseIds], [id]);
});

test("one run refuses a 101st unresolved case without deleting evidence", async () => {
  const h = setup(),
    v = value(),
    url = "https://jobs.ashbyhq.com/fixture/role/application",
    runId = "run-limit";
  v.origin = new URL(url).origin;
  for (let i = 0; i < 100; i++) {
    v.fields[0].observed.invalid = i % 2 === 0;
    assert(
      !(
        await h.send(
          { type: "jobs:repro-push", runId, value: v },
          { ...sender(1), url },
        )
      ).error,
    );
  }
  const rows = (await h.send({ type: "jobs:repro-list" })).data;
  assert.equal(rows.length, 100);
  v.fields[0].observed.invalid = true;
  assert.match(
    (
      await h.send(
        { type: "jobs:repro-push", runId, value: v },
        { ...sender(1), url },
      )
    ).error,
    /100/,
  );
  assert.equal((await h.send({ type: "jobs:repro-list" })).data.length, 100);
  await h.send({ type: "jobs:repro-resolve", id: rows[0].id, resolved: true });
  assert(
    !(
      await h.send(
        { type: "jobs:repro-push", runId, value: v },
        { ...sender(1), url },
      )
    ).error,
  );
  assert.equal((await h.send({ type: "jobs:repro-list" })).data.length, 101);
});
