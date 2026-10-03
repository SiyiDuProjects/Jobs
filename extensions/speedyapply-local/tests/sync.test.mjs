import { functionBlock, readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const privateSessionSource = await readModule(
  new URL("../src/custom/private-session.js", import.meta.url),
  "utf8",
);
const source = await readModule(
  new URL("../src/custom/sync.js", import.meta.url),
  "utf8",
);
const submissionSource = await readModule(
  new URL("../src/custom/submission-background.js", import.meta.url),
  "utf8",
);
// The background loads the shared job identity before sync.js.
const matchRules = await readModule(
  new URL(
    "../../../services/jobs-radar/jobs_radar/job_match_rules.json",
    import.meta.url,
  ),
  "utf8",
);
const publicUrlSource = await readModule(
  new URL("../src/custom/public-job-url.js", import.meta.url),
  "utf8",
);
const matchSource = await readModule(
  new URL("../src/custom/job-match.js", import.meta.url),
  "utf8",
);
const origin = "https://jobs.siyidu.com",
  url = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555";
const app = {
  jobLink: url + "?token=secret&email=private&embed=true",
  jobTitle: "Engineer",
  companyName: "Acme",
  status: "applied",
  profileName: "Private",
  resumeData: "private",
};
const sourceInfo = { url: url + "/application", proof: "ats_confirmation" };
function harness(initial = {}, respond, privateConnection, session = {}) {
  let storage = structuredClone(initial),
    listener,
    alarms = [],
    tabCreated,
    tabUpdated,
    tabRemoved;
  const requests = [],
    announced = [];
  const chrome = {
    runtime: {
      id: "ccohapahbamkcbgkpegidkpknoeikiko",
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    storage: {
      local: {
        get: async () => structuredClone(storage),
        set: async (data) => {
          Object.assign(storage, structuredClone(data));
        },
      },
      session: {
        getKeys: async () => Object.keys(session),
        remove: async (keys) => {
          for (const key of [keys].flat()) delete session[key];
        },
        get: async () => structuredClone(session),
        set: async (data) => {
          Object.assign(session, structuredClone(data));
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (id, msg) => announced.push(msg),
      onCreated: {
        addListener: (f) => {
          tabCreated = f;
        },
      },
      onUpdated: {
        addListener: (f) => {
          tabUpdated = f;
        },
      },
      onRemoved: {
        addListener: (f) => {
          tabRemoved = f;
        },
      },
    },
    alarms: {
      create: (name, value) => alarms.push([name, value]),
      onAlarm: { addListener() {} },
    },
  };
  const context = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    chrome,
    JobsPrivateConnection: privateConnection,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    AbortSignal,
    Date,
    console,
    setTimeout: (fn) => setTimeout(fn, 0),
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (respond) return respond(path, options);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          event_id: JSON.parse(options.body).event_id,
          state: "submitted",
          retryable: false,
        }),
      };
    },
  });
  context.JobsMatchRules = JSON.parse(matchRules);
  vm.runInContext(matchSource, context);
  vm.runInContext(publicUrlSource, context);
  vm.runInContext(privateSessionSource, context);
  vm.runInContext(source, context);
  const message = (msg, sender = { url: origin + "/", tab: { id: 1 } }) =>
    new Promise((resolve) => listener(msg, sender, resolve));
  return {
    context,
    chrome,
    api: context.JobsSync,
    clearSession: () => context.JobsPrivateSession.clear(),
    clock: (stamp) => {
      context.Date = class extends Date {
        constructor(value = stamp) {
          super(value);
        }
        static now() {
          return stamp;
        }
      };
    },
    installManagement: (management) => {
      context.JobsManagementSync = management;
    },
    message,
    requests,
    announced,
    alarms,
    state: () => storage.jobsSyncV1,
    local: () => structuredClone(storage),
    set: (data) => {
      storage.jobsSyncV1 = data;
    },
    created: (tab) => tabCreated(tab),
    updated: (tab) => tabUpdated(tab.id, { url: tab.url }, tab),
    removed: (id) => tabRemoved(id),
  };
}
const connected = () => ({
  jobsSyncV1: { deviceId: randomUUID(), token: "a".repeat(64), outbox: [] },
});

test("title observations use the existing authorized job identity without changing receipt queues", async () => {
  const initial = connected();
  initial.jobsSubmissionGuardsV1 = { held: { state: "unknown" } };
  initial.jobsSyncV1.outbox = [{ payload: { event_id: "pending" } }];
  const h = harness(initial, () => Response.json({ ok: true, changed: true }));
  await h.api.ready;
  const before = h.local();
  assert.equal(
    (
      await h.api.reportJobTitle(
        url + "/application?token=private&email=private",
        "Software Engineer",
        "b".repeat(24),
      )
    ).ok,
    true,
  );
  assert.equal(h.requests.length, 1);
  const { path, options } = h.requests[0];
  assert.equal(path, origin + "/api/extension/job-title");
  assert.equal(options.credentials, "omit");
  assert.equal(options.headers["X-Jobs-Protocol"], "2");
  assert.equal(
    options.headers.Authorization,
    "Bearer " + initial.jobsSyncV1.token,
  );
  const body = JSON.parse(options.body);
  assert.equal(body.url, url + "/application");
  assert.equal(body.title, "Software Engineer");
  assert.equal(body.title_source, "existing_adapter");
  assert.equal(body.website_job_id, "b".repeat(24));
  assert(Number.isFinite(Date.parse(body.observed_at)));
  assert.deepEqual(h.local(), before);
});

test("disconnected, rejected and private-identity title observations never enter the submission outbox", async () => {
  for (const initial of [
    {},
    { jobsSyncV1: { ...connected().jobsSyncV1, disabled: true } },
  ]) {
    const h = harness(initial);
    assert.equal((await h.api.reportJobTitle(url, "Engineer")).ok, false);
    assert.equal(h.requests.length, 0);
  }
  const h = harness(
    connected(),
    () => new Response("Unauthorized", { status: 401 }),
  );
  assert.equal((await h.api.reportJobTitle(url, "Engineer")).ok, false);
  await assert.rejects(
    h.api.reportJobTitle("https://example.test/jobs?token=private", "Engineer"),
  );
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.state().outbox, []);
});

