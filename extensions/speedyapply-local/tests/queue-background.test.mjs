import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const source = await readModule(
  new URL("../src/custom/queue-background.js", import.meta.url),
  "utf8",
);
const integrationSource = (
  await Promise.all(
    ["sync", "application-queue"].map((name) =>
      readModule(new URL(`../src/custom/${name}.js`, import.meta.url), "utf8"),
    ),
  )
).join("\n");

async function integration(
  respond,
  {
    url = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555",
    afterPage,
  } = {},
) {
  let io;
  const local = {
      jobsSyncV1: { deviceId: "synthetic", token: "a".repeat(64), outbox: [] },
    },
    session = {},
    listeners = [],
    requests = [],
    announcements = [],
    event = { addListener() {} };
  const area = (values) => ({
    get: async () => structuredClone(values),
    getKeys: async () => Object.keys(values),
    set: async (data) => Object.assign(values, structuredClone(data)),
    remove: async (keys) => {
      for (const key of [keys].flat()) delete values[key];
    },
  });
  const context = vm.createContext({
    URL,
    TextEncoder,
    AbortSignal,
    crypto: webcrypto,
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return respond(path, options);
    },
    chrome: {
      runtime: {
        id: "ours",
        getURL: (path) => "chrome-extension://ours/" + path,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onInstalled: event,
        onStartup: event,
      },
      storage: { local: area(local), session: area(session) },
      alarms: { create() {}, onAlarm: event },
      tabs: {
        get: async () => ({ id: 1, url }),
        query: async () => [{ id: 1, url }],
        sendMessage: async (_id, message) => announcements.push(message),
        onRemoved: event,
        onUpdated: event,
      },
    },
  });
  vm.runInContext(integrationSource, context);
  await context.JobsSync.ready;
  const create = context.JobsApplicationQueue.create;
  context.JobsApplicationQueue = {
    create: (value) => {
      io = value;
      const engine = create(value);
      return {
        ...engine,
        page: async (...args) => {
          const reply = await engine.page(...args);
          await afterPage?.();
          return reply;
        },
      };
    },
  };
  vm.runInContext(source, context);
  return {
    io,
    listeners,
    local,
    context,
    requests,
    announcements,
    clearSession: () => context.JobsPrivateSession.clear(),
    send: (type, extra = {}) =>
      new Promise((reply) => {
        const message = {
            type: "jobs:queue-page",
            data: { type, action: "submit", url, ...extra },
          },
          sender = { id: "ours", tab: { id: 1 }, frameId: 0, url };
        assert(
          listeners.some(
            (listener) => listener(message, sender, reply) === true,
          ),
        );
      }),
  };
}

for (const mode of [
  "intent",
  "eligibility",
  "check",
  "forged",
  "invalid",
  "new connection",
])
  test(`local cancellation only expands from fresh verified identities: ${mode}`, async () => {
    const h = await integration(
      async () => ({
        ok: true,
        json: async () => ({
          state: "matched",
          removal: { removed: false },
          ...(mode === "forged"
            ? {}
            : {
                identity_job_keys:
                  mode === "invalid" ? [aliasKeys[0]] : aliasKeys,
              }),
        }),
      }),
      { url: aliasB },
    );
    if (mode === "eligibility") await h.io.resolve(aliasB);
    else
      await h.send(mode === "check" ? "check" : "intent", {
        identity_job_keys: aliasKeys,
      });
    if (mode === "new connection") await h.clearSession();
    const tabs = [
        aliasA,
        aliasB,
        aliasB.replace("R0046951-1", "R0046951-2"),
        aliasB.replace("snapchat.wd1", "other.wd1"),
      ].map((url, index) => ({ id: index + 1, url })),
      stopped = [];
    h.context.chrome.tabs.query = async () => tabs;
    h.context.chrome.tabs.sendMessage = async (id, message) => {
      if (message.state?.removed) stopped.push(id);
    };
    const requests = h.requests.length;
    await h.context.JobsQueueBackground.remove(aliasA);
    assert.deepEqual(
      stopped,
      ["intent", "eligibility"].includes(mode) ? [1, 2] : [1],
    );
    assert.equal(
      h.requests.length,
      requests,
      "cancellation does not wait for another network request",
    );
  });

