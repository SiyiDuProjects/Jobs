import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { spawnSync } from "node:child_process";
import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";

const source = await readModule(
  new URL("../src/custom/control-background.js", import.meta.url),
  "utf8",
);
const historySource = await readWithDependencies(
  new URL("../src/custom/history-background.js", import.meta.url),
  "utf8",
);
const matchSource = await readModule(
  new URL("../src/custom/job-match.js", import.meta.url),
  "utf8",
);
const publicUrlSource = await readModule(
  new URL("../src/custom/public-job-url.js", import.meta.url),
  "utf8",
);
const matchRules = JSON.parse(
  await fs.readFile(
    new URL(
      "../../../services/jobs-radar/jobs_radar/job_match_rules.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const KEY = "jobsBrowserControlV1";

test("control heartbeat recovery pause stops pages before dispatch and retains pending responses", async () => {
  const h = harness({
    respond: () =>
      Response.json({ code: "recovery_application_pause" }, { status: 503 }),
  });
  const pendingKey = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const pending = {
    [pendingKey]: [{ question: "Synthetic", response: "Pending" }],
  };
  h.context.JobsManagementSync = {
    pendingSnapshot: async () => structuredClone(pending),
  };
  h.context.chrome.tabs.query = async () => [{ id: 1 }];
  h.context.chrome.tabs.sendMessage = async (_id, message) => {
    h.deliveries.push({ msg: message });
    return { ok: true };
  };
  await h.ready();
  Object.assign(h.session, pending, { profile_1: { profile: "Synthetic" } });
  await h.tick();
  assert.equal(h.session.profile_1, undefined);
  assert.deepEqual(h.session[pendingKey], pending[pendingKey]);
  assert.equal(
    h.deliveries.some(
      ({ msg }) => msg.type === "jobs:private-session-invalidated",
    ),
    true,
  );
  assert.equal(
    h.deliveries.some(({ msg }) => msg.type === "jobs:control-execute"),
    false,
  );
});
for (const boundary of ["response", "pause JSON"])
  test(`old control recovery pause preserves the new connection during ${boundary}`, async () => {
    const started = Promise.withResolvers(),
      reply = Promise.withResolvers();
    const h = harness({
      respond() {
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
    });
    h.context.JobsManagementSync = { pendingSnapshot: async () => ({}) };
    await h.ready();
    const operation = h.tick();
    await started.promise;
    await h.context.JobsPrivateSession.clear();
    h.local.jobsSyncV1.profileToken = "y".repeat(64);
    h.session.profile_2 = { profile: "New synthetic profile" };
    reply.resolve(
      boundary === "response"
        ? Response.json({ code: "recovery_application_pause" }, { status: 503 })
        : { code: "recovery_application_pause" },
    );
    await operation;
    assert.deepEqual(h.session.profile_2, { profile: "New synthetic profile" });
    assert.equal(h.local.jobsSyncV1.profileToken, "y".repeat(64));
    assert.equal(
      h.deliveries.some(({ msg }) => msg.type === "jobs:control-execute"),
      false,
    );
    assert.equal(h.requests.length, 1);
  });
const page = (id, extra = {}) => ({
  tabId: id,
  frameId: 0,
  documentId: "document-" + id,
  revision: 1,
  url: "https://jobs.ashbyhq.com/test/job-" + id + "/application",
  title: "Engineer",
  profileId: "ng",
  profileName: "Newgrad",
  ats: "ashby",
  phase: "autofill-complete",
  visibility: "hidden",
  coverage: "partial",
  fields: [],
  counts: { total: 2, unfilled: 0, unsupported: 0 },
  actions: ["inspect", "submit"],
  observedAt: Date.now(),
  ...extra,
});
function harness({
  enabled = true,
  initial = {},
  respond,
  send,
  getTab,
  pages = [page(1)],
  requested = pages,
  clock = Date.now,
  runtimeSource = source,
} = {}) {
  const session = structuredClone(initial),
    local = { jobsSyncV1: { profileToken: "x".repeat(64) } };
  let message,
    removed,
    updated,
    nextTimer = 0;
  const requests = [],
    deliveries = [],
    alarms = [],
    timers = new Map();
  for (const p of pages)
    session["profile_" + p.tabId] ||= { id: "ng", profileName: "Newgrad" };
  const chrome = {
    runtime: {
      id: "private-extension",
      onMessage: {
        addListener: (f) => {
          message = f;
        },
      },
    },
    storage: {
      session: {
        getKeys: async () => Object.keys(session),
        get: async () => structuredClone(session),
        remove: async (keys) => {
          for (const key of keys) delete session[key];
        },
        set: async (data) => Object.assign(session, structuredClone(data)),
      },
      local: {
        get: async () => structuredClone(local),
        set: async (data) => Object.assign(local, structuredClone(data)),
      },
    },
    tabs: {
      get: async (id) => (getTab ? getTab(id) : { id }),
      sendMessage: async (id, msg, target) => {
        deliveries.push({ id, msg, target });
        if (send) return send(id, msg, target);
        if (msg.type === "jobs:control-inspect") {
          const p = pages.find((p) => p.tabId === id);
          return { data: structuredClone(p) };
        }
        return {
          id: msg.command.id,
          state: "completed",
          data: {
            action: msg.command.action,
            phase: "submission_pending",
            evidence: { type: "none", text: "" },
          },
        };
      },
      onRemoved: {
        addListener: (f) => {
          removed = f;
        },
      },
      onUpdated: {
        addListener: (f) => {
          updated = f;
        },
      },
    },
    alarms: {
      create: (...args) => alarms.push(args),
      onAlarm: { addListener() {} },
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: webcrypto,
    TextEncoder,
    structuredClone,
    JobsSync: { ready: Promise.resolve() },
    JobsTabProfiles: undefined,
    JobsDiagnosticsBackground: undefined,
    JobsMatchRules: matchRules,
    JobsBrand: { origin: "https://jobs.siyidu.com" },
    setTimeout: (fn, ms) => {
      timers.set(++nextTimer, { fn, ms, at: clock() + ms });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    Date: class extends Date {
      static now() {
        return clock();
      }
    },
    JSON,
    URL,
    AbortSignal,
    console,
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload, options });
      return respond
        ? respond(payload, requests.length)
        : { ok: true, json: async () => ({ enabled: true, commands: [] }) };
    },
  });
  context.JobsControlConfig = { enabled, observe: true };
  vm.runInContext(matchSource, context);
  vm.runInContext(publicUrlSource, context);
  vm.runInContext(historySource, context);
  vm.runInContext(runtimeSource, context);
  const register = async (p) =>
    new Promise((resolve) =>
      message(
        { type: "jobs:control-register", documentId: p.documentId },
        {
          id: chrome.runtime.id,
          tab: { id: p.tabId },
          frameId: p.frameId,
          documentId: "chrome-" + p.documentId,
          url: p.url,
        },
        resolve,
      ),
    );
  return {
    context,
    session,
    local,
    requests,
    deliveries,
    alarms,
    timers,
    register,
    message: (msg, sender) =>
      new Promise((resolve) => message(msg, sender, resolve)),
    tick: () => context.JobsBrowserControl.tick(),
    ready: async () => {
      for (const p of pages) await register(p);
      session[KEY].snapshotRequests = requested.map(
        ({ tabId, frameId, documentId }) => ({ tabId, frameId, documentId }),
      );
    },
    removed: (id) => removed(id),
    updated: (id) => updated(id, { status: "loading" }),
  };
}
const command = (sessionId, p, id = randomUUID()) => ({
  id,
  sessionId,
  target: {
    tabId: p.tabId,
    frameId: p.frameId,
    documentId: p.documentId,
    revision: p.revision,
  },
  action: "submit",
  args: {},
  expiresAt: Date.now() + 30000,
});
const response = (commands) => ({
  ok: true,
  json: async () => ({ enabled: true, commands }),
});

test("many large requested pages retain a bounded cache without losing inventory or fresh responses", async () => {
  const pages = Array.from({ length: 24 }, (_, i) =>
    page(i + 1, {
      fields: [{ id: "detail", label: "Synthetic", value: "x".repeat(60000) }],
    }),
  );
  const h = harness({ pages, respond: () => response([]) });
  await h.ready();
  let writes = 0;
  const set = h.context.chrome.storage.session.set;
  h.context.chrome.storage.session.set = async (values) => {
    writes++;
    return set(values);
  };
  await h.tick();
  assert.equal(h.requests[0].payload.pages.length, 24);
  assert.equal(Object.keys(h.session[KEY].frames).length, 24);
  assert(Buffer.byteLength(JSON.stringify(h.session[KEY])) < 1100000);
  assert(
    writes < 10,
    "snapshot collection must batch storage writes across tabs",
  );
});

test("a long session retires acknowledged expired commands without locking out all further review answers", async () => {
  const journal = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      "old-" + i,
      {
        key: JSON.stringify({ expiresAt: Date.now() - 60000 }),
        reported: true,
        result: { id: "old-" + i, state: "completed" },
      },
    ]),
  );
  const h = harness({
    initial: {
      [KEY]: { sessionId: "same-session", frames: {}, journal, results: [] },
    },
    respond: (payload) =>
      response([
        {
          ...command(payload.sessionId, page(1)),
          action: "answer_review",
          args: { answers: [] },
        },
      ]),
  });
  await h.ready();
  await h.tick();
  assert.equal(h.requests[0].options.headers["X-Jobs-Protocol"], "2");
  assert.equal(
    h.deliveries.filter((row) => row.msg.type === "jobs:control-execute")
      .length,
    1,
  );
});

