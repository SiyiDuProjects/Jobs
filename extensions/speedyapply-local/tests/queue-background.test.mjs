import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await readModule(
  new URL("../src/custom/queue-background.js", import.meta.url),
  "utf8",
);
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
