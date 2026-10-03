import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
const read = (name) =>
  readModule(new URL("../src/custom/" + name + ".js", import.meta.url), "utf8");
const [rules, matchRules, match, content, sync] = await Promise.all(
  [
    "availability-rules",
    "job-match-rules",
    "job-match",
    "job-availability",
    "sync",
  ].map(read),
);
const url =
  "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Test/Engineer_R123";
const quote = "The page you are looking for doesn't exist.";
const id = "ccohapahbamkcbgkpegidkpknoeikiko";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function page(html, href = url) {
  const dom = new JSDOM(html, {
    url: href,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = () => [{ width: 300, height: 40 }];
  const sent = [],
    views = [];
  let now = 0,
    listener;
  const timers = new Map();
  let seq = 0;
  w.Date.now = () => now;
  w.setTimeout = (fn, ms) => {
    timers.set(++seq, { fn, at: now + ms });
    return seq;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.chrome = {
    runtime: {
      id,
      onMessage: { addListener: (fn) => (listener = fn) },
      sendMessage: async (msg) => {
        sent.push(msg);
        return { state: "pending", event_id: "test-event" };
      },
    },
  };
  for (const source of [rules, matchRules, match, content]) w.eval(source);
  w.JobsAvailability?.attach((data) => views.push(data));
  return {
    dom,
    w,
    sent,
    views,
    reply: (data) =>
      listener({ type: "jobs:availability-result", url, data }, { id }),
    advance: async (ms) => {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          await t.fn();
        }
      await tick();
    },
  };
}

test("visible stable terminal page reports once; hidden text, network and login errors do not", async () => {
  for (const html of [
    "<p>Sign in to apply</p>",
    "<p>Something went wrong</p>",
    "<p>No jobs match your search.</p>",
    `<p hidden>${quote}</p>`,
    `<div style="display:none"><p>${quote}</p></div>`,
    `<textarea>${quote}</textarea>`,
    `<p>Example: ${quote}</p>`,
  ]) {
    const h = page(html);
    assert.equal(h.w.JobsAvailability.detect(), null);
    await h.advance(2000);
    assert.equal(h.sent.length, 0);
    h.dom.window.close();
  }
  const h = page(`<h2>${quote}</h2>`);
  assert.equal(h.sent.length, 0);
  await h.advance(1600);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].code, "page_missing");
  assert.equal(h.views.at(-1).canRestore, false);
  h.reply({
    state: "removed",
    event_id: "test-event",
    title: "Engineer",
    company: "Acme",
    expires_at: Date.now() / 1000 + 86400,
  });
  assert(h.views.at(-1).message.includes("已从列表移除"));
  assert.equal(h.views.at(-1).canRestore, true);
  h.w.document.querySelector("h2").className = "changed";
  await tick();
  await h.advance(2000);
  assert.equal(h.sent.length, 1);
  h.dom.window.close();
});

test("transient error and non-ATS text never generate deletion", async () => {
  const h = page(`<p>${quote}</p>`);
  h.w.document.querySelector("p").textContent = "Job description";
  await tick();
  await h.advance(2000);
  assert.equal(h.sent.length, 0);
  h.dom.window.close();
  const other = page(`<p>${quote}</p>`, "https://example.org/article");
  await other.advance(2000);
  assert.equal(other.sent.length, 0);
  other.dom.window.close();
});