async function fireDue(h, now) {
  for (const [id, timer] of [...h.timers])
    if (timer.at <= now) {
      h.timers.delete(id);
      timer.fn();
    }
  await new Promise((resolve) => setImmediate(resolve));
}

test("a valid slow fill batch keeps its result channel past 20 seconds and executes only once", async () => {
  let now = Date.now(),
    cmd,
    finish,
    started;
  const start = new Promise((resolve) => (started = resolve));
  const h = harness({
    clock: () => now,
    respond: (payload) =>
      response([
        (cmd ||= {
          ...command(payload.sessionId, page(1)),
          action: "fill_answers",
          expiresAt: now + 30000,
        }),
      ]),
    send: async (_, message) => {
      if (message.type === "jobs:control-inspect") return { data: page(1) };
      started();
      return new Promise(
        (resolve) =>
          (finish = () =>
            resolve({
              id: message.command.id,
              state: "completed",
              data: {
                action: "fill_answers",
                appliedFieldIds: ["one", "two"],
                failedFieldIds: [],
              },
            })),
      );
    },
  });
  await h.ready();
  let settled = false;
  const pending = h.tick().then(() => (settled = true));
  await start;
  now += 21000;
  await fireDue(h, now);
  assert.equal(
    settled,
    false,
    "deadline follows the valid command, not the former 20-second receipt timeout",
  );
  finish();
  await pending;
  await h.tick();
  assert.equal(h.requests.at(-1).payload.results[0].state, "completed");
  assert.deepEqual(h.requests.at(-1).payload.results[0].data.appliedFieldIds, [
    "one",
    "two",
  ]);
  assert.equal(
    h.deliveries.filter((item) => item.msg.type === "jobs:control-execute")
      .length,
    1,
  );
});