test("title dispatch checks the live document after queue waits and uses the original observation time", async () => {
  const h = harness(connected(), () => Response.json({ ok: true }));
  await h.api.ready;
  h.clock("2026-09-26T12:00:00.000Z");
  let verified = false;
  await h.api.reportJobTitle(url, "Engineer", undefined, async () => {
    verified = true;
    assert.equal(h.requests.length, 0);
    h.clock("2026-09-26T12:01:00.000Z");
    return "b".repeat(24);
  });
  assert.equal(verified, true);
  const body = JSON.parse(h.requests[0].options.body);
  assert.equal(body.observed_at, "2026-09-26T12:00:00.000Z");
  assert.equal(body.website_job_id, "b".repeat(24));

  await assert.rejects(
    h.api.reportJobTitle(url, "Stale", undefined, async () => {
      throw Error("Document gone");
    }),
    /Document gone/,
  );
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.state().outbox, []);
});

test("a connection change during title validation prevents dispatch", async () => {
  const h = harness(connected(), () => Response.json({ ok: true }));
  await h.api.ready;
  await assert.rejects(
    h.api.reportJobTitle(url, "Engineer", undefined, async () => {
      await h.clearSession();
    }),
    /连接已改变/,
  );
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.state().outbox, []);
});

for (const phase of ["state read", "tab binding"])
  test(`an attempt cannot enter a replacement connection during its ${phase}`, async () => {
    const h = harness(connected());
    await h.api.ready;
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      area =
        phase === "state read"
          ? h.chrome.storage.local
          : h.chrome.storage.session,
      get = area.get;
    let first = true;
    area.get = async (...args) => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return get(...args);
    };
    const pending = h.api.record(app, {
      ...sourceInfo,
      proof: "submit_attempt",
      tabId: 2,
      profileId: "old-profile",
    });
    await entered.promise;
    await h.clearSession();
    const replacement = {
      ...connected().jobsSyncV1,
      token: "b".repeat(64),
      outbox: [],
      seen: {},
    };
    h.set(replacement);
    release.resolve();
    await assert.rejects(pending, /连接已改变/);
    assert.deepEqual(h.state(), replacement);
    assert.equal(h.requests.length, 0);
  });

test("offline title reports do not create submission work or hold the sync queue", async () => {
  let release;
  const network = new Promise((_, reject) => {
    release = reject;
  });
  const h = harness(connected(), () => network);
  await h.api.ready;
  const before = h.local();
  const task = h.api.reportJobTitle(url, "Engineer");
  const rejected = assert.rejects(task, /Offline/);
  const status = await h.message({ type: "jobs:sync-status" });
  assert.equal(status.queued, 0);
  release(Error("Offline"));
  await rejected;
  assert.deepEqual(h.local(), before);
});

test("explicit recovery pause stops pages from Profile, answer, job, title and migration requests, retaining pending answers and durable guards", async () => {
  for (const entry of ["profile", "answer", "resolve", "title", "migration"]) {
    const initial = connected();
    initial.jobsSyncV1.profileToken = "b".repeat(64);
    initial.jobsSyncV1.outbox = [
      { payload: { event_id: "pending-receipt" }, next: Date.now() + 600000 },
    ];
    initial.jobsSubmissionGuardsV1 = { synthetic: { state: "unknown" } };
    const key = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const pending = {
      [key]: [{ question: "Synthetic", response: "Pending" }],
      jobsManagementBaseV1: { [key]: { revision: 1, value: [] } },
    };
    const session = {
      ...structuredClone(pending),
      profile_1: { profile: "Synthetic profile" },
    };
    const h = harness(
      initial,
      () =>
        Response.json({ code: "recovery_application_pause" }, { status: 503 }),
      undefined,
      session,
    );
    h.installManagement({
      pendingSnapshot: async () => structuredClone(pending),
    });
    const call = {
      profile: () => h.api.profileRequest({ path: "/api/extension/profiles" }),
      answer: () =>
        h.api.generateAnswer({
          profileId: "synthetic",
          profileVersion: "1",
          question: "Synthetic?",
        }),
      resolve: () => h.api.resolveJob(url),
      title: () => h.api.reportJobTitle(url, "Software Engineer"),
      migration: () =>
        h.api.migrationRequest("/api/extension/storage-migrations"),
    }[entry];
    await assert.rejects(call(), { code: "recovery_application_pause" });
    assert.equal(
      h.announced.filter(
        (message) => message.type === "jobs:private-session-invalidated",
      ).length,
      1,
      entry,
    );
    assert.equal(session.profile_1, undefined, entry);
    assert.deepEqual(session[key], pending[key]);
    assert.deepEqual(
      session.jobsManagementBaseV1,
      pending.jobsManagementBaseV1,
    );
    assert.deepEqual(h.state().outbox, initial.jobsSyncV1.outbox);
    assert.deepEqual(
      h.local().jobsSubmissionGuardsV1,
      initial.jobsSubmissionGuardsV1,
    );
    assert.equal(h.requests.length, 1, "explicit pause must not retry AI");
  }
});

test("ordinary 503 and malformed gateway replies do not invalidate active pages", async () => {
  for (const body of [
    JSON.stringify({ code: "upstream_unavailable" }),
    "<html>Unavailable</html>",
  ]) {
    const initial = connected();
    initial.jobsSyncV1.profileToken = "b".repeat(64);
    const session = { profile_1: { profile: "Synthetic profile" } };
    const h = harness(
      initial,
      () => new Response(body, { status: 503 }),
      undefined,
      session,
    );
    await assert.rejects(
      h.api.profileRequest({ path: "/api/extension/profiles" }),
    );
    assert.equal(h.announced.length, 0);
    assert.deepEqual(session.profile_1, { profile: "Synthetic profile" });
  }
});

