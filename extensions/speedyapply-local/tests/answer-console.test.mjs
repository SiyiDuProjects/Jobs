import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
import { nativePackage } from "./helpers/native-package.mjs";
import {
  choosePage,
  consoleSummary,
  filterOptions,
  keyIndex,
  nextQuestion,
  optionKey,
  orderPages,
  pageGroup,
} from "../src/custom/console-model.js";
import { createConsoleController } from "../src/custom/console-controller.js";
import { JobsBrand } from "../src/custom/brand.js";

const editor = (extra = {}) => ({
  kind: "buttons",
  options: [
    { value: "Yes", label: "Yes" },
    { value: "No", label: "No" },
  ],
  value: null,
  version: 1,
  valid: false,
  disabled: false,
  ...extra,
});
const reviewRow = (tabId, items, extra = {}) => ({
  tabId,
  windowId: 1,
  index: tabId,
  url: "https://fixture.test/" + tabId,
  status: { id: "s" + tabId, text: "等待审核", phase: "ai-review" },
  reviewPending: true,
  review: { id: "r" + tabId, documentId: "d" + tabId, data: { items } },
  ...extra,
});
const statusRow = (tabId, phase) => ({
  tabId,
  windowId: 1,
  index: tabId,
  url: "https://fixture.test/" + tabId,
  status: { id: "s" + tabId, text: phase, phase, canFill: true },
  review: null,
  reviewPending: false,
});

test("pages are grouped by what the person must do and ordered by urgency", () => {
  const rows = [
    statusRow(1, "confirmed"),
    statusRow(2, "in-progress"),
    statusRow(3, "complete-required"),
    reviewRow(4, [{ id: "0", reviewState: "pending", editor: editor() }]),
    statusRow(5, "page-complete"),
    statusRow(6, "stopped-user_input"),
    statusRow(7, "idle"),
    { ...statusRow(8, "ai-review"), reviewPending: true },
  ];
  assert.deepEqual(rows.map(pageGroup), [
    "done",
    "busy",
    "attention",
    "review",
    "ready",
    "attention",
    "idle",
    "review",
  ]);
  assert.deepEqual(
    orderPages(rows).map((row) => row.tabId),
    [4, 8, 3, 6, 5, 2, 7, 1],
  );
  assert.deepEqual(consoleSummary(rows), {
    pages: 2,
    questions: 1,
    attention: 2,
    done: 1,
    busy: 1,
    total: 8,
  });
});

test("question navigation includes read-only drafts and skips settled rows", () => {
  const row = reviewRow(1, [
    { id: "0", reviewState: "ready", editor: editor() },
    { id: "1", reviewState: "pending", editor: editor() },
    { id: "summary-0", reviewState: "pending" },
    { id: "2", reviewState: "pending", editor: editor() },
  ]);
  assert.equal(nextQuestion(row, null).id, "1");
  assert.equal(nextQuestion(row, "1").id, "summary-0");
  assert.equal(nextQuestion(row, "summary-0").id, "2");
  assert.equal(nextQuestion(row, "2").id, "1");
  const last = reviewRow(2, [
    { id: "0", reviewState: "pending", editor: editor() },
  ]);
  assert.equal(nextQuestion(last, "0"), null, "the answered last item ends");
  assert.equal(nextQuestion(reviewRow(3, []), null), null);
});