test("deadline receipt grace retains a partial expired fill result without resubmitting it", async () => {
  let now = Date.now(),
    cmd,
    finish,
    started;
  const start = new Promise((resolve) => (started = resolve));
  const h = harness({
    clock: () => now,
    respond: (payload) =>
      response([
        (cmd ||= {
          ...command(payload.sessionId, page(1)),
          expiresAt: now + 30000,
        }),
      ]),
    send: async (_, message) => {
      if (message.type === "jobs:control-inspect") return { data: page(1) };
      started();
      return new Promise(
        (resolve) =>
          (finish = () =>
            resolve({
              id: message.command.id,
              state: "completed",
              data: {
                action: "fill_answers",
                appliedFieldIds: ["one"],
                failedFieldIds: ["two"],
              },
            })),
      );
    },
  });
  await h.ready();
  const pending = h.tick();
  await start;
  now += 30500;
  await fireDue(h, now);
  finish();
  await pending;
  await h.tick();
  assert.equal(h.requests.at(-1).payload.results[0].state, "completed");
  assert.deepEqual(h.requests.at(-1).payload.results[0].data.failedFieldIds, [
    "two",
  ]);
  assert.equal(
    h.deliveries.filter((item) => item.msg.type === "jobs:control-execute")
      .length,
    1,
  );
});

test("unresponsive dispatch is bounded by expiry and remains unknown despite a late receipt", async () => {
  let now = Date.now(),
    cmd,
    finish,
    started;
  const start = new Promise((resolve) => (started = resolve));
  const h = harness({
    clock: () => now,
    respond: (payload) =>
      response([
        (cmd ||= {
          ...command(payload.sessionId, page(1)),
          expiresAt: now + 60000,
        }),
      ]),
    send: async (_, message) => {
      if (message.type === "jobs:control-inspect") return { data: page(1) };
      started();
      return new Promise(
        (resolve) =>
          (finish = () =>
            resolve({
              id: message.command.id,
              state: "completed",
              data: { action: "submit", evidence: { type: "none", text: "" } },
            })),
      );
    },
  });
  await h.ready();
  const pending = h.tick();
  await start;
  now += 62001;
  await fireDue(h, now);
  await pending;
  finish();
  await h.tick();
  assert.equal(h.requests.at(-1).payload.results[0].state, "unknown");
  assert.equal(
    h.deliveries.filter((item) => item.msg.type === "jobs:control-execute")
      .length,
    1,
  );
});

test("observation-only mode reports pages but never dispatches commands returned by the server", async () => {
  const h = harness({
    enabled: false,
    respond: (payload) =>
      response([command(payload.sessionId, payload.pages[0])]),
  });
  await h.ready();
  await h.tick();
  assert.equal(h.requests.length, 1);
  assert(
    h.deliveries.every((item) => item.msg.type === "jobs:control-inspect"),
  );
});

