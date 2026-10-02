import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
const source = await readModule(
  new URL("../src/custom/private-session.js", import.meta.url),
  "utf8",
);

test("quota recovery evicts only observations and preserves pending answers and no-replay receipts", async () => {
  const pendingKey = "jobsResponses:synthetic";
  const receipt = { id: "once", state: "unknown" };
  const session = {
    jobsBrowserControlV1: {
      sessionId: "same-session",
      frames: {
        "1:0": {
          tabId: 1,
          documentId: "same-page",
          snapshot: { data: "x".repeat(50000) },
        },
      },
      journal: { once: { key: "command", result: receipt } },
      results: [receipt],
    },
    jobsDiagnosticsV1: { reports: { data: "y".repeat(40000) } },
    [pendingKey]: [{ question: "Synthetic", response: "Pending" }],
    jobsManagementBaseV1: { [pendingKey]: { revision: 1, value: [] } },
    profile_1: { id: "profile", profile: { profileName: "Synthetic" } },
  };
  const before = structuredClone(session);
  let quotaFailures = 0;
  const c = vm.createContext({
    chrome: {
      storage: {
        session: {
          getKeys: async () => Object.keys(session),
          get: async (keys) =>
            Object.fromEntries(
              [keys].flat().map((key) => [key, structuredClone(session[key])]),
            ),
          set: async (values) => {
            if (
              Buffer.byteLength(JSON.stringify({ ...session, ...values })) >
              100000
            ) {
              quotaFailures++;
              throw Error(
                "Session storage quota bytes exceeded. Values were not stored.",
              );
            }
            Object.assign(session, structuredClone(values));
          },
          remove: async (keys) => {
            for (const key of [keys].flat()) delete session[key];
          },
        },
      },
    },
  });
  vm.runInContext(source, c);
  await c.JobsPrivateSession.commit(0, {
    job_1: { description: "z".repeat(20000) },
  });
  assert.equal(quotaFailures, 1);
  assert.equal(session.job_1.description.length, 20000);
  assert.equal(session.jobsBrowserControlV1.frames["1:0"].snapshot, undefined);
  assert.equal(session.jobsBrowserControlV1.sessionId, "same-session");
  for (const key of [pendingKey, "jobsManagementBaseV1", "profile_1"])
    assert.deepEqual(session[key], before[key]);
  assert.deepEqual(
    session.jobsBrowserControlV1.journal,
    before.jobsBrowserControlV1.journal,
  );
  assert.deepEqual(
    session.jobsBrowserControlV1.results,
    before.jobsBrowserControlV1.results,
  );
  await assert.rejects(
    c.JobsPrivateSession.commit(0, { tooLarge: "x".repeat(200000) }),
    /quota/,
  );
  assert.deepEqual(session[pendingKey], before[pendingKey]);
});

test("pending answers survive a failed retention write before migration backup, and are never deleted during cleanup", async () => {
  const key = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const retained = {
    [key]: [{ question: "Synthetic", response: "Not yet uploaded" }],
    jobsManagementBaseV1: { [key]: { revision: 1, value: [] } },
  };
  const session = {
      ...structuredClone(retained),
      profile_1: { profile: "Synthetic private snapshot" },
    },
    removed = [];
  let fail = true;
  const c = vm.createContext({
    chrome: {
      tabs: { query: async () => [] },
      storage: {
        session: {
          get: async () => structuredClone(session),
          getKeys: async () => Object.keys(session),
          set: async (values) => {
            if (fail) throw Error("Synthetic storage failure");
            Object.assign(session, structuredClone(values));
          },
          remove: async (keys) => {
            removed.push(...keys);
            for (const name of keys) delete session[name];
          },
        },
      },
    },
  });
  vm.runInContext(source, c);
  await assert.rejects(
    c.JobsPrivateSession.clear(undefined, async () =>
      structuredClone(retained),
    ),
    /Synthetic storage failure/,
  );
  assert.deepEqual(session[key], retained[key]);
  assert.deepEqual(session.jobsManagementBaseV1, retained.jobsManagementBaseV1);
  assert.equal(removed.length, 0);
  fail = false;
  await c.JobsPrivateSession.clear(undefined, async () =>
    structuredClone(retained),
  );
  assert.deepEqual(session, retained);
  assert.deepEqual(removed, ["profile_1"]);
});
test("connection cleanup broadcasts to every page, preserves identity-only local data, and fences reads during cleanup", async () => {
  const session = {
    profile_1: { private: "synthetic profile" },
    jobsBrowserControlV1: { private: "synthetic field" },
    jobsDiagnosticSaltV2: "synthetic salt",
    job_1: "synthetic description",
    innocuous: "keep",
  };
  const started = Promise.withResolvers(),
    reply = Promise.withResolvers(),
    sent = [];
  const c = vm.createContext({
    chrome: {
      storage: {
        session: {
          get: async () => structuredClone(session),
          getKeys: async () => Object.keys(session),
          set: async (values) =>
            Object.assign(session, structuredClone(values)),
          remove: async (keys) => {
            for (const key of keys) delete session[key];
          },
        },
      },
      tabs: {
        query: async () => [{ id: 1 }, { id: 2 }, {}],
        sendMessage: async (id, message) => {
          sent.push({ id, message });
          started.resolve();
          await reply.promise;
        },
      },
    },
  });
  vm.runInContext(source, c);
  const before = c.JobsPrivateSession.epoch;
  const cleanup = c.JobsPrivateSession.clear();
  await started.promise;
  const during = c.JobsPrivateSession.epoch;
  const refill = c.JobsPrivateSession.commit(during, {
    profile_1: { private: "late synthetic profile" },
  });
  const rejected = assert.rejects(refill, /连接已改变/);
  reply.resolve();
  await cleanup;
  await rejected;
  assert.equal(sent.length, 2);
  assert(
    sent.every((x) => x.message.type === "jobs:private-session-invalidated"),
  );
  assert.deepEqual(session, { innocuous: "keep" });
  assert.throws(() => c.JobsPrivateSession.assertCurrent(before), /连接已改变/);
  await c.JobsPrivateSession.commit(
    c.JobsPrivateSession.epoch,
    { newPage: "synthetic" },
    ["innocuous"],
  );
  assert.deepEqual(session, { newPage: "synthetic" });
});