test("overlapping refreshes share a read; an event storm cannot start concurrent snapshots", async () => {
  let resolveRead;
  const api = fakeApi(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const controller = createConsoleController(api, () => {});
  const first = controller.start();
  const second = controller.refresh();
  assert.equal(api.sent.length, 1);
  resolveRead({ data: { tabs: [] } });
  await Promise.all([first, second]);
  controller.dispose();
});

test("duplicate answer gestures send once and transport errors remain visible", async () => {
  let finish;
  const api = fakeApi(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = createConsoleController(api, () => {});
  const row = reviewRow(4, []),
    payload = { version: 1, value: "No" };
  const first = controller.act(row, "answer", "0", payload);
  const second = controller.act(row, "answer", "0", payload);
  assert.equal(api.sent.length, 1);
  finish({ ok: true });
  await Promise.all([first, second]);
  controller.dispose();
  const broken = createConsoleController(
    fakeApi(() => {
      throw Error("Tab closed");
    }),
    () => {},
  );
  assert.match(
    (await broken.act(row, "answer", "0", payload)).error,
    /Tab closed/,
  );
  broken.dispose();
});

test("selection stays on a page that needs the person and otherwise moves to the next review", () => {
  const rows = [
    statusRow(1, "awaiting-transition"),
    reviewRow(2, []),
    statusRow(3, "complete-required"),
  ];
  assert.equal(choosePage(rows, 3), 3);
  assert.equal(choosePage(rows, 1), 2, "a confirmed page hands over");
  assert.equal(choosePage(rows, 99), 2);
  assert.equal(choosePage([statusRow(5, "confirmed")], null), 5);
  assert.equal(choosePage([], null), null);
});

test("option shortcuts and filtering", () => {
  assert.deepEqual([0, 8, 9, 10].map(optionKey), ["1", "9", "0", ""]);
  assert.deepEqual(["1", "9", "0", "a"].map(keyIndex), [0, 8, 9, -1]);
  const options = ["United States", "United Kingdom", "Canada"].map(
    (label) => ({ value: label, label }),
  );
  assert.deepEqual(
    filterOptions(options, "united KING").map((option) => option.label),
    ["United Kingdom"],
  );
  assert.equal(filterOptions(options, "  ").length, 3);
});

function fakeApi(reply) {
  const listeners = { message: [], removed: [], updated: [] };
  const sent = [];
  return {
    sent,
    listeners,
    runtime: {
      id: "jobs",
      sendMessage: async (message) => {
        sent.push(message);
        return reply(message);
      },
      onMessage: {
        addListener: (fn) => listeners.message.push(fn),
        removeListener: (fn) =>
          listeners.message.splice(listeners.message.indexOf(fn), 1),
      },
    },
    tabs: {
      onRemoved: {
        addListener: (fn) => listeners.removed.push(fn),
        removeListener() {},
      },
      onUpdated: {
        addListener: (fn) => listeners.updated.push(fn),
        removeListener() {},
      },
    },
  };
}

test("the controller routes answers to the page document that showed them and refreshes on page announcements", async () => {
  const row = reviewRow(4, []);
  let reads = 0;
  const api = fakeApi((message) => {
    if (message.type === "jobs:console-read") {
      reads++;
      return { data: { tabs: [row] } };
    }
    return { ok: true };
  });
  const views = [];
  const controller = createConsoleController(api, (view) => views.push(view));
  await controller.start();
  assert.equal(views.at(-1).rows[0].tabId, 4);
  await controller.act(row, "answer", "0", { value: "No", version: 1 });
  assert.deepEqual(api.sent.at(-1), {
    type: "jobs:review-action",
    tabId: 4,
    id: "r4",
    documentId: "d4",
    action: "answer",
    itemId: "0",
    payload: { value: "No", version: 1 },
  });
  await controller.focus(row, "0");
  assert.deepEqual(api.sent.at(-1), {
    type: "jobs:console-focus",
    tabId: 4,
    itemId: "0",
    reviewId: "r4",
    documentId: "d4",
  });
  await controller.focus(statusRow(5, "complete-required"));
  assert.deepEqual(api.sent.at(-1), { type: "jobs:console-focus", tabId: 5 });
  assert.match(
    (await controller.act(statusRow(6, "idle"), "confirm")).error,
    /没有待确认/,
  );
  assert.match(
    (await controller.prepare({ ...statusRow(7, "idle"), status: null })).error,
    /不能准备/,
  );
  const before = reads;
  api.listeners.message[0](
    { type: "jobs:panel-changed", tabId: 4 },
    { id: "jobs" },
  );
  api.listeners.message[0]({ type: "jobs:panel-changed" }, { id: "other" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(reads > before);
  controller.dispose();
  assert.equal(api.listeners.message.length, 0);
});

async function worker({ tabs, session = {}, operator = "person" }) {
  const sent = [],
    focused = [],
    created = [],
    handlers = {};
  const source = await readModule(
    new URL("../src/custom/console-background.js", import.meta.url),
    "utf8",
  );
  const panelState = await readModule(
    new URL("../src/custom/panel-state.js", import.meta.url),
    "utf8",
  );
  const chrome = {
    runtime: {
      id: "jobs",
      getURL: (path) => "chrome-extension://jobs/" + path,
      onMessage: { addListener: (fn) => (handlers.message = fn) },
      sendMessage: async () => {},
    },
    commands: { onCommand: { addListener: (fn) => (handlers.command = fn) } },
    storage: {
      session: {
        get: async (keys) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in session)
              .map((key) => [key, session[key]]),
          ),
      },
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((tab) => tab.id === id),
      update: async (id, change) => focused.push(["tab", id, change]),
      create: async (value) => {
        created.push(value);
        return { id: 99 };
      },
      sendMessage: async (tabId, message, target) => {
        sent.push([tabId, message, target]);
        if (message.type === "jobs:review-read")
          return { data: { id: message.id, items: [{ id: "0" }] } };
        return { ok: true };
      },
    },
    windows: {
      update: async (id, change) => focused.push(["window", id, change]),
    },
  };
  const context = vm.createContext({
    chrome,
    URL,
    setTimeout,
    clearTimeout,
    readOperator: async () => ({ mode: operator }),
  });
  vm.runInContext(panelState, context);
  vm.runInContext(source, context);
  const message = (value, sender) =>
    new Promise((resolve) => handlers.message(value, sender, resolve));
  return { sent, focused, created, handlers, message, chrome };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const consoleSender = {
  id: "jobs",
  frameId: 0,
  url: "chrome-extension://jobs/console.html",
  tab: { id: 50, windowId: 1 },
};
const panelSender = { id: "jobs", url: "chrome-extension://jobs/popup.html" };
const pageTab = (id, url) => ({ id, windowId: 1, index: id, url, title: "T" });

test("simultaneous console entry gestures create one console tab", async () => {
  const h = await worker({ tabs: [] });
  await Promise.all(
    Array.from({ length: 3 }, () =>
      h.message({ type: "jobs:console-open" }, panelSender),
    ),
  );
  assert.equal(h.created.length, 1);
});

test("the worker lists only live application records and reads review bodies only for the console", async () => {
  const live = "https://fixture.wd1.myworkdayjobs.com/x/job/A_R1/apply";
  const h = await worker({
    tabs: [
      pageTab(1, live),
      pageTab(2, "https://fixture.test/stale"),
      pageTab(3, "https://fixture.test/none"),
      pageTab(4, "chrome-extension://jobs/console.html"),
    ],
    session: {
      "jobsPanel:1:review": { id: "r1", documentId: "d1", url: live },
      "jobsPanel:1:status": {
        id: "s1",
        url: live,
        text: "等待审核",
        phase: "ai-review",
      },
      job_1: { title: "Engineer", description: "long", appUrl: live },
      "jobsPanel:2:status": {
        id: "s2",
        url: "https://fixture.test/old",
        text: "x",
      },
    },
  });
  const full = await h.message({ type: "jobs:console-read" }, consoleSender);
  assert.equal(full.data.tabs.length, 1);
  const [row] = full.data.tabs;
  assert.equal(row.tabId, 1);
  assert.equal(row.jobTitle, "Engineer");
  assert.equal(row.status.phase, "ai-review");
  assert.equal(row.review.data.id, "r1");
  assert.equal(row.description, undefined, "no posting text leaves the worker");
  assert.deepEqual(plain(h.sent[0][2]), { documentId: "d1" });
  const counts = await h.message({ type: "jobs:console-read" }, panelSender);
  assert.equal(counts.data.tabs[0].review, null);
  assert.equal(counts.data.tabs[0].reviewPending, true);
  assert.equal(h.sent.length, 1, "the side panel count reads no answers");
  for (const sender of [
    { id: "other", frameId: 0, url: "chrome-extension://jobs/console.html" },
    { id: "jobs", frameId: 0, url: live, tab: { id: 1 } },
    { id: "jobs", frameId: 2, url: "chrome-extension://jobs/console.html" },
  ])
    assert((await h.message({ type: "jobs:console-read" }, sender)).error);
});

test("focus brings the existing tab forward and locates only a current review", async () => {
  const live = "https://jobs.lever.co/fixture/abc/apply";
  const h = await worker({
    tabs: [pageTab(7, live)],
    session: {
      "jobsPanel:7:review": { id: "r7", documentId: "d7", url: live },
    },
  });
  const located = await h.message(
    {
      type: "jobs:console-focus",
      tabId: 7,
      itemId: "3",
      reviewId: "r7",
      documentId: "d7",
    },
    consoleSender,
  );
  assert.equal(located.data.located, true);
  assert.deepEqual(plain(h.focused), [
    ["window", 1, { focused: true }],
    ["tab", 7, { active: true }],
  ]);
  assert.deepEqual(plain(h.sent.at(-1)), [
    7,
    { type: "jobs:review-command", id: "r7", action: "locate", itemId: "3" },
    { documentId: "d7" },
  ]);
  const stale = await h.message(
    {
      type: "jobs:console-focus",
      tabId: 7,
      itemId: "3",
      reviewId: "old",
      documentId: "d7",
    },
    consoleSender,
  );
  assert.equal(stale.data.located, false);
  assert.match(stale.data.error, /题目已变化/);
  assert.equal(h.sent.length, 1);
  assert(
    (await h.message({ type: "jobs:console-focus", tabId: 7 }, panelSender))
      .error,
  );
});

test("an unresponsive document times out without hiding the other reviews", async () => {
  const tabs = Array.from({ length: 6 }, (_, i) =>
    pageTab(i + 1, `https://fixture.test/job/${i + 1}`),
  );
  const session = Object.fromEntries(
    tabs.map((tab) => [
      `jobsPanel:${tab.id}:review`,
      { id: `r${tab.id}`, documentId: `d${tab.id}`, url: tab.url },
    ]),
  );
  const h = await worker({ tabs, session });
  let active = 0,
    peak = 0;
  h.chrome.tabs.sendMessage = async (id, message) => {
    active++;
    peak = Math.max(peak, active);
    if (id === 1) return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { data: { id: message.id, items: [] } };
  };
  const result = await h.message({ type: "jobs:console-read" }, consoleSender);
  assert.equal(result.data.tabs.length, 6);
  assert.equal(result.data.tabs.filter((row) => row.review).length, 5);
  assert.equal(
    result.data.tabs.find((row) => row.tabId === 1).reviewPending,
    true,
  );
  assert(peak <= 4);
});

test("the console opens once from the side panel, the website bridge or the keyboard command", async () => {
  const h = await worker({ tabs: [] });
  await h.message({ type: "jobs:console-open" }, panelSender);
  assert.deepEqual(plain(h.created), [
    { url: "chrome-extension://jobs/console.html" },
  ]);
  const site = {
    id: "jobs",
    frameId: 0,
    url: JobsBrand.origin + "/#/jobs",
    tab: { id: 3, windowId: 2 },
  };
  await h.message({ type: "jobs:console-open" }, site);
  assert.deepEqual(plain(h.created.at(-1)), {
    url: "chrome-extension://jobs/console.html",
    windowId: 2,
  });
  assert(
    (
      await h.message(
        { type: "jobs:console-open" },
        { ...site, url: "https://evil.test/" },
      )
    ).error,
  );
  const existing = await worker({
    tabs: [
      { ...pageTab(9, "chrome-extension://jobs/console.html"), windowId: 4 },
    ],
  });
  existing.handlers.command("open-console", { windowId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(existing.created.length, 0);
  assert.deepEqual(plain(existing.focused), [
    ["window", 4, { focused: true }],
    ["tab", 9, { active: true }],
  ]);
});

test("the package ships the console page and its keyboard command", async () => {
  const result = await nativePackage();
  const manifest = JSON.parse(
    await fs.readFile(result.stage + "/manifest.json", "utf8"),
  );
  assert.equal(
    manifest.commands["open-console"].suggested_key.default,
    "Alt+Shift+J",
  );
  for (const file of ["console.html", "custom/console.js", "custom/popup.css"])
    await fs.access(result.stage + "/" + file);
});