test("independent closed-tab history retries after failure and requires explicit acknowledgement", async () => {
  let attempt = 0;
  const h = harness({
    enabled: false,
    pages: [],
    respond: () => {
      attempt++;
      if (attempt === 1) throw Error("Offline");
      return {
        ok: true,
        json: async () => ({
          enabled: true,
          commands: [],
          ...(attempt >= 3 ? { historyAccepted: true } : {}),
        }),
      };
    },
  });
  await h.context.JobsDiagnosticHistory.capture({
    valuePolicy: "values_omitted",
    sessionId: "doc",
    pageUrl: "https://jobs.ashbyhq.com/test/job/application",
    ats: "ashby",
    observedAt: Date.now(),
    phase: "complete-manually",
    fields: [
      {
        id: "field-1",
        question: "Start date",
        kind: "date",
        status: "not_attempted",
      },
    ],
    events: [],
  });
  for (let i = 0; i < 4; i++)
    await h.context.JobsDiagnosticHistory.sync().catch(() => {});
  assert.equal(h.requests.length, 3);
  assert(
    h.requests.every(
      (r) =>
        r.url.endsWith("/api/extension/diagnostics") &&
        r.payload.history?.length === 1 &&
        !Object.hasOwn(r.payload, "pages"),
    ),
  );
  assert.equal(
    h.deliveries.length,
    0,
    "history upload cannot send a browser action",
  );
});

test("idle polls contain inventory only and snapshots require the server to request the exact document", async (t) => {
  const pages = [page(1), page(2)];
  let poll = 0;
  const h = harness({
    pages,
    requested: [],
    respond: () => ({
      ok: true,
      json: async () => ({
        enabled: true,
        commands: [],
        snapshotRequests:
          ++poll === 1
            ? [{ tabId: 2, frameId: 0, documentId: "document-2" }]
            : [],
      }),
    }),
  });
  await h.ready();
  await h.tick();
  assert.deepEqual(h.requests[0].payload.pages, []);
  assert.equal(h.deliveries.length, 0);
  assert.deepEqual(Object.keys(h.requests[0].payload.inventory[0]).sort(), [
    "documentId",
    "frameId",
    "tabId",
  ]);
  await h.tick();
  assert.deepEqual(
    h.requests[1].payload.pages.map((row) => row.tabId),
    [2],
  );
  await h.tick();
  assert.deepEqual(h.requests[2].payload.pages, []);
  assert.equal(h.deliveries.length, 1);
  t.diagnostic(
    JSON.stringify({
      idlePolls: 2,
      inventoryEntriesPerPoll: 2,
      idleFullSnapshots: 0,
      idleFieldPayloadBytes: 0,
      requestedSnapshots: 1,
      actualFrameReads: h.deliveries.length,
    }),
  );
});

test("one exchange reports 17 bound pages without exposing credentials or changing focus", async () => {
  const pages = Array.from({ length: 17 }, (_, i) => page(i + 1));
  const h = harness({ pages });
  await h.ready();
  await h.tick();
  const { payload, options } = h.requests[0];
  assert.equal(payload.pages.length, 17);
  assert.equal(new Set(payload.pages.map((p) => p.tabId)).size, 17);
  assert(
    payload.pages.every(
      (p) => p.profileId === "ng" && p.visibility === "hidden",
    ),
  );
  assert(!JSON.stringify(payload).includes("x".repeat(64)));
  assert.equal(options.credentials, "omit");
});

test("long school options retain the complete form and its remote capabilities", async () => {
  const field = {
    id: "school",
    question: "School?",
    type: "select-one",
    required: true,
    filled: true,
    invalid: false,
    supported: true,
    value: "Berkeley",
    options: Array.from({ length: 319 }, (_, i) => ({
      value: "school-" + i,
      label: "Long university name " + i,
    })),
  };
  const h = harness({ pages: [page(1, { fields: [field] })] });
  await h.ready();
  await h.tick();
  const result = h.requests[0].payload.pages[0];
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].question, "School?");
  assert.equal(result.fields[0].value, "Berkeley");
  assert.deepEqual(result.fields[0].options, field.options);
  assert.deepEqual(result.actions, ["inspect", "submit"]);
});