const aliasA =
    "https://snapchat.wd1.myworkdayjobs.com/en-US/sourced/job/Place/Engineer_R0046951",
  aliasB =
    "https://snapchat.wd1.myworkdayjobs.com/en-US/snap/job/Place/Engineer_R0046951-1",
  aliasKeys = ["R0046951", "R0046951-1"].map((id) =>
    JSON.stringify(["snapchat.wd1.myworkdayjobs.com", "workday", id]),
  );
function pendingAlias(h) {
  h.local.jobsSyncV1.availability = {
    [aliasKeys[0]]: {
      payload: { proof: "manual_remove", job_url: aliasA },
      at: 1,
    },
  };
}
for (const phase of ["json", "engine"])
  test(`verified alias intent rechecks deletion arriving during ${phase}`, async () => {
    const gate = Promise.withResolvers(),
      started = Promise.withResolvers();
    const pause = async () => {
      started.resolve();
      await gate.promise;
    };
    const h = await integration(
      async () => ({
        ok: true,
        json: async () => {
          if (phase === "json") await pause();
          return {
            state: "matched",
            removal: { removed: false },
            identity_job_keys: aliasKeys,
          };
        },
      }),
      { url: aliasB, afterPage: phase === "engine" ? pause : undefined },
    );
    const intent = h.send("intent", {
      action: phase === "json" ? "next" : "submit",
    });
    await started.promise;
    pendingAlias(h);
    gate.resolve();
    const reply = await intent;
    assert.equal(reply.data?.removed, true);
    assert.equal(reply.data?.allowed, false);
  });
test("queue eligibility rechecks pending alias removal after its fresh request", async () => {
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  const h = await integration(
    async () => ({
      ok: true,
      json: async () => {
        started.resolve();
        await gate.promise;
        return {
          state: "matched",
          removal: { removed: false },
          identity_job_keys: aliasKeys,
        };
      },
    }),
    { url: aliasB },
  );
  const resolving = h.io.resolve(aliasB, "a".repeat(24));
  await started.promise;
  pendingAlias(h);
  gate.resolve();
  await assert.rejects(resolving, /移除/);
});
test("queue intents ignore page-forged identity lists and only use fresh service identities", async () => {
  for (const verified of [false, true]) {
    const h = await integration(
      async () => ({
        ok: true,
        json: async () => ({
          state: "matched",
          removal: { removed: false },
          ...(verified ? { identity_job_keys: aliasKeys } : {}),
        }),
      }),
      { url: aliasB },
    );
    pendingAlias(h);
    // A startup check may coalesce identity reads; it does not grant navigation.
    assert.equal((await h.send("check")).data?.allowed, true);
    const reply = await h.send("intent", {
      identity_job_keys: verified ? [aliasKeys[1]] : aliasKeys,
    });
    assert.equal(reply.data?.allowed, !verified);
    assert.equal(reply.data?.removed, verified ? true : undefined);
    assert.equal(h.requests.length, 2);
  }
});
test("queue fresh intents reject malformed identity metadata instead of silently losing alias protection", async () => {
  for (const keys of [null, [], [aliasKeys[0]], [aliasKeys[1], "not-a-key"]]) {
    const h = await integration(
      async () => ({
        ok: true,
        json: async () => ({
          state: "matched",
          removal: { removed: false },
          identity_job_keys: keys,
        }),
      }),
      { url: aliasB },
    );
    const reply = await h.send("intent");
    assert.match(reply.error || "", /身份校验/);
    assert.equal(reply.data, undefined);
  }
});
test("connection changes while queue processing cannot release old alias permission", async () => {
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  const h = await integration(
    async () => ({
      ok: true,
      json: async () => ({
        state: "matched",
        removal: { removed: false },
        identity_job_keys: aliasKeys,
      }),
    }),
    {
      url: aliasB,
      afterPage: async () => {
        started.resolve();
        await gate.promise;
      },
    },
  );
  const intent = h.send("intent");
  await started.promise;
  await h.clearSession();
  gate.resolve();
  assert.match((await intent).error || "", /连接已改变/);
});