for (const entry of [
  "profile",
  "management",
  "answer",
  "resolve",
  "title",
  "migration",
  "reconnect",
  "receipt",
])
  for (const boundary of ["response", "pause JSON"])
    test(`${entry} ignores an old recovery pause after connection changes during ${boundary}`, async () => {
      const initial = connected();
      initial.jobsSyncV1.profileToken = "b".repeat(64);
      if (entry === "receipt")
        initial.jobsSyncV1.outbox = [
          { payload: { event_id: "old-receipt" }, attempts: 0, next: 0 },
        ];
      const started = Promise.withResolvers(),
        reply = Promise.withResolvers(),
        key = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        pending = { [key]: [{ question: "Synthetic", response: "Pending" }] },
        session = { profile_1: { profile: "Old synthetic profile" } };
      const h = harness(
        initial,
        () => {
          if (boundary === "response") {
            started.resolve();
            return reply.promise;
          }
          return {
            status: 503,
            ok: false,
            clone: () => ({
              json: () => {
                started.resolve();
                return reply.promise;
              },
            }),
          };
        },
        undefined,
        session,
      );
      h.installManagement({ pendingSnapshot: async () => pending });
      const call = {
        profile: () =>
          h.api.profileRequest({ path: "/api/extension/profiles" }),
        management: () => h.api.managementRequest("GET"),
        answer: () =>
          h.api.generateAnswer({
            profileId: "synthetic",
            profileVersion: "1",
            question: "Synthetic?",
          }),
        resolve: () => h.api.resolveJob(url),
        title: () => h.api.reportJobTitle(url, "Software Engineer"),
        migration: () =>
          h.api.migrationRequest("/api/extension/storage-migrations"),
        reconnect: async () => {
          const result = await h.message({
            type: "jobs:sync-connect",
            token: "c".repeat(64),
            profileToken: "d".repeat(64),
          });
          if (result.error) throw Error(result.error);
        },
        receipt: () => h.api.flush(),
      }[entry];
      const operation = call().then(
        () => undefined,
        (error) => error,
      );
      await started.promise;
      await h.clearSession();
      h.set({
        ...h.state(),
        token: "e".repeat(64),
        profileToken: "f".repeat(64),
        outbox: h
          .state()
          .outbox.map((item) => ({ ...item, next: Date.now() + 600000 })),
      });
      session.profile_2 = { profile: "New synthetic profile" };
      Object.assign(session, structuredClone(pending));
      const invalidations = h.announced.length;
      reply.resolve(
        boundary === "response"
          ? Response.json(
              { code: "recovery_application_pause" },
              { status: 503 },
            )
          : { code: "recovery_application_pause" },
      );
      const error = await operation;
      if (entry === "reconnect") assert(error);
      else if (entry !== "receipt")
        assert.match(error?.message || "", /连接已改变/);
      assert.deepEqual(session.profile_2, { profile: "New synthetic profile" });
      assert.deepEqual(session[key], pending[key]);
      assert.equal(
        h.announced
          .slice(invalidations)
          .some(
            (message) => message.type === "jobs:private-session-invalidated",
          ),
        false,
      );
      assert.equal(h.state().profileToken, "f".repeat(64));
      assert.equal(h.requests.length, 1);
    });

test("a successful receipt still acknowledges after private session refresh with the same grant", async () => {
  const initial = connected(),
    started = Promise.withResolvers(),
    reply = Promise.withResolvers();
  initial.jobsSyncV1.outbox = [
    { payload: { event_id: "accepted-receipt" }, attempts: 0, next: 0 },
  ];
  const session = {};
  const h = harness(
    initial,
    () => {
      started.resolve();
      return reply.promise;
    },
    undefined,
    session,
  );
  const operation = h.api.flush();
  await started.promise;
  await h.clearSession();
  session.profile_2 = { profile: "New synthetic profile" };
  reply.resolve(
    Response.json({
      event_id: "accepted-receipt",
      state: "submitted",
      retryable: false,
    }),
  );
  await operation;
  assert.equal(h.state().outbox.length, 0);
  assert.deepEqual(session.profile_2, { profile: "New synthetic profile" });
  assert.equal(h.requests.length, 1);
});

test("receipt recovery pause retains the same outbox event and unknown submission guard", async () => {
  const initial = connected();
  const receipt = {
    event_id: "paused-receipt",
    job_url: url,
    proof: "submit_attempt",
  };
  initial.jobsSyncV1.outbox = [{ payload: receipt, attempts: 0, next: 0 }];
  initial.jobsSubmissionGuardsV1 = { synthetic: { state: "unknown" } };
  const session = { profile_1: { profile: "Synthetic profile" } };
  const h = harness(
    initial,
    () =>
      Response.json({ code: "recovery_application_pause" }, { status: 503 }),
    undefined,
    session,
  );
  h.installManagement({ pendingSnapshot: async () => ({}) });
  await h.api.flush();
  assert.equal(h.state().outbox.length, 1);
  assert.deepEqual(h.state().outbox[0].payload, receipt);
  assert.equal(h.state().outbox[0].attempts, 1);
  assert.deepEqual(
    h.local().jobsSubmissionGuardsV1,
    initial.jobsSubmissionGuardsV1,
  );
  assert.equal(session.profile_1, undefined);
  assert.equal(
    h.announced.some(
      (message) => message.type === "jobs:private-session-invalidated",
    ),
    true,
  );
});

test("explicit migration transport accepts escaped issued choices and rejects unrelated URLs", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  const h = harness(initial, () => ({
    ok: true,
    status: 200,
    json: async () => ({ rows: [], complete: false }),
  }));
  const path =
    "/api/extension/storage-migrations/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/conflicts/abc/preview?choiceId=source%3A0&cursor=next_1";
  await h.api.migrationRequest(path);
  assert.equal(h.requests[0].path, origin + path);
  assert.equal(h.requests[0].options.headers["X-Jobs-Protocol"], "2");
  for (const bad of [
    path + "&host=external",
    path.replace("source%3A0", "../profiles"),
    "/api/extension/profiles",
  ])
    await assert.rejects(
      h.api.migrationRequest(bad),
      /Invalid migration endpoint/,
    );
});

test("disconnect and changed grants clear private session facts while retaining submission protection and reject old replies", async () => {
  for (const reconnect of [false, true]) {
    const initial = connected();
    initial.jobsSyncV1.profileToken = "b".repeat(64);
    const session = {
      jobsProfilesCache: { private: "PRIVATE" },
      profile_4: { profile: "PRIVATE" },
      jobsManagementBaseV1: { value: "PRIVATE" },
      jobsDiagnosticsV1: { value: "PRIVATE" },
      jobsBrowserControlV1: { results: "PRIVATE" },
      ["jobsResponses:profile"]: ["PRIVATE"],
      unrelated: "retain",
    };
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const called = new Promise((resolve) => {
      started = resolve;
    });
    const h = harness(
      initial,
      async () => {
        started();
        return held;
      },
      undefined,
      session,
    );
    await h.api.ready;
    const pending = h.api.profileRequest({
      path: "/api/extension/profiles",
      method: "GET",
    });
    await called;
    const reply = await h.message(
      reconnect
        ? { type: "jobs:sync-connect", token: "c".repeat(64) }
        : { type: "jobs:sync-disconnect" },
    );
    assert.equal(reply.ok, true);
    assert.deepEqual(session, { unrelated: "retain" });
    assert.equal(
      h.state().profileToken,
      undefined,
      "a changed connection cannot reuse the previous Profile grant",
    );
    release({
      ok: true,
      status: 200,
      json: async () => [{ id: "old", profile: "PRIVATE" }],
    });
    await assert.rejects(pending, /连接已改变/);
  }
});