test("twenty realistic large forms retain every review choice and both remote review actions", async () => {
  const school = {
    id: "school",
    question: "School?",
    type: "select-one",
    required: true,
    filled: true,
    invalid: false,
    supported: true,
    options: Array.from({ length: 1500 }, (_, i) => ({
      value: "school-" + i,
      label: "University option " + i,
    })),
  };
  const choice = {
    id: "choice",
    question: "Organization preference?",
    type: "select-one",
    required: true,
    filled: false,
    invalid: false,
    supported: true,
    options: [
      { value: "a", label: "Organization A" },
      { value: "b", label: "Organization B" },
    ],
  };
  const review = {
    id: "review",
    ready: true,
    action: "submit",
    items: [{ itemId: "one", fieldId: "choice", version: 1 }],
  };
  const actions = ["inspect", "answer_review", "confirm_review"];
  const fields = [
    school,
    choice,
    ...Array.from({ length: 47 }, (_, i) => ({
      ...choice,
      id: "question-" + i,
      question: "Application question " + i + "?",
    })),
  ];
  const h = harness({
    pages: Array.from({ length: 20 }, (_, i) =>
      page(i + 1, { phase: "ai-review", fields, review, actions }),
    ),
  });
  await h.ready();
  await h.tick();
  assert.equal(h.requests[0].payload.pages.length, 20);
  for (const observed of h.requests[0].payload.pages) {
    assert.deepEqual(observed.fields, fields);
    assert.deepEqual(observed.review, review);
    assert.deepEqual(observed.actions, actions);
  }
  assert(Buffer.byteLength(h.requests[0].options.body) > 512 * 1024);
  assert(Buffer.byteLength(h.requests[0].options.body) < 8 * 1024 * 1024);
});

test("large diagnostic events cannot erase a stalled page from the heartbeat", async () => {
  const events = Array.from({ length: 50 }, (_, i) => ({
    at: Date.now() + i,
    type: "auto_blocked",
    detail: "等待下拉选项".repeat(45),
  }));
  const h = harness({
    enabled: false,
    pages: [page(1, { phase: "in-progress", events })],
  });
  await h.ready();
  await h.tick();
  const pages = h.requests[0].payload.pages;
  assert.equal(pages.length, 1);
  assert.equal(pages[0].phase, "in-progress");
  assert(pages[0].events.length > 0);
  assert(Buffer.byteLength(JSON.stringify(pages[0])) <= 512 * 1024);
  assert.equal(pages[0].events.at(-1).at, events.at(-1).at);
});

test("truncating diagnostics preserves complete review options and remote card permissions", async () => {
  const field = {
    id: "field-1",
    question: "Location?",
    type: "select-one",
    required: true,
    filled: false,
    invalid: false,
    supported: true,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  };
  const review = {
    id: "review-1",
    ready: true,
    action: "next",
    items: [{ itemId: "0", fieldId: "field-1", version: 1 }],
  };
  const actions = ["inspect", "answer_review", "confirm_review"];
  const events = Array.from({ length: 50 }, () => ({
    at: Date.now(),
    type: "auto_blocked",
    detail: "等待补答".repeat(65),
  }));
  const h = harness({
    pages: [
      page(1, { phase: "ai-review", fields: [field], review, actions, events }),
    ],
  });
  await h.ready();
  await h.tick();
  const observed = h.requests[0].payload.pages[0];
  assert.deepEqual(observed.fields, [field]);
  assert.deepEqual(observed.review, review);
  assert.deepEqual(observed.actions, actions);
  assert(Buffer.byteLength(JSON.stringify(observed)) <= 512 * 1024);
});

test("compacting a large observation keeps the answer source ahead of later activity", async () => {
  const decision = {
    at: Date.now(),
    type: "answer_decision",
    fieldId: "field-1",
    detail: JSON.stringify({
      source: "saved",
      reason: "keyword_match",
      ruleId: "fixture-rule",
    }),
  };
  const events = [
    decision,
    ...Array.from({ length: 49 }, (_, i) => ({
      at: Date.now() + i,
      type: "auto_control_result",
      detail: "等待下拉选项".repeat(45),
    })),
  ];
  const h = harness({
    enabled: false,
    pages: [page(1, { phase: "in-progress", events })],
  });
  await h.ready();
  await h.tick();
  const observed = h.requests.at(-1).payload.pages[0];
  assert(observed.events.some((event) => event.type === "answer_decision"));
  assert(Buffer.byteLength(JSON.stringify(observed)) <= 512 * 1024);
});

test("64 noisy pages retain their last blocker without overrunning the total observation budget", async () => {
  const events = [
    { at: Date.now(), type: "auto_options_wait", detail: "Notice period" },
    ...Array.from({ length: 49 }, () => ({
      at: Date.now(),
      type: "input",
      detail: "普通事件".repeat(70),
    })),
  ];
  const h = harness({
    enabled: false,
    pages: Array.from({ length: 64 }, (_, i) => page(i + 1, { events })),
  });
  await h.ready();
  await h.tick();
  const pages = h.requests[0].payload.pages;
  assert.equal(pages.length, 64);
  assert(
    pages.every((p) => p.events.some((e) => e.type === "auto_options_wait")),
  );
  assert(Buffer.byteLength(h.requests[0].options.body) < 8 * 1024 * 1024);
});

