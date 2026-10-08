import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const source = await readModule(
  new URL("../src/custom/removal-background.js", import.meta.url),
  "utf8",
);
const integrationSource = (
  await Promise.all(
    ["sync"].map((name) =>
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
            type: "jobs:removal-check",
            url,
            final: type !== "check" && extra.action !== "next",
            ...extra,
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
    new URL("../src/custom/submission-guard.js", import.meta.url),
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
            if (message.type === "jobs:submission-prepare") {
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
        attempted = w.JobsSubmissionGuard.beforeNavigate(
          "submit",
          w.document.querySelector("form"),
          button,
        ).then(
          () => ({
            clicked: w.JobsSubmissionGuard.clickNavigate("submit", button),
          }),
          (error) => ({ error: error.message }),
        );
        const authorization = await intentReply.promise;
        assert.ok(authorization.data.id);
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
          (item) => item.id === 2 && item.type === "jobs:job-removed",
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

test("ordinary next uses local removal checks and remains usable during service outage", async () => {
  const h = await integration(async () => {
    throw Error("Service is unavailable");
  });
  const next = await h.send("intent", { action: "next" });
  assert.equal(next.error, undefined);
  assert.equal(h.requests.length, 0);
  const submit = await h.send("intent", { action: "submit" });
  assert.ok(submit.error || submit.data?.removed === true);
  assert.equal(h.requests.length, 1);
});