for (const failure of [
  "network",
  "http-500",
  "null",
  "missing-state",
  "missing-removal",
  "invalid-removal",
])
  test(`final ordinary-page intent rejects ${failure} while checks remain tolerant`, async () => {
    const h = await integration(async () => {
      if (failure === "network") throw Error("Synthetic network failure");
      if (failure === "http-500") return { ok: false, status: 500 };
      const value = {
        null: null,
        "missing-state": { removal: { removed: false } },
        "missing-removal": { state: "matched" },
        "invalid-removal": { state: "matched", removal: { removed: null } },
      }[failure];
      return { ok: true, json: async () => value };
    });
    assert.equal((await h.send("check")).data?.allowed, true);
    const reply = await h.send("intent");
    assert(
      reply.error || reply.data?.allowed === false,
      "unverified safety read must not grant navigation",
    );
    assert.equal((await h.send("check")).data?.allowed, true);
    assert.equal(h.requests.length, 2, "only intent bypasses the cached check");
  });

test("final ordinary-page intent rejects a connection change while resolution JSON is pending", async () => {
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  const h = await integration(async () => ({
    ok: true,
    json: async () => {
      started.resolve();
      await gate.promise;
      return { state: "matched", removal: { removed: true } };
    },
  }));
  const intent = h.send("intent");
  try {
    await started.promise;
    await h.clearSession();
  } finally {
    gate.resolve();
  }
  const reply = await intent;
  assert.match(reply.error || "", /连接已改变/);
  assert.equal(reply.data, undefined);
  assert(
    h.announcements.some(
      (message) => message.type === "jobs:private-session-invalidated",
    ),
  );
});

for (const state of ["unmatched", "matched", "removed"])
  test(`final ordinary-page intent retains the real service ${state} contract`, async () => {
    const h = await integration(async () => ({
      ok: true,
      json: async () =>
        state === "unmatched"
          ? { state, application: null }
          : { state: "matched", removal: { removed: state === "removed" } },
    }));
    const reply = await h.send("intent");
    assert.equal(reply.error, undefined);
    assert.equal(reply.data.allowed, state !== "removed");
    assert.equal(reply.data.owned, state === "removed");
    assert.equal(h.requests.length, 1);
  });

test("queue background accepts only its UI, website enqueue and authenticated content documents", async () => {
  let listener;
  const events = [],
    event = { addListener: () => {} };
  const engine = {
    tick: async () => {},
    command: async (...args) => {
      events.push(["command", ...args]);
      return {};
    },
    page: async (...args) => {
      events.push(["page", ...args]);
      return {};
    },
  };
  const chrome = {
    runtime: {
      id: "ours",
      getURL: (path) => "chrome-extension://ours/" + path,
      onMessage: { addListener: (fn) => (listener = fn) },
      onStartup: event,
    },
    alarms: { create: () => {}, onAlarm: event },
    tabs: { onRemoved: event, onUpdated: event },
  };
  vm.runInNewContext(source, {
    chrome,
    JobsApplicationQueue: { create: () => engine },
    JobsSync: {
      removalPending: async () => false,
      resolveJob: async () => null,
    },
    JobsJobMatch: { key: () => null },
    URL,
  });
  const send = (message, sender) =>
    new Promise((resolve) => listener(message, sender, resolve));
  const ui = {
    id: "ours",
    url: "chrome-extension://ours/queue.html",
    tab: { id: 10 },
    frameId: 0,
  };
  assert(!(await send({ type: "jobs:queue", action: "read" }, ui)).error);
  assert(
    (
      await send(
        { type: "jobs:queue", action: "start" },
        { ...ui, url: "https://jobs.siyidu.com/" },
      )
    ).error,
  );
  assert(
    !(
      await send(
        { type: "jobs:queue", action: "add" },
        { ...ui, url: "https://jobs.siyidu.com/" },
      )
    ).error,
  );
  assert(
    (
      await send(
        { type: "jobs:queue", action: "add" },
        { ...ui, url: "https://jobs.siyidu.com/", frameId: 1 },
      )
    ).error,
  );
  assert(
    (
      await send(
        { type: "jobs:queue", action: "read" },
        { ...ui, id: "foreign" },
      )
    ).error,
  );
  assert((await send({ type: "jobs:queue-page", data: {} }, ui)).error);
  const sender = {
    ...ui,
    url: "https://jobs.ashbyhq.com/a/b",
    documentId: "actual-document",
    documentLifecycle: "active",
  };
  assert(
    !(await send({ type: "jobs:queue-page", data: { type: "hello" } }, sender))
      .error,
  );
  assert.equal(events.length, 3);
  assert.equal(events[2][2].browserDocumentId, "actual-document");
});