test("renewed registration preserves the last snapshot when the document is unchanged", async () => {
  let offline = false;
  const h = harness({
    send: async () => {
      if (offline) throw Error("Frozen");
      return { data: page(1) };
    },
  });
  await h.ready();
  await h.tick();
  offline = true;
  await h.register(page(1));
  h.session[KEY].snapshotRequests = [
    { tabId: 1, frameId: 0, documentId: "document-1" },
  ];
  await h.tick();
  assert.equal(h.requests[1].payload.pages.length, 1);
  assert.equal(
    h.requests[1].payload.pages[0].observedAt,
    h.requests[0].payload.pages[0].observedAt,
  );
});

test("same command is executed once across repeated polls and worker restart", async () => {
  let cmd;
  const respond = (payload) => {
    cmd ||= command(payload.sessionId, page(1));
    return response([cmd]);
  };
  const h = harness({ respond });
  await h.ready();
  await h.tick();
  await h.tick();
  assert.equal(
    h.deliveries.filter((d) => d.msg.type === "jobs:control-execute").length,
    1,
  );
  assert.equal(h.requests[1].payload.results[0].state, "completed");
  const restarted = harness({ initial: h.session, respond });
  await restarted.tick();
  assert.equal(
    restarted.deliveries.filter((d) => d.msg.type === "jobs:control-execute")
      .length,
    0,
  );
});

test("uncertain delivery is reported without sending a second click", async () => {
  let cmd;
  const h = harness({
    respond: (p) => response([(cmd ||= command(p.sessionId, page(1)))]),
    send: async (_, message) => {
      if (message.type === "jobs:control-inspect") return { data: page(1) };
      throw Error("Connection closed after dispatch");
    },
  });
  await h.ready();
  await h.tick();
  await h.tick();
  assert.equal(h.requests[1].payload.results[0].state, "unknown");
  assert.equal(
    h.deliveries.filter((d) => d.msg.type === "jobs:control-execute").length,
    1,
  );
});

test("journal-only outcomes recover after worker interruption without redispatch", async () => {
  const sessionId = randomUUID(),
    id = randomUUID(),
    result = { id, state: "unknown", error: "Interrupted" };
  const h = harness({
    initial: {
      [KEY]: {
        sessionId,
        frames: {},
        journal: { [id]: { key: "{}", result } },
        results: [],
      },
    },
  });
  await h.tick();
  await h.tick();
  assert.deepEqual(h.requests[0].payload.results, [result]);
  assert.deepEqual(h.requests[1].payload.results, []);
  assert.equal(h.deliveries.length, 0);
});