test("expired Profile grants release page facts while preserving pending edits and a new grant must prove the same Profile before recovery", async () => {
  for (const sameProfile of [false, true]) {
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      key = "jobsResponses:" + id;
    const initial = connected();
    initial.jobsSyncV1.profileToken = "b".repeat(64);
    const pending = {
      [key]: [{ question: "Synthetic", response: "Unacknowledged draft" }],
      jobsManagementBaseV1: { [key]: { value: [], revision: 1 } },
    };
    const session = {
      ...structuredClone(pending),
      profile_1: { profile: { private: "facts" } },
      jobsDiagnosticsV1: { value: "raw" },
    };
    const h = harness(
      initial,
      async (_path, options) =>
        options.headers.Authorization === "Bearer " + "c".repeat(64)
          ? {
              ok: true,
              status: 200,
              json: async () => [
                { id: sameProfile ? id : "another-owner-profile" },
              ],
            }
          : {
              ok: false,
              status: 401,
              json: async () => ({ error: "Expired" }),
            },
      undefined,
      session,
    );
    h.installManagement({
      pendingSnapshot: async () => structuredClone(pending),
      profiles: async () => [],
    });
    await h.api.ready;
    await assert.rejects(
      h.api.profileRequest({ path: "/api/extension/profiles" }),
      /已过期/,
    );
    assert.deepEqual(session, pending);
    assert.equal(h.state().profileToken, undefined);
    const reply = await h.message({
      type: "jobs:sync-connect",
      token: "d".repeat(64),
      profileToken: "c".repeat(64),
    });
    if (sameProfile) {
      assert.equal(reply.ok, true);
      assert.equal(h.state().profileToken, "c".repeat(64));
    } else {
      assert.match(reply.error, /原 Profile/);
      assert.equal(h.state().profileToken, undefined);
    }
    assert.deepEqual(
      session,
      pending,
      "reconnection neither drops unacknowledged facts nor restores unrelated page caches",
    );
  }
});

test("transient POST and polling failures recover with one durable answer request ID", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  const ids = [];
  let posts = 0,
    gets = 0;
  const h = harness(initial, async (path, options) => {
    if (options.method === "POST") {
      ids.push(JSON.parse(options.body).requestId);
      if (++posts === 1)
        throw Error("Connection lost after server accepted request");
      return {
        ok: true,
        status: 202,
        json: async () => ({ state: "pending" }),
      };
    }
    assert.equal(new URL(path).searchParams.get("id"), ids[0]);
    if (++gets === 1)
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw Error("Proxy HTML");
        },
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        state: "completed",
        result: { text: "Recovered answer" },
      }),
    };
  });
  assert.equal(
    (
      await h.api.generateAnswer({
        profileId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        profileVersion: "2026-09-20T00:00:00Z",
        prompt: "Question?",
      })
    ).text,
    "Recovered answer",
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(posts, 2);
  assert.equal(gets, 2);
});

test("AI task resumes after worker interruption without issuing a new model request ID", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  const session = {},
    ids = [],
    payload = {
      profileId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      profileVersion: "2026-09-20T00:00:00Z",
      prompt: "Availability?",
    };
  const response = (data) => ({
    ok: true,
    status: 200,
    json: async () => data,
  });
  const interrupted = harness(
    initial,
    async (path, options) => {
      if (options.method === "POST") {
        ids.push(JSON.parse(options.body).requestId);
        return response({ state: "pending" });
      }
      throw Error("worker interrupted");
    },
    undefined,
    session,
  );
  await assert.rejects(interrupted.api.generateAnswer(payload), /interrupted/);
  let polls = 0;
  const restart = harness(
    initial,
    async (path, options) => {
      if (options.method === "POST") {
        ids.push(JSON.parse(options.body).requestId);
        return response({ state: "pending" });
      }
      assert.equal(new URL(path).searchParams.get("id"), ids[0]);
      polls++;
      return response({
        state: "completed",
        result: { text: "Confirmed availability" },
      });
    },
    undefined,
    session,
  );
  assert.equal(
    (await restart.api.generateAnswer(payload)).text,
    "Confirmed availability",
  );
  assert.equal(ids[0], ids[1]);
  assert.equal(polls, 1);
  assert(!JSON.stringify(session).includes("Availability?"));
});

test("failed tasks allow explicit retry, while disconnect during pending work stops polling", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  const payload = {
      profileId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      profileVersion: "2026-09-20T00:00:00Z",
      prompt: "Question?",
    },
    ids = [];
  const failed = harness(initial, async (path, options) => {
    ids.push(JSON.parse(options.body).requestId);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        state: "failed",
        result: { error: "Please retry" },
      }),
    };
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(failed.api.generateAnswer(payload), /Please retry/);
  assert.notEqual(ids[0], ids[1]);
  const disconnect = harness(initial, async () => {
    disconnect.set({ ...disconnect.state(), disabled: true });
    return { ok: true, status: 200, json: async () => ({ state: "pending" }) };
  });
  await assert.rejects(disconnect.api.generateAnswer(payload), /连接已改变/);
  assert.equal(disconnect.requests.length, 1);
});

test("personal build connects directly without website messages and preserves queued receipts", async () => {
  const config = {
    origin,
    extensionId: "ccohapahbamkcbgkpegidkpknoeikiko",
    deviceId: randomUUID(),
    token: "p".repeat(64),
    profileToken: "q".repeat(64),
  };
  const h = harness(
    { jobsSyncV1: { outbox: [{ id: "existing" }] } },
    () => ({ ok: true, json: async () => [] }),
    config,
  );
  await h.api.ready;
  await h.api.profileRequest({
    path: "/api/extension/profiles",
    method: "GET",
  });
  assert.equal(
    h.requests[0].options.headers.Authorization,
    "Bearer " + config.profileToken,
  );
  assert.equal(h.state().deviceId, config.deviceId);
  assert.equal(h.state().outbox[0].id, "existing");
  const visible = await h.message({ type: "jobs:sync-status" });
  assert.equal(visible.connected, true);
  assert(!JSON.stringify(visible).includes(config.profileToken));
  assert(!JSON.stringify(visible).includes(config.token));
  const disconnected = harness(
    { jobsSyncV1: { disabled: true, outbox: [] } },
    undefined,
    config,
  );
  await disconnected.api.ready;
  assert.equal(disconnected.state().token, undefined);
});