test("queue eligibility and navigation intents demand fresh resolution while checks can share identity reads", async () => {
  let listener,
    io,
    removed = false,
    pageCalls = 0;
  const lookups = [],
    event = { addListener() {} },
    url = "https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555";
  vm.runInNewContext(source, {
    URL,
    chrome: {
      runtime: {
        id: "ours",
        getURL: (path) => "chrome-extension://ours/" + path,
        onMessage: { addListener: (fn) => (listener = fn) },
        onStartup: event,
      },
      alarms: { create() {}, onAlarm: event },
      tabs: { onRemoved: event, onUpdated: event },
    },
    JobsApplicationQueue: {
      create: (value) => {
        io = value;
        return {
          tick: async () => {},
          page: async () => {
            pageCalls++;
            return { owned: false, allowed: true };
          },
        };
      },
    },
    JobsSync: {
      removalPending: async () => false,
      resolveJob: async (url, hint, options) => {
        lookups.push({ url, hint, fresh: options?.fresh });
        return { state: "matched", removal: { removed } };
      },
    },
    JobsJobMatch: { key: (url) => url },
  });
  const sender = { id: "ours", tab: { id: 1 }, frameId: 0, url };
  const send = (type) =>
    new Promise((reply) =>
      listener({ type: "jobs:queue-page", data: { type, url } }, sender, reply),
    );
  await io.resolve(url, "a".repeat(24));
  assert.equal(lookups[0].fresh, true);
  assert.equal(lookups[0].hint, "a".repeat(24));
  assert.equal((await send("check")).data.allowed, true);
  assert.equal(lookups[1].fresh, false);
  assert.equal((await send("intent")).data.allowed, true);
  assert.equal(lookups[2].fresh, true);
  removed = true;
  assert.equal((await send("intent")).data.removed, true);
  assert.equal(lookups[3].fresh, true);
  assert.equal(
    pageCalls,
    2,
    "the final removal check must stop the engine call",
  );
});

const submissionCode = await readModule(
  new URL("../src/custom/submission-background.js", import.meta.url),
  "utf8",
);
const pageCode =
  (await readModule(
    new URL("../src/custom/platform-config.js", import.meta.url),
    "utf8",
  )) +
  "\n" +
  (await readWithDependencies(
    new URL("../src/custom/queue-page.js", import.meta.url),
    "utf8",
  ));