test("removed or replaced page during inspection never enters the fresh page list", async () => {
  let resolveRead, started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  const h = harness({
    send: async () => {
      started();
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
  });
  await h.ready();
  const pending = h.tick();
  await start;
  h.updated(1);
  await Promise.resolve();
  resolveRead({ data: page(1) });
  await pending;
  assert.deepEqual(h.requests[0].payload.pages, []);
});

test("unresponsive pages keep actual old timestamp; missing tabs are removed", async () => {
  const stale = page(1, { observedAt: Date.now() - 60000 });
  const state = {
    sessionId: randomUUID(),
    frames: {
      "1:0": {
        tabId: 1,
        frameId: 0,
        documentId: stale.documentId,
        snapshot: stale,
      },
    },
    journal: {},
    results: [],
    snapshotRequests: [{ tabId: 1, frameId: 0, documentId: stale.documentId }],
  };
  const h = harness({
    initial: { [KEY]: state },
    send: async () => {
      throw Error("Frozen");
    },
  });
  await h.tick();
  assert.equal(h.requests[0].payload.pages[0].observedAt, stale.observedAt);
  const closed = harness({
    initial: { [KEY]: state },
    getTab: async () => {
      throw Error("No tab");
    },
  });
  await closed.tick();
  assert.deepEqual(closed.requests[0].payload.pages, []);
});

test("same Profile name with different bound ID removes mutation capabilities", async () => {
  const h = harness({
    pages: [page(1, { profileId: "intern", profileName: "Newgrad" })],
  });
  await h.ready();
  await h.tick();
  assert.equal(h.requests[0].payload.pages[0].profileId, null);
  assert.deepEqual(h.requests[0].payload.pages[0].actions, ["inspect"]);
});

test("disconnect during exchange prevents delivery of the returned command", async () => {
  let h;
  h = harness({
    respond: (payload) => {
      h.local.jobsSyncV1.disabled = true;
      return response([command(payload.sessionId, page(1))]);
    },
  });
  await h.ready();
  await h.tick();
  assert.equal(
    h.deliveries.filter((d) => d.msg.type === "jobs:control-execute").length,
    0,
  );
});

test("UTF-8 payload including multibyte fields and pending results stays below server bound", async () => {
  const field = {
    id: "a",
    question: "问题🙂".repeat(160),
    type: "text",
    required: true,
    filled: false,
    invalid: false,
    supported: true,
  };
  const pages = Array.from({ length: 64 }, (_, i) =>
    page(i + 1, {
      fields: Array.from({ length: 30 }, (_, j) => ({ ...field, id: "f" + j })),
    }),
  );
  const results = Array.from({ length: 64 }, () => ({
    id: randomUUID(),
    state: "failed",
    error: "错误🙂".repeat(160),
  }));
  const h = harness({
    pages,
    initial: {
      [KEY]: { sessionId: randomUUID(), frames: {}, journal: {}, results },
    },
  });
  await h.ready();
  await h.tick();
  const body = h.requests[0].options.body;
  assert(Buffer.byteLength(body) <= 8 * 1024 * 1024);
  assert.equal(h.requests[0].payload.pages.length, 64);
  assert(
    h.requests[0].payload.pages.every(
      (p) => p.fields.length === 30 && p.actions.includes("submit"),
    ),
  );
});

for (const overflow of ["bytes", "options"])
  test(`an unrelated school ${overflow} overflow retains the whole review card without general navigation`, async () => {
    const school = {
      id: "school",
      question: "School?",
      type: "select-one",
      required: true,
      filled: true,
      invalid: false,
      supported: true,
      options: Array.from(
        { length: overflow === "options" ? 5001 : 5000 },
        (_, i) => ({
          value: "s" + i,
          label: "University " + i + "x".repeat(overflow === "bytes" ? 120 : 0),
        }),
      ),
    };
    const choice = {
      id: "choice",
      question: "Preference?",
      type: "select-one",
      required: true,
      filled: false,
      invalid: false,
      supported: true,
      options: [{ value: "a", label: "A" }],
    };
    const review = {
      id: "review",
      ready: true,
      action: "submit",
      items: [{ itemId: "one", fieldId: "choice", version: 1 }],
    };
    const h = harness({
      pages: [
        page(1, {
          fields: [school, choice],
          review,
          actions: ["inspect", "answer_review", "confirm_review", "submit"],
        }),
      ],
    });
    await h.ready();
    await h.tick();
    const observed = h.requests[0].payload.pages[0];
    assert.deepEqual(observed.fields, [choice]);
    assert.deepEqual(observed.review, review);
    assert.deepEqual(observed.actions, [
      "inspect",
      "answer_review",
      "confirm_review",
    ]);
    assert(observed.events.some((e) => e.type === "remote_snapshot_truncated"));
    assert(Buffer.byteLength(h.requests[0].options.body) < 512 * 1024);
  });

test("an oversized review card cannot be confirmed with missing choices", async () => {
  const field = {
    id: "school",
    question: "School?",
    type: "select-one",
    required: true,
    filled: false,
    invalid: false,
    supported: true,
    options: Array.from({ length: 5001 }, (_, i) => ({
      value: "s" + i,
      label: "University " + i,
    })),
  };
  const review = {
    id: "review",
    ready: true,
    action: "submit",
    items: [{ itemId: "one", fieldId: "school", version: 1 }],
  };
  const h = harness({
    pages: [
      page(1, {
        fields: [field],
        review,
        actions: ["inspect", "answer_review", "confirm_review"],
      }),
    ],
  });
  await h.ready();
  await h.tick();
  const observed = h.requests[0].payload.pages[0];
  assert.deepEqual(observed.actions, ["inspect"]);
  assert(observed.events.some((e) => e.type === "remote_snapshot_truncated"));
});

test("different tabs execute concurrently but each tab executes sequentially with maximum three active", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => page(i + 1));
  let active = 0,
    maximum = 0;
  const byTab = new Set();
  const h = harness({
    pages,
    respond: (payload) =>
      response(
        pages.flatMap((p) => [
          command(payload.sessionId, p),
          command(payload.sessionId, p),
        ]),
      ),
    send: async (id, message) => {
      if (message.type === "jobs:control-inspect")
        return { data: pages[id - 1] };
      assert(!byTab.has(id));
      byTab.add(id);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      byTab.delete(id);
      active--;
      return {
        id: message.command.id,
        state: "completed",
        data: {
          action: "submit",
          phase: "submission_pending",
          evidence: { type: "none", text: "" },
        },
      };
    },
  });
  await h.ready();
  await h.tick();
  assert(maximum > 1 && maximum <= 3);
  assert.equal(
    h.deliveries.filter((d) => d.msg.type === "jobs:control-execute").length,
    10,
  );
});