test("a private credential rotation updates the same device and preserves later website pairing", async () => {
  const config = {
    origin,
    extensionId: "ccohapahbamkcbgkpegidkpknoeikiko",
    deviceId: randomUUID(),
    token: "p".repeat(64),
    profileToken: "q".repeat(64),
  };
  const initial = harness({}, undefined, config);
  await initial.api.ready;
  const old = structuredClone(initial.state());
  old.outbox = [
    {
      payload: { event_id: randomUUID() },
      attempts: 4,
      next: Date.now() + 86400000,
    },
  ];
  const updated = {
    ...config,
    token: "r".repeat(64),
    profileToken: "s".repeat(64),
  };
  const rotated = harness({ jobsSyncV1: old }, undefined, updated);
  await rotated.api.ready;
  assert.equal(rotated.state().token, updated.token);
  assert.equal(rotated.state().profileToken, updated.profileToken);
  assert.equal(rotated.state().outbox[0].next, 0);
  assert.equal(rotated.state().outbox[0].attempts, 4);
  const paired = structuredClone(rotated.state());
  paired.token = "t".repeat(64);
  paired.profileToken = "u".repeat(64);
  const restart = harness({ jobsSyncV1: paired }, undefined, updated);
  await restart.api.ready;
  assert.equal(restart.state().token, paired.token);
  assert.equal(restart.state().profileToken, paired.profileToken);
});

test("all Profile transports handle non-JSON expired auth without deleting receipt credentials or data", async () => {
  for (const action of [
    (api) => api.profileRequest({ path: "/api/extension/profiles" }),
    (api) => api.managementRequest("GET"),
    (api) =>
      api.generateAnswer({
        profileId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        profileVersion: "2026-09-20T00:00:00Z",
        prompt: "Test",
      }),
  ]) {
    const initial = connected();
    initial.jobsSyncV1.profileToken = "b".repeat(64);
    const h = harness(initial, () => ({
      ok: false,
      status: 401,
      json: async () => {
        throw Error("HTML response");
      },
    }));
    await assert.rejects(action(h.api), /连接已过期/);
    assert.equal(h.state().profileToken, undefined);
    assert.equal(h.state().token, "a".repeat(64));
    assert.equal(h.state().outbox.length, 0);
  }
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  const malformed = harness(initial, () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw Error("Truncated JSON");
    },
  }));
  await assert.rejects(
    malformed.api.managementRequest("GET"),
    /本地数据已保留/,
  );
  assert.equal(malformed.state().profileToken, "b".repeat(64));
});

test("AI sends only the fixed Profile identity/version; private facts and attachments stay server-owned", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  initial.settings = {
    premiumSettings: { responseContext: "PRIVATE legacy local facts" },
  };
  const h = harness(initial, () => ({
    ok: true,
    status: 200,
    json: async () => ({
      state: "completed",
      result: { text: "Fixture answer" },
    }),
  }));
  const profile = {
    profileName: "PRIVATE",
    contactData: { email: "private@example.test" },
    resumeData: { resumeBase64: "PRIVATE" },
  };
  await h.api.generateAnswer({
    profileId: "selected-intern",
    profileVersion: "2026-09-20T00:00:00Z",
    profile,
    responseContext: "PRIVATE stale caller facts",
    prompt: "Availability?",
  });
  const sent = JSON.parse(h.requests[0].options.body);
  assert.equal(sent.profileId, "selected-intern");
  assert.equal(sent.profileVersion, "2026-09-20T00:00:00Z");
  assert.equal(sent.profile, undefined);
  assert(!JSON.stringify(sent).includes("PRIVATE"));
  assert.equal(sent.responseContext, undefined);
  assert.equal(h.requests[0].options.headers["X-Jobs-Protocol"], "2");
  await assert.rejects(
    h.api.generateAnswer({ profile, prompt: "Unknown version" }),
    /版本不可用/,
  );
});

test("an old unauthorized response cannot clear credentials refreshed during the request", async () => {
  const initial = connected();
  initial.jobsSyncV1.profileToken = "b".repeat(64);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(initial, async () => {
    await waiting;
    return { ok: false, status: 401, json: async () => ({ error: "Expired" }) };
  });
  const pending = h.api.managementRequest("GET");
  await new Promise((resolve) => setImmediate(resolve));
  h.set({ ...h.state(), profileToken: "c".repeat(64) });
  release();
  await assert.rejects(pending, /连接已过期/);
  assert.equal(h.state().profileToken, "c".repeat(64));
});

test("minimal durable receipts send with dedicated auth and strip private query fields", async () => {
  const h = harness(connected());
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  const r = h.requests[0];
  assert.equal(r.path, origin + "/api/extension/events");
  assert.equal(r.options.credentials, "omit");
  assert.equal(r.options.headers.Authorization, "Bearer " + "a".repeat(64));
  const body = JSON.parse(r.options.body);
  assert.equal(body.job_url, url);
  assert.equal(body.proof, "ats_confirmation");
  assert.deepEqual(Object.keys(body).sort(), [
    "company",
    "event_id",
    "job_title",
    "job_url",
    "observed_at",
    "profile_name",
    "proof",
  ]);
  assert.equal(h.state().outbox.length, 0);
  assert.equal(h.alarms[0][1].periodInMinutes, 1);
  assert(!JSON.stringify(h.announced).includes("a".repeat(64)));
});

test("offline queue survives worker restart, idempotency ID is unchanged", async () => {
  const h = harness(connected(), () => {
    throw Error("Offline");
  });
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  const state = structuredClone(h.state());
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].attempts, 1);
  const event = state.outbox[0].payload.event_id;
  state.outbox[0].next = 0;
  const restarted = harness({ jobsSyncV1: state });
  await restarted.api.flush();
  assert.equal(JSON.parse(restarted.requests[0].options.body).event_id, event);
  assert.equal(restarted.state().outbox.length, 0);
});

test("no token queues locally; pairing and status reject other origins", async () => {
  const h = harness();
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert.equal(h.requests.length, 0);
  const id = h.state().deviceId;
  const bad = await h.message(
    { type: "jobs:sync-connect", token: "a".repeat(64) },
    { url: "https://evil.test", tab: { id: 1 } },
  );
  assert(bad.error);
  assert(!h.state().token);
  assert.equal((await h.message({ type: "jobs:sync-pair-info" })).deviceId, id);
  assert(
    (await h.message({ type: "jobs:sync-connect", token: "a".repeat(64) })).ok,
  );
  await h.api.flush();
  assert.equal(h.state().outbox.length, 0);
  const status = await h.message({ type: "jobs:sync-status" });
  assert.equal(status.connected, true);
  assert.equal(status.token, undefined);
});

test("expired token keeps receipt; explicit disconnect stops capture", async () => {
  const h = harness(connected(), () => ({ ok: false, status: 401 }));
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert(!h.state().token);
  assert.equal(h.state().outbox.length, 1);
  await h.message({ type: "jobs:sync-disconnect" });
  await h.api.record(app, sourceInfo);
  assert.equal(h.state().outbox.length, 1);
  assert.equal(h.state().disabled, true);
});