const aliasResponse = {
  state: "matched",
  application: { submitted: false },
  removal: { removed: false },
  identity_job_keys: aliasKeys,
};
for (const alias of [false, true])
  test(
    `completed deletion cancels a prepared ${alias ? "verified alias" : "same URL"} before click`,
    { timeout: 5000 },
    async () => {
      const urlA = aliasA,
        urlB = alias ? aliasB : urlA;
      const h = await integration(
        async (path) => {
          if (String(path).includes("/api/extension/resolve"))
            return {
              ok: true,
              json: async () => structuredClone(aliasResponse),
            };
          throw Error("Synthetic offline receipt transport");
        },
        { url: urlB },
      );
      const intentReply = Promise.withResolvers(),
        deliverReply = Promise.withResolvers(),
        announcements = [];
      const pageListeners = [];
      const tabs = [
        { id: 1, url: urlA, active: true },
        { id: 2, url: urlB, active: false },
      ];
      const worker = h.context;
      worker.chrome.tabs.query = async () => tabs;
      worker.chrome.tabs.get = async (id) => tabs.find((tab) => tab.id === id);
      worker.chrome.tabs.sendMessage = async (id, message) => {
        announcements.push({ id, type: message.type });
        if (message.type === "jobs:document-check")
          return { active: true, url: urlB };
        if (id === 2)
          for (const listener of pageListeners)
            listener(message, { id: "ours" }, () => {});
        return { ok: true };
      };
      worker.JobsTabProfiles = {
        verify: async () => ({
          id: "synthetic-profile",
          profileName: "Synthetic",
        }),
      };
      vm.runInContext(submissionCode, worker);
      const w = new JSDOM(
        '<form><button type="button" id="submit">Submit</button></form>',
        { url: urlB, runScripts: "outside-only" },
      ).window;
      Object.defineProperty(w.crypto, "subtle", { value: webcrypto.subtle });
      w.TextEncoder = TextEncoder;
      w.setInterval = () => 1;
      w.clearInterval = () => {};
      const send = (message, sender) =>
        new Promise((reply, reject) => {
          if (
            !h.listeners.some(
              (listener) => listener(message, sender, reply) === true,
            )
          )
            reject(Error("No worker handler " + message.type));
        });
      const sender = {
        id: "ours",
        tab: { id: 2, title: "Synthetic role" },
        frameId: 0,
        url: urlB,
        documentId: "synthetic-active-document",
      };
      w.chrome = {
        runtime: {
          id: "ours",
          onMessage: { addListener: (fn) => pageListeners.push(fn) },
          sendMessage: async (message) => {
            const reply = await send(message, sender);
            if (
              message.type === "jobs:queue-page" &&
              message.data.type === "intent"
            ) {
              intentReply.resolve(reply);
              // Simulate an in-flight Chrome reply. Page remains in its actual await,
              // before navigationPermit and before the first native click dispatch.
              await deliverReply.promise;
            }
            return reply;
          },
        },
      };
      w.eval(pageCode);
      let clicks = 0;
      const button = w.document.getElementById("submit");
      button.onclick = () => clicks++;
      let attempted;
      try {
        await w.JobsQueuePage.ready;
        attempted = w.JobsQueuePage.beforeNavigate(
          "submit",
          w.document.querySelector("form"),
          button,
        ).then(
          () => ({ clicked: w.JobsQueuePage.clickNavigate("submit", button) }),
          (error) => ({ error: error.message }),
        );
        const authorization = await intentReply.promise;
        assert.equal(authorization.data.allowed, true);
        assert.equal(
          Object.values(h.local.jobsSubmissionGuardsV1)[0].state,
          "prepared",
        );
        assert.equal(clicks, 0);
        const deletion = await send(
          {
            type: "jobs:job-action",
            action: "delete",
            url: urlA,
            tabId: 1,
            detail: "Synthetic owner deletion",
          },
          { id: "ours", url: "chrome-extension://ours/popup.html" },
        );
        assert.equal(deletion.state, "pending");
        assert.equal(
          await worker.JobsSync.removalPending(urlB, aliasKeys),
          true,
        );
        assert.equal(
          clicks,
          0,
          "no click had occurred when deletion completed",
        );
        const cancellationReached = announcements.some(
          (item) => item.id === 2 && item.type === "jobs:queue-control",
        );
        deliverReply.resolve();
        const outcome = await attempted;
        assert.equal(cancellationReached, true);
        assert.match(outcome.error, /暂停|变化|停止|移除/);
        assert.equal(
          clicks,
          0,
          "deletion completed before DOM click but page still submitted",
        );
      } finally {
        deliverReply.resolve();
        if (attempted) await attempted;
        w.close();
      }
    },
  );