if (process.env.JOBS_PERF_BASELINE)
  test("fixed idle exchange baseline compared with on-demand exchange", async () => {
    const prior = spawnSync(
      "git",
      [
        "show",
        "257a15f:extensions/speedyapply-local/src/custom/control-background.js",
      ],
      { encoding: "utf8" },
    );
    assert.equal(prior.status, 0, prior.stderr);
    const results = {
      baselineCommit: "257a15f",
      fixture:
        "2 bound frames, 60 synthetic fields per frame, 3 polls, no snapshot requests or commands",
    };
    for (const [name, runtimeSource] of [
      ["baseline", prior.stdout],
      ["current", source],
    ]) {
      const h = harness({
        runtimeSource,
        requested: [],
        pages: [1, 2].map((id) =>
          page(id, {
            fields: Array.from({ length: 60 }, (_, i) => ({
              id: "f" + i,
              question: "Synthetic question " + i,
              type: "text",
              required: true,
              filled: false,
              invalid: false,
              supported: true,
            })),
          }),
        ),
      });
      await h.ready();
      for (let n = 0; n < 3; n++) await h.tick();
      results[name] = {
        polls: h.requests.length,
        frameReads: h.deliveries.length,
        snapshots: h.requests.reduce(
          (sum, r) => sum + r.payload.pages.length,
          0,
        ),
        fieldPayloadBytes: h.requests.reduce(
          (sum, r) =>
            sum +
            r.payload.pages.reduce(
              (sum, p) => sum + Buffer.byteLength(JSON.stringify(p.fields)),
              0,
            ),
          0,
        ),
      };
    }
    assert.equal(results.current.snapshots, 0);
    assert.equal(results.current.frameReads, 0);
    assert.equal(results.baseline.snapshots, 6);
    await fs.writeFile(
      new URL("../.qa/idle-performance.json", import.meta.url),
      JSON.stringify(results, null, 2) + "\n",
    );
  });

test("connection change rejects a late control response before command dispatch", async () => {
  const started = Promise.withResolvers(),
    reply = Promise.withResolvers();
  let commandReply;
  const h = harness({
    respond(payload) {
      commandReply = response([command(payload.sessionId, page(1))]);
      started.resolve();
      return reply.promise;
    },
  });
  await h.ready();
  const task = h.tick();
  await started.promise;
  await h.context.JobsPrivateSession.clear();
  reply.resolve(commandReply);
  await task;
  assert.equal(
    h.deliveries.filter((x) => x.msg.type === "jobs:control-execute").length,
    0,
  );
  assert(!JSON.stringify(h.session).includes("profileName"));
  assert.equal(Object.keys(h.session[KEY]?.frames || {}).length, 0);
});

test("connection change during an inspection discards the old page snapshot", async () => {
  const started = Promise.withResolvers(),
    reply = Promise.withResolvers();
  const h = harness({
    send() {
      started.resolve();
      return reply.promise;
    },
  });
  await h.ready();
  const task = h.tick();
  await started.promise;
  await h.context.JobsPrivateSession.clear();
  reply.resolve({
    data: page(1, { fields: [{ value: "OLD_PRIVATE_VALUE" }] }),
  });
  await task;
  assert.equal(h.requests.length, 0);
  assert(!JSON.stringify(h.session).includes("OLD_PRIVATE_VALUE"));
});

test("only the current lifecycle can release a page and only its last frame releases the Profile", async () => {
  const h = harness({ pages: [], requested: [] });
  const released = [],
    diagnostics = [];
  h.context.JobsTabProfiles = { releasePage: async (id) => released.push(id) };
  h.context.JobsDiagnosticsBackground = {
    releasePage: async (...args) => diagnostics.push(args),
  };
  const sender = (frameId) => ({
    id: "private-extension",
    tab: { id: 8 },
    frameId,
    documentId: "browser-" + frameId,
    url: page(1).url,
  });
  const register = (frameId, lifecycleId) =>
    h.message(
      {
        type: "jobs:control-register",
        documentId: "page-" + frameId,
        lifecycleId,
      },
      sender(frameId),
    );
  const stop = (frameId, lifecycleId) =>
    h.message(
      {
        type: "jobs:control-unregister",
        documentId: "page-" + frameId,
        lifecycleId,
      },
      sender(frameId),
    );
  await register(0, "old");
  await register(0, "current");
  await register(2, "iframe");
  assert.equal((await stop(0, "old")).ok, false);
  assert.equal(Object.keys(h.session[KEY].frames).length, 2);
  const id = randomUUID();
  h.session[KEY].journal[id] = {
    key: JSON.stringify({
      target: { tabId: 8, frameId: 0, documentId: "page-0" },
      args: { answer: "PRIVATE_ANSWER" },
    }),
    result: { id, state: "completed" },
  };
  assert.equal((await stop(0, "current")).ok, true);
  assert.equal(released.length, 0);
  assert.equal(h.session[KEY].journal[id].key, "retired");
  assert.equal(h.session[KEY].journal[id].result.state, "completed");
  assert.equal((await stop(2, "iframe")).ok, true);
  assert.deepEqual(released, [8]);
  assert.deepEqual(diagnostics, [
    [8, "browser-0"],
    [8, "browser-2"],
  ]);
});
