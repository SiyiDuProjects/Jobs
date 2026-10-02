import { readModule } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { JSDOM } from "jsdom";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
const source = await readModule(
  new URL("../src/custom/diagnostics-background.js", import.meta.url),
  "utf8",
);
function harness() {
  const data = {},
    listeners = [],
    calls = [];
  let response;
  const chrome = {
    runtime: {
      id: "test",
      getURL: (path) => "chrome-extension://test/" + path,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      session: {
        getKeys: async () => Object.keys(data),
        get: async (key) =>
          key == null
            ? structuredClone(data)
            : { [key]: structuredClone(data[key]) },
        remove: async (keys) => {
          for (const key of keys) delete data[key];
        },
        set: async (value) => Object.assign(data, structuredClone(value)),
      },
    },
    tabs: {
      sendMessage: async (...args) => {
        calls.push(args);
        return response;
      },
    },
  };
  const context = vm.createContext({
    chrome,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
  });
  vm.runInContext(source, context);
  const send = (
    msg,
    sender = { id: "test", url: chrome.runtime.getURL("diagnostics.html") },
  ) => new Promise((resolve) => listeners[0](msg, sender, resolve));
  return {
    data,
    context,
    send,
    calls,
    respond: (value) => {
      response = value;
    },
  };
}
function report() {
  return {
    schemaVersion: 2,
    sessionId: randomUUID(),
    valuePolicy: "values_omitted",
    verdict: "observation_only",
    pageUrl: "https://jobs.ashbyhq.com/example/job",
    fields: [],
    events: [],
    observedAt: Date.now(),
  };
}
test("current page diagnostics reach the private archive; obsolete and unknown versions are rejected", async () => {
  const h = harness(),
    dom = new JSDOM(
      '<form aria-labelledby="job-application-form"><label>Summary<input required></label></form>',
      {
        url: "https://jobs.ashbyhq.com/example/job",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  try {
    w.TextEncoder = TextEncoder;
    w.chrome = {
      runtime: {
        id: "test",
        getManifest: () => ({ version: "1.0.0" }),
        sendMessage: async () => ({}),
        onMessage: { addListener() {} },
      },
    };
    for (const name of ["control-fields", "diagnostics"])
      w.eval(
        await readWithDependencies(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        ),
      );
    const runId = randomUUID();
    w.JobsDiagnostics.start("ashby", {
      pageSession: {
        documentId: randomUUID(),
        runId,
        startedAt: Date.now(),
        phase: "in-progress",
        profileName: "Fixture",
      },
    });
    const value = w.JobsDiagnostics.snapshot(),
      sender = {
        id: "test",
        tab: { id: 5 },
        frameId: 0,
        documentId: "chrome-document",
        url: w.location.href,
      };
    assert.equal(value.schemaVersion, 2);
    assert.equal(
      (await h.send({ type: "jobs:diagnostics-push", report: value }, sender))
        .data.ok,
      true,
    );
    const record = Object.values(h.data.jobsDiagnosticsV1.reports)[0];
    assert.equal(record.report.runId, runId);
    assert(record.report.fields.length > 0);
    for (const schemaVersion of [1, 3])
      assert.match(
        (
          await h.send(
            {
              type: "jobs:diagnostics-push",
              report: { ...value, schemaVersion },
            },
            sender,
          )
        ).error,
        /Invalid diagnostic report/,
      );
  } finally {
    w.JobsDiagnostics?.stop();
    w.JobsControlFields?.dispose();
    w.close();
  }
});
test("local trace archive is private, preserves concurrent pages and never returns a command", async () => {
  const h = harness(),
    reports = Array.from({ length: 17 }, report);
  await Promise.all(
    reports.map((value, i) =>
      h.send(
        { type: "jobs:diagnostics-push", report: value },
        {
          id: "test",
          tab: { id: i },
          frameId: 0,
          documentId: "doc-" + i,
          url: value.pageUrl,
        },
      ),
    ),
  );
  const result = await h.send({ type: "jobs:diagnostics-list" });
  assert.equal(result.data.reports.length, 17);
  assert(!JSON.stringify(result).includes("commands"));
  assert.match(
    (
      await h.send(
        { type: "jobs:diagnostics-list" },
        { id: "test", url: "https://jobs.siyidu.com", tab: { id: 1 } },
      )
    ).error,
    /Private/,
  );
  assert.match(
    (
      await h.send(
        { type: "jobs:diagnostics-push", report: report() },
        {
          id: "other",
          url: "https://jobs.ashbyhq.com",
          tab: { id: 1 },
          frameId: 0,
        },
      )
    ).error,
    /Invalid/,
  );
});
test("manual reproduction capture targets the recorded document and passes the session guard", async () => {
  const h = harness(),
    value = report();
  await h.send(
    { type: "jobs:diagnostics-push", report: value },
    {
      id: "test",
      tab: { id: 8 },
      frameId: 0,
      documentId: "doc-8",
      url: value.pageUrl,
    },
  );
  const id = (await h.send({ type: "jobs:diagnostics-list" })).data.reports[0]
    .id;
  h.respond({ data: { captured: true, fields: 1 } });
  assert.equal(
    (await h.send({ type: "jobs:diagnostics-capture-case", id })).data.captured,
    true,
  );
  const [tab, message, options] = h.calls[0];
  assert.equal(tab, 8);
  assert.equal(message.type, "jobs:repro-capture");
  assert.equal(message.sessionId, value.sessionId);
  assert.equal(options.documentId, "doc-8");
  h.respond({ error: "页面已切换" });
  assert.match(
    (await h.send({ type: "jobs:diagnostics-capture-case", id })).error,
    /切换/,
  );
});
test("read-only refresh rejects replacement documents and retains the previous trace", async () => {
  const h = harness(),
    value = report();
  await h.send(
    { type: "jobs:diagnostics-push", report: value },
    {
      id: "test",
      tab: { id: 8 },
      frameId: 0,
      documentId: "doc-8",
      url: value.pageUrl,
    },
  );
  const id = (await h.send({ type: "jobs:diagnostics-list" })).data.reports[0]
    .id;
  h.respond({ data: report() });
  assert.match(
    (await h.send({ type: "jobs:diagnostics-refresh", id })).error,
    /切换/,
  );
  assert.equal(
    (await h.send({ type: "jobs:diagnostics-get", id })).data.report.sessionId,
    value.sessionId,
  );
  h.respond({ data: { ...value, phase: "complete-required" } });
  assert.equal(
    (await h.send({ type: "jobs:diagnostics-refresh", id })).data.report.phase,
    "complete-required",
  );
});

test("connection change during refresh cannot restore a private report", async () => {
  const h = harness(),
    value = report();
  await h.send(
    { type: "jobs:diagnostics-push", report: value },
    {
      id: "test",
      tab: { id: 8 },
      frameId: 0,
      documentId: "doc-8",
      url: value.pageUrl,
    },
  );
  const id = (await h.send({ type: "jobs:diagnostics-list" })).data.reports[0]
    .id;
  const late = Promise.withResolvers();
  h.respond(late.promise);
  const task = h.send({ type: "jobs:diagnostics-refresh", id });
  while (!h.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await h.context.JobsPrivateSession.clear();
  late.resolve({
    data: { ...value, fields: [{ value: "OLD_PRIVATE_VALUE" }] },
  });
  assert.match((await task).error, /连接已改变/);
  assert.equal(h.data.jobsDiagnosticsV1, undefined);
});

test("closing the page discards raw traces and rejects a refresh already in flight", async () => {
  const h = harness(),
    value = report();
  await h.send(
    { type: "jobs:diagnostics-push", report: value },
    {
      id: "test",
      tab: { id: 8 },
      frameId: 0,
      documentId: "doc-8",
      url: value.pageUrl,
    },
  );
  const id = (await h.send({ type: "jobs:diagnostics-list" })).data.reports[0]
    .id;
  const late = Promise.withResolvers();
  h.respond(late.promise);
  const task = h.send({ type: "jobs:diagnostics-refresh", id });
  while (!h.calls.length) await new Promise((resolve) => setImmediate(resolve));
  await h.context.JobsDiagnosticsBackground.releasePage(8, "doc-8");
  late.resolve({
    data: { ...value, fields: [{ value: "OLD_PRIVATE_VALUE" }] },
  });
  assert.match((await task).error, /页面已离开/);
  assert.equal(Object.keys(h.data.jobsDiagnosticsV1.reports).length, 0);
});