test("retryable receipt responses remain queued and unsupported confirmation sources stay weak", async () => {
  for (const state of ["unmatched", "held"]) {
    const h = harness(connected(), (_, o) => ({
      ok: true,
      status: 200,
      json: async () => ({
        event_id: JSON.parse(o.body).event_id,
        state,
        retryable: true,
      }),
    }));
    await h.api.record(app, sourceInfo);
    await h.api.flush();
    assert.equal(h.state().outbox.length, 1);
    assert(h.state().outbox[0].next > Date.now());
  }
  const h = harness(connected());
  await h.api.record(app, { url: sourceInfo.url });
  await h.api.flush();
  assert.equal(JSON.parse(h.requests[0].options.body).proof, "tracker_record");
  const other = harness(connected());
  await other.api.record(app, { ...sourceInfo, url: "https://evil.test" });
  await other.api.flush();
  assert.equal(
    JSON.parse(other.requests[0].options.body).proof,
    "tracker_record",
  );
  const manual = harness(connected());
  await manual.api.record(app, null);
  assert.equal(manual.requests.length, 0);
});

test("concurrent local records are all preserved while network is offline", async () => {
  const h = harness({}, () => {
    throw Error("Offline");
  });
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      h.api.record({ ...app, jobTitle: "Role " + i }, sourceInfo),
    ),
  );
  await h.api.flush();
  assert.equal(h.state().outbox.length, 15);
  assert.equal(
    new Set(h.state().outbox.map((x) => x.payload.event_id)).size,
    15,
  );
});

test("external application acknowledgment clears the outbox without a matching board job", async () => {
  const h = harness(connected(), (_, o) => ({
    ok: true,
    status: 200,
    json: async () => ({
      event_id: JSON.parse(o.body).event_id,
      state: "recorded",
      job_id: null,
      retryable: false,
    }),
  }));
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert.equal(h.state().outbox.length, 0);
  assert.equal(h.state().error, "");
  assert(h.state().lastSynced);
});

test("receipt correlation uses only the server-resolved tab binding", async () => {
  const session = {
      "jobsTabBinding:11": { websiteJobId: "a".repeat(24), at: Date.now() },
    },
    h = harness(connected(), undefined, undefined, session);
  await h.api.record(app, { ...sourceInfo, tabId: 11 });
  await h.api.flush();
  assert.equal(
    JSON.parse(h.requests[0].options.body).website_job_id,
    "a".repeat(24),
  );
});

test("repeated upstream success for the same local record does not resubmit after acknowledgment", async () => {
  const h = harness(connected());
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  // An earlier click-only record never suppresses a later confirmed event.
  const weak = harness(connected());
  await weak.api.record(app, { url });
  await weak.api.flush();
  await weak.api.record(app, sourceInfo);
  await weak.api.flush();
  assert.equal(weak.requests.length, 2);
});

test("equivalent application URLs and reordered job identifiers do not duplicate a receipt", async () => {
  const h = harness(connected());
  const one = {
    ...app,
    jobLink: url + "/application?id=1&jobid=2&source=plugin",
  };
  const two = { ...app, jobLink: url + "?jobid=2&id=1&source=email" };
  await h.api.record(one, sourceInfo);
  await h.api.flush();
  await h.api.record(two, sourceInfo);
  await h.api.flush();
  assert.equal(h.requests.length, 1);
});

test("the Ashby success wait records nothing until completion resolves", async () => {
  const source = await fs.readFile(
    new URL("../source/content/adapters/ashby.js", import.meta.url),
    "utf8",
  );
  const code = functionBlock(source, "ashbyTrackApplication");
  const dom = new JSDOM("<h1>Engineer</h1>", { url: url + "/application" });
  let complete;
  const records = [];
  const context = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    document: dom.window.document,
    window: dom.window,
    location: dom.window.location,
    jobsFindXPath: () => null,
    jobsLowercaseXPath: (s) => s,
    jobsWaitForConfirmation: () =>
      new Promise((r) => {
        complete = r;
      }),
    jobsReportJobTitle: async () => false,
    jobsSaveApplicationRecord: (r) => records.push(r),
  });
  vm.runInContext(code + ";globalThis.start=ashbyTrackApplication;", context);
  await context.start(() => {});
  assert.equal(records.length, 0);
  complete();
  await Promise.resolve();
  assert.equal(records.length, 1);
  assert.equal(records[0].jobsSyncProof, "ats_confirmation");
  assert.equal(records[0].jobLink, url);
  dom.window.close();
});

test("website bridge connects on load without website-ready and never posts token to page", async () => {
  const code = await readModule(
    new URL("../src/custom/site-bridge.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
      '<body><a data-jobs-id="fixture" data-jobs-kind="intern" href="https://example.test/job">申请 ↗</a></body>',
      { url: origin, runScripts: "outside-only" },
    ),
    w = dom.window;
  const posts = [],
    sent = [];
  let connected = false;
  w.postMessage = (data, target) => posts.push({ data, target });
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "jobs:sync-connect") {
          connected = true;
          return { ok: true };
        }
        return { deviceId: randomUUID(), extensionId: "test", connected };
      },
      onMessage: { addListener() {} },
    },
  };
  w.fetch = async () => ({
    ok: true,
    json: async () => ({ token: "s".repeat(64) }),
  });
  w.eval(code);
  await new Promise((r) => setTimeout(r, 10));
  assert(sent.some((m) => m.type === "jobs:sync-connect"));
  assert(!JSON.stringify(posts).includes("s".repeat(64)));
  assert(posts.some((p) => p.data.connected));
  assert.equal(w.document.querySelector("[data-jobs-queue]"), null);
  assert(
    sent.some(
      (m) =>
        m.type === "jobs:site-links" &&
        m.links.some((link) => link.jobId === "fixture"),
    ),
  );
  dom.window.close();
});

test("an acknowledged receipt ignored after owner undo is terminal and cannot retry", async () => {
  const h = harness(connected(), (_, o) => ({
    ok: true,
    status: 200,
    json: async () => ({
      event_id: JSON.parse(o.body).event_id,
      state: "ignored_after_undo",
      retryable: false,
    }),
  }));
  await h.api.record(app, sourceInfo);
  await h.api.flush();
  assert.equal(h.state().outbox.length, 0);
  assert.equal(h.state().error, "");
  await h.api.flush();
  assert.equal(h.requests.length, 1);
});