function background(initial, respond) {
  let storage = structuredClone(
      initial || {
        jobsSyncV1: { deviceId: "device", token: "a".repeat(64), outbox: [] },
      },
    ),
    listener;
  const requests = [],
    announced = [];
  const chrome = {
    runtime: {
      id,
      getURL: (path) => "chrome-extension://" + id + "/" + path,
      onMessage: { addListener: (fn) => (listener = fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        get: async () => structuredClone(storage),
        set: async (value) => Object.assign(storage, structuredClone(value)),
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      get: async (tabId) => ({
        id: tabId,
        url: url + "?token=private",
        active: true,
      }),
      query: async () => [],
      sendMessage: async (tab, msg) => announced.push(msg),
      onCreated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const context = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    chrome,
    JobsQueueBackground: {
      remove: async (url) => announced.push({ type: "stopped", url }),
    },
    URL,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    AbortSignal,
    Date,
    console,
    fetch: async (path, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return respond
        ? respond(body)
        : {
            ok: true,
            status: 200,
            json: async () => ({
              event_id: body.event_id,
              state: body.proof === "undo_unavailable" ? "restored" : "removed",
              expires_at: Date.now() / 1000 + 86400,
            }),
          };
    },
  });
  for (const source of [rules, matchRules, match, sync])
    vm.runInContext(source, context);
  const sender = {
    id,
    frameId: 0,
    url: url + "?token=private",
    tab: { id: 12 },
  };
  const message = (msg, from = sender) =>
    new Promise((resolve) =>
      listener({ url: sender.url, ...msg }, from, resolve),
    );
  return {
    api: context.JobsSync,
    message,
    requests,
    announced,
    storage: () => structuredClone(storage),
  };
}
const observe = {
  type: "jobs:availability-observe",
  code: "page_missing",
  quote,
};

const popupSender = { id, url: "chrome-extension://" + id + "/popup.html" };
const jobAction = (action) => ({
  type: "jobs:job-action",
  action,
  tabId: 12,
  ...(action === "delete" ? { detail: "岗位方向不匹配" } : {}),
});
test("popup deletes current URL without page injection and shares durable undo with passive removals", async () => {
  const h = background();
  assert.equal(
    (await h.message(jobAction("status"), popupSender)).state,
    "ready",
  );
  const pending = await h.message(jobAction("delete"), popupSender);
  assert.equal(pending.state, "pending");
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].proof, "manual_remove");
  assert.equal(h.requests[0].job_url, url);
  assert.equal(h.requests[0].detail, "岗位方向不匹配");
  assert.equal(
    (await h.message(jobAction("status"), popupSender)).removal_detail,
    "岗位方向不匹配",
  );
  assert.equal(
    h.announced.filter((m) => m.type !== "stopped").length,
    0,
    "manual action must not open the page toast",
  );
  assert.equal(
    (await h.message(jobAction("delete"), popupSender)).state,
    "removed",
  );
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(
    (
      await h.message(
        { ...jobAction("restore"), eventId: pending.event_id },
        popupSender,
      )
    ).state,
    "restoring",
  );
  await h.api.flush();
  assert.equal(
    (await h.message(jobAction("status"), popupSender)).state,
    "restored",
  );
  await h.message(jobAction("delete"), popupSender);
  await h.api.flush();
  assert.equal(h.requests.length, 3);
  assert.notEqual(h.requests[2].event_id, pending.event_id);
});

test("popup refuses stale or forged targets; manual deletion survives offline restart", async () => {
  const h = background(undefined, () => {
    throw Error("offline");
  });
  for (const detail of [undefined, "   ", "x".repeat(501)])
    assert(
      (await h.message({ ...jobAction("delete"), detail }, popupSender)).error,
    );
  for (const [msg, sender] of [
    [{ ...jobAction("delete"), url: url.replace("R123", "R999") }, popupSender],
    [
      jobAction("delete"),
      { ...popupSender, url: "chrome-extension://" + id + "/options.html" },
    ],
    [
      jobAction("delete"),
      { id, url: url + "?token=private", tab: { id: 12 }, frameId: 0 },
    ],
  ])
    assert((await h.message(msg, sender)).error);
  assert.equal(h.requests.length, 0);
  const pending = await h.message(jobAction("delete"), popupSender);
  await h.api.flush();
  assert.equal(
    (await h.message(jobAction("status"), popupSender)).state,
    "pending",
  );
  const saved = h.storage();
  saved.jobsSyncV1.outbox[0].next = 0;
  const restarted = background(saved);
  await restarted.api.flush();
  assert.equal(restarted.requests[0].event_id, pending.event_id);
  assert.equal(restarted.requests[0].detail, "岗位方向不匹配");
  assert.equal(
    (await restarted.message(jobAction("status"), popupSender)).state,
    "removed",
  );
});

test("same receipt channel persists removal, returns actual ack and undoes once without leaking query data", async () => {
  const h = background();
  const pending = await h.message(observe);
  assert.equal(pending.state, "pending");
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].proof, "ats_unavailable");
  assert.equal(h.requests[0].job_url, url);
  const removed = await h.message(observe);
  assert.equal(removed.state, "removed");
  await h.api.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.announced.at(-1).data.state, "removed");
  const restoring = await h.message({
    type: "jobs:availability-restore",
    eventId: pending.event_id,
  });
  assert.equal(restoring.state, "restoring");
  await h.api.flush();
  assert.equal(h.requests[1].proof, "undo_unavailable");
  assert.equal(h.requests[1].removal_event, pending.event_id);
  assert.equal((await h.message(observe)).state, "restored");
  await h.api.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.storage().jobsSyncV1.outbox.length, 0);
});

test("offline receipt survives worker restart with unchanged ID and never announces removal early", async () => {
  const h = background(undefined, () => {
    throw Error("offline");
  });
  await h.message(observe);
  await h.api.flush();
  const state = h.storage();
  assert.equal(state.jobsSyncV1.outbox.length, 1);
  assert.equal(h.announced.length, 0);
  assert.equal((await h.message(observe)).state, "pending");
  const event = state.jobsSyncV1.outbox[0].payload.event_id;
  state.jobsSyncV1.outbox[0].next = 0;
  const restarted = background(state);
  await restarted.api.flush();
  assert.equal(restarted.requests[0].event_id, event);
  assert.equal(restarted.storage().jobsSyncV1.outbox.length, 0);
});

test("foreign senders, subframes, stale page URLs and arbitrary errors cannot enqueue removals", async () => {
  const h = background();
  for (const sender of [
    { id: "foreign", frameId: 0, url, tab: { id: 12 } },
    { id, frameId: 1, url, tab: { id: 12 } },
    { id, frameId: 0, url: "https://other.test", tab: { id: 12 } },
  ])
    assert((await h.message({ ...observe, url }, sender)).error);
  assert((await h.message({ ...observe, quote: "Network error" })).error);
  assert.equal(h.requests.length, 0);
});

test("native status presents removal text literally with accessible restore and dismiss controls", async () => {
  const shell = await readModule(
    new URL("../source/content/shell.js", import.meta.url),
    "utf8",
  );
  const w = new JSDOM("<body/>", { url, runScripts: "outside-only" }).window;
  let shadow,
    restored = 0,
    dismissed = 0;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) {
    shadow = attach.call(this, options);
    return shadow;
  };
  w.eval(shell);
  const presenter = w.statusPresenter({ onInvalidated() {} });
  presenter.availability({
    message: "岗位已失效 <script>private</script>",
    canRestore: true,
    onRestore: () => {
      restored++;
    },
    onDismiss: () => {
      dismissed++;
    },
  });
  assert(shadow.textContent.includes("<script>private</script>"));
  assert(!shadow.querySelector("script"));
  const buttons = [...shadow.querySelectorAll("button")];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["恢复", "关闭"],
  );
  buttons[0].click();
  buttons[1].click();
  assert.equal(restored, 1);
  assert.equal(dismissed, 1);
  assert(!w.document.querySelector("[data-jobs-ui]"));
  w.close();
});

test("pending owner removal gates the posting across worker restart and undo clears only its durable gate", async () => {
  const h = background(undefined, () => {
    throw Error("offline");
  });
  await h.message(jobAction("delete"), popupSender);
  assert.equal(await h.api.removalPending(url), true);
  assert.equal(await h.api.removalPending(url.replace("R123", "R999")), false);
  assert.equal(h.announced[0].type, "stopped");
  const saved = h.storage();
  saved.jobsSyncV1.outbox[0].next = 0;
  const next = background(saved);
  assert.equal(await next.api.removalPending(url), true);
  await next.api.flush();
  const removed = await next.message(jobAction("status"), popupSender);
  await next.message(
    { ...jobAction("restore"), eventId: removed.event_id },
    popupSender,
  );
  await next.api.flush();
  assert.equal(await next.api.removalPending(url), false);
});

test("old protected deletion becomes actionable only when fresh service eligibility permits it", async () => {
  const h = background(undefined, (body) => ({
    ok: true,
    status: 200,
    json: async () =>
      body.proof
        ? { event_id: body.event_id, state: "protected" }
        : { removal: { allowed: true, removed: false } },
  }));
  await h.message(jobAction("delete"), popupSender);
  await h.api.flush();
  assert.equal(
    (await h.message(jobAction("status"), popupSender)).state,
    "ready",
  );
  assert.equal(
    await h.api.removalPending(url),
    true,
    "retry permission must not resume the page",
  );
});