test("only overlapping identical job lookups share a request; later status reads stay fresh", async () => {
  const gate = Promise.withResolvers();
  let lookups = 0;
  const h = harness(
    {
      jobsSyncV1: { token: "x".repeat(64), deviceId: "synthetic", outbox: [] },
    },
    async () => {
      lookups++;
      await gate.promise;
      return { ok: true, json: async () => ({ state: "matched" }) };
    },
  );
  await h.api.ready;
  const a = h.api.resolveJob(url),
    b = h.api.resolveJob(url);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lookups, 1);
  gate.resolve();
  await Promise.all([a, b]);
  await h.api.resolveJob(url);
  assert.equal(lookups, 2);
});

test("fresh safety lookups do not share any earlier request, including another safety lookup", async () => {
  const gate = Promise.withResolvers();
  const h = harness(connected(), async () => {
    await gate.promise;
    return { ok: true, json: async () => ({ state: "matched" }) };
  });
  await h.api.ready;
  const calls = [
    h.api.resolveJob(url),
    h.api.resolveJob(url),
    h.api.resolveJob(url, undefined, { fresh: true }),
    h.api.resolveJob(url, undefined, { fresh: true }),
  ];
  try {
    await new Promise(setImmediate);
    assert.equal(h.requests.length, 3);
  } finally {
    gate.resolve();
    const results = await Promise.allSettled(calls);
    assert(results.every((result) => result.status === "fulfilled"));
  }
});

for (const submitted of [true, false])
  test(`real submission worker reads the current ${submitted ? "submitted" : "unsubmitted"} state while an older identity response is pending`, async () => {
    const gate = Promise.withResolvers(),
      started = Promise.withResolvers();
    let serverSubmitted = !submitted;
    const h = harness(connected(), async () => {
      const snapshot = serverSubmitted;
      if (h.requests.length === 1) {
        started.resolve();
        await gate.promise;
      }
      return {
        ok: true,
        json: async () => ({
          state: "matched",
          application: { submitted: snapshot },
        }),
      };
    });
    await h.api.ready;
    const oldIdentity = h.api.resolveJob(url);
    await started.promise;
    serverSubmitted = submitted;
    h.chrome.tabs.sendMessage = async () => ({ active: true, url });
    h.context.JobsTabProfiles = {
      verify: async () => ({ id: "synthetic", profileName: "Synthetic" }),
    };
    vm.runInContext(submissionSource, h.context);
    try {
      const preparing = h.message(
        { type: "jobs:submission-prepare", url },
        {
          id: h.chrome.runtime.id,
          tab: { id: 1 },
          documentId: "synthetic-document",
          url,
        },
      );
      await new Promise(setImmediate);
      gate.resolve();
      const result = await preparing;
      assert.equal(h.requests.length, 2);
      if (submitted) {
        assert.match(result.error, /已有提交记录/);
        assert.equal(h.local().jobsSubmissionGuardsV1, undefined);
      } else {
        assert(result.data?.id);
        assert.equal(
          Object.values(h.local().jobsSubmissionGuardsV1)[0].state,
          "prepared",
        );
      }
    } finally {
      gate.resolve();
      await oldIdentity;
    }
  });

const workdayA =
    "https://snapchat.wd1.myworkdayjobs.com/en-US/sourced/job/Place/Engineer_R0046951",
  workdayB =
    "https://snapchat.wd1.myworkdayjobs.com/en-US/snap/job/Place/Engineer_R0046951-1",
  workdayKeys = ["R0046951", "R0046951-1"].map((id) =>
    JSON.stringify(["snapchat.wd1.myworkdayjobs.com", "workday", id]),
  );
async function submissionAliases(initial = {}, response) {
  let liveUrl;
  const h = harness({ ...connected(), ...initial }, async () => ({
    ok: true,
    json: async () =>
      response
        ? response()
        : {
            state: "matched",
            application: { submitted: false },
            removal: { removed: false },
            identity_job_keys: workdayKeys,
          },
  }));
  await h.api.ready;
  h.chrome.tabs.sendMessage = async () => ({ active: true, url: liveUrl });
  h.context.JobsTabProfiles = { verify: async () => ({ id: "synthetic" }) };
  vm.runInContext(submissionSource, h.context);
  return {
    ...h,
    prepare: (page = workdayB, extra = {}) => {
      liveUrl = page;
      return h.message(
        { type: "jobs:submission-prepare", url: page, ...extra },
        {
          id: h.chrome.runtime.id,
          tab: { id: 2 },
          documentId: "synthetic-document",
          url: page,
        },
      );
    },
  };
}
for (const state of ["prepared", "attempted", "validation_error"])
  test(`fresh verified alias blocks a legacy ${state} guard before its server receipt`, async () => {
    const guards = {
      [workdayKeys[0]]: { id: "old-guard", state, documentId: "old-document" },
    };
    const h = await submissionAliases({ jobsSubmissionGuardsV1: guards });
    assert.match((await h.prepare()).error || "", /提交保护记录/);
    assert.deepEqual(h.local().jobsSubmissionGuardsV1, guards);
  });
test("fresh verified alias blocks preparation while another public URL has a pending local removal", async () => {
  const h = await submissionAliases({
    jobsSyncV1: {
      ...connected().jobsSyncV1,
      availability: {
        [workdayKeys[0]]: {
          payload: { proof: "manual_remove", job_url: workdayA },
          at: 1,
        },
      },
    },
  });
  assert.match((await h.prepare()).error || "", /移除/);
  assert.equal(h.local().jobsSubmissionGuardsV1, undefined);
});
test("a prepared alias remains protected before any submission has entered the outbox", async () => {
  const h = await submissionAliases();
  assert((await h.prepare(workdayA)).data?.id);
  assert.equal(h.state().outbox.length, 0);
  assert.match((await h.prepare(workdayB)).error || "", /提交保护记录/);
  assert.equal(Object.keys(h.local().jobsSubmissionGuardsV1).length, 1);
});
test("manual observed clicks retain their own attempt even when an alias already has a guard", async () => {
  const guard = {
    id: "old-guard",
    state: "prepared",
    documentId: "old-document",
  };
  const h = await submissionAliases({
    jobsSubmissionGuardsV1: { [workdayKeys[0]]: guard },
  });
  const result = await h.prepare(workdayB, {
    type: "jobs:submission-observed",
  });
  assert.equal(result.data?.ok, true);
  assert.deepEqual(h.local().jobsSubmissionGuardsV1[workdayKeys[0]], guard);
  assert.equal(
    h.local().jobsSubmissionGuardsV1[workdayKeys[1]].state,
    "attempted",
  );
  assert.equal(h.state().outbox[0].payload.proof, "submit_attempt");
  assert.equal(h.state().outbox[0].payload.job_url, workdayB);
});
test("submission alias identity comes from the fresh service, never the page message", async () => {
  const initial = {
    jobsSubmissionGuardsV1: {
      [workdayKeys[0]]: { id: "old", state: "prepared" },
    },
  };
  const legacy = await submissionAliases(initial, () => ({
    state: "matched",
    application: { submitted: false },
  }));
  assert(
    (await legacy.prepare(workdayB, { identity_job_keys: workdayKeys })).data
      ?.id,
    "a page cannot extend an old server's raw-URL identity",
  );
  const verified = await submissionAliases(initial);
  assert.match(
    (await verified.prepare(workdayB, { identity_job_keys: [workdayKeys[1]] }))
      .error || "",
    /提交保护记录/,
  );
});
for (const page of [
  workdayB.replace("R0046951-1", "R0046951-2"),
  workdayB.replace("snapchat.wd1", "other.wd1"),
  workdayB.replace("R0046951-1", "R0046952-1"),
])
  test(`an unverified Workday posting remains independent: ${page}`, async () => {
    let key;
    const h = await submissionAliases(
      {
        jobsSubmissionGuardsV1: {
          [workdayKeys[0]]: { id: "old", state: "prepared" },
        },
        jobsSyncV1: {
          ...connected().jobsSyncV1,
          availability: {
            [workdayKeys[0]]: { payload: { proof: "manual_remove" } },
          },
        },
      },
      () => ({
        state: "matched",
        application: { submitted: false },
        identity_job_keys: [key],
      }),
    );
    key = h.context.JobsJobMatch.key(page);
    assert((await h.prepare(page)).data?.id);
  });
test("final preparation refuses server removal and deletion queued during its JSON read", async () => {
  const removed = await submissionAliases({}, () => ({
    state: "matched",
    removal: { removed: true },
  }));
  assert.match((await removed.prepare()).error || "", /移除/);
  assert.equal(removed.local().jobsSubmissionGuardsV1, undefined);
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  const h = await submissionAliases({}, async () => {
    started.resolve();
    await gate.promise;
    return {
      state: "matched",
      application: { submitted: false },
      identity_job_keys: workdayKeys,
    };
  });
  const pending = h.prepare();
  await started.promise;
  h.set({
    ...h.state(),
    availability: { [workdayKeys[0]]: { payload: { proof: "manual_remove" } } },
  });
  gate.resolve();
  assert.match((await pending).error || "", /移除/);
  assert.equal(h.local().jobsSubmissionGuardsV1, undefined);
});
test("fresh alias metadata cannot survive a connection change during response JSON", async () => {
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  const h = await submissionAliases({}, async () => {
    started.resolve();
    await gate.promise;
    return { state: "matched", identity_job_keys: workdayKeys };
  });
  const pending = h.prepare();
  await started.promise;
  await h.clearSession();
  gate.resolve();
  assert.match((await pending).error || "", /连接已改变/);
  assert.equal(h.local().jobsSubmissionGuardsV1, undefined);
});
test("malformed present identity metadata cannot fall back to raw-URL submission", async () => {
  const malformed = [
    null,
    [],
    "not-an-array",
    [workdayKeys[0]],
    [workdayKeys[1], workdayKeys[1]],
    [workdayKeys[1], 1],
    [workdayKeys[1], "{}"],
    [workdayKeys[1], '["host","workday",1]'],
    [workdayKeys[1], "x".repeat(4097)],
    [
      workdayKeys[1],
      ...Array.from({ length: 64 }, (_, i) =>
        JSON.stringify(["example.test", "workday", String(i)]),
      ),
    ],
  ];
  for (const keys of malformed) {
    const h = await submissionAliases({}, () => ({
      state: "matched",
      identity_job_keys: keys,
    }));
    assert.match((await h.prepare()).error || "", /身份校验/);
    assert.equal(h.local().jobsSubmissionGuardsV1, undefined);
  }
});
test("removalPending keeps raw-URL and unidentified login compatibility unless verified keys are supplied", async () => {
  const h = await submissionAliases({
    jobsSyncV1: {
      ...connected().jobsSyncV1,
      availability: {
        [workdayKeys[0]]: { payload: { proof: "manual_remove" } },
      },
    },
  });
  assert.equal(await h.api.removalPending(workdayA), true);
  assert.equal(await h.api.removalPending(workdayB), false);
  assert.equal(await h.api.removalPending(workdayB, workdayKeys), true);
  const login = "https://snapchat.wd1.myworkdayjobs.com/login";
  assert.equal(h.context.JobsJobMatch.key(login), null);
  assert.equal(await h.api.removalPending(login), false);
  await assert.rejects(h.api.removalPending(login, workdayKeys), /身份校验/);
  const largest = [
    workdayKeys[1],
    ...Array.from({ length: 63 }, (_, i) =>
      JSON.stringify(["example.test", "workday", String(i)]),
    ),
  ];
  assert.equal(await h.api.removalPending(workdayB, largest), false);
});

test("different job hints and changed connection epochs cannot share a lookup", async () => {
  const gate = Promise.withResolvers();
  const h = harness(connected(), async () => {
    await gate.promise;
    return { ok: true, json: async () => ({ state: "matched" }) };
  });
  await h.api.ready;
  const calls = [
    h.api.resolveJob(url, "a".repeat(24)),
    h.api.resolveJob(url, "b".repeat(24)),
    h.api.resolveJob(url),
  ];
  try {
    await new Promise(setImmediate);
    assert.equal(h.requests.length, 3);
    await h.clearSession();
    calls.push(h.api.resolveJob(url));
    await new Promise(setImmediate);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(
      h.requests.map(
        (request) => JSON.parse(request.options.body).website_job_id,
      ),
      ["a".repeat(24), "b".repeat(24), undefined, undefined],
    );
  } finally {
    gate.resolve();
    const results = await Promise.allSettled(calls);
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected", "rejected", "fulfilled"],
    );
    for (const result of results.slice(0, 3))
      assert.match(result.reason.message, /连接已改变/);
  }
});

for (const fresh of [false, true])
  for (const phase of ["fetch", "json"])
    test(`${fresh ? "fresh" : "shared"} resolution rejects an old connection during ${phase}`, async () => {
      const gate = Promise.withResolvers(),
        started = Promise.withResolvers();
      const wait = async () => {
        started.resolve();
        await gate.promise;
      };
      const h = harness(connected(), async () => {
        if (phase === "fetch") await wait();
        return {
          ok: true,
          json: async () => {
            if (phase === "json") await wait();
            return { state: "matched", application: { submitted: false } };
          },
        };
      });
      const pending = h.api.resolveJob(url, undefined, { fresh });
      await started.promise;
      await h.clearSession();
      gate.resolve();
      await assert.rejects(pending, /连接已改变/);
    });
