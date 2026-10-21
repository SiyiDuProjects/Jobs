import { readWithDependencies as readModule } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
test("diagnostics viewer renders records as text and refreshes without requesting mutations", async () => {
  const html = await readModule(
      new URL("../src/diagnostics.html", import.meta.url),
      "utf8",
    ),
    code = await readModule(
      new URL("../src/custom/diagnostics-ui.js", import.meta.url),
      "utf8",
    );
  const dom = new JSDOM(html, { runScripts: "outside-only" }),
    w = dom.window,
    calls = [];
  const row = {
    id: "test",
    report: {
      pageUrl: "https://example.com/application",
      profileName: "Intern",
      ats: "ashby",
      version: "local.14",
      observedAt: Date.now(),
      phase: "form",
      counts: { controls: 1, empty: 0, invalid: 0 },
      coverage: { scope: "adapter_form", iframeCount: 0 },
      fields: [
        {
          id: "f1",
          question: "<img src=x onerror=alert(1)>",
          kind: "text",
          status: "value_observed",
          answer: "found",
          attempts: 1,
          observedEvents: ["input"],
        },
      ],
      unansweredContainers: [],
      events: [
        { at: Date.now(), type: "memory_saved", fieldId: "f1" },
        {
          at: Date.now(),
          type: "auto_answer_batch",
          detail: JSON.stringify({
            fieldCount: 3,
            cacheHits: 2,
            modelFields: 1,
            modelCalls: 2,
          }),
        },
        {
          at: Date.now(),
          type: "auto_answer_batch",
          detail: JSON.stringify({ unavailable: true }),
        },
      ],
    },
  };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(message.type);
        return {
          data:
            message.type === "jobs:corpus-failures"
              ? []
              : message.type === "jobs:diagnostics-list"
                ? {
                    sync: { state: "synced" },
                    reports: [
                      {
                        id: "test",
                        tabId: 1,
                        frameId: 0,
                        profileName: "Intern",
                        pageUrl: row.report.pageUrl,
                        receivedAt: 1,
                      },
                    ],
                  }
                : row,
        };
      },
    },
  };
  try {
    await w.eval(code);
    assert.match(w.document.getElementById("overview").textContent, /Intern/);
    assert.match(w.document.getElementById("fields").textContent, /<img/);
    assert.equal(w.document.querySelectorAll("tbody img").length, 0);
    assert.match(
      w.document.getElementById("events").textContent,
      /memory_saved/,
    );
    await w.document.getElementById("inspect").onclick();
    assert(
      calls.every((type) =>
        [
          "jobs:diagnostics-list",
          "jobs:diagnostics-get",
          "jobs:diagnostics-refresh",
          "jobs:corpus-failures",
        ].includes(type),
      ),
    );
    assert(w.document.getElementById("export-case").disabled);
    assert.match(
      w.document.getElementById("events").textContent,
      /缓存命中 2 题 \/ 送模型 1 题 \/ 模型请求 2 次/,
    );
    assert.match(w.document.getElementById("events").textContent, /计数不可用/);
    row.historyUnavailable = true;
    await w.document.getElementById("inspect").onclick();
    assert.match(
      w.document.getElementById("message").textContent,
      /历史记录.*失败/,
    );
    assert.match(w.document.getElementById("fields").textContent, /<img/);
    row.historyUnavailable = false;
    await w.document.getElementById("inspect").onclick();
    assert.match(
      w.document.getElementById("message").textContent,
      /已读取，未填写/,
    );
  } finally {
    dom.window.close();
  }
});
test("diagnostics capture and export use the selected page and stored case without fill commands", async () => {
  const html = await readModule(
      new URL("../src/diagnostics.html", import.meta.url),
      "utf8",
    ),
    code = await readModule(
      new URL("../src/custom/diagnostics-ui.js", import.meta.url),
      "utf8",
    );
  const dom = new JSDOM(html, { runScripts: "outside-only" }),
    w = dom.window,
    calls = [];
  let archived = false,
    download,
    blob;
  const report = {
    pageUrl: "https://fixture.invalid",
    ats: "fixture",
    observedAt: 1,
    counts: { controls: 1, empty: 1, invalid: 0 },
    coverage: { scope: "fixture" },
    fields: [],
    events: [],
    unansweredContainers: [],
  };
  w.chrome = {
    runtime: {
      sendMessage: async (m) => {
        calls.push(m);
        if (m.type === "jobs:diagnostics-capture-case") {
          archived = true;
          return { data: { captured: true, fields: 1 } };
        }
        const responses = {
          "jobs:diagnostics-list": {
            sync: { state: "synced" },
            reports: [{ id: "page-1", pageUrl: report.pageUrl, receivedAt: 1 }],
          },
          "jobs:diagnostics-get": { report },
          "jobs:corpus-failures": archived
            ? [
                {
                  id: "case-1",
                  at: 1,
                  reason: "manual_report",
                  pageId: "corpus-page-1",
                  fieldIds: ["field-1"],
                  fields: 1,
                  build: "fixture",
                },
              ]
            : [],
          "jobs:corpus-failure-page": {
            id: "page-123",
            schemaVersion: 1,
            valuePolicy: "synthetic_fixture",
          },
        };
        return { data: responses[m.type] };
      },
    },
  };
  w.URL.createObjectURL = (value) => {
    blob = value;
    return "blob:fixture";
  };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {
    download = this.download;
  };
  try {
    await w.eval(code);
    await w.document.getElementById("capture-case").onclick();
    assert.equal(
      calls.find((m) => m.type === "jobs:diagnostics-capture-case").id,
      "page-1",
    );
    assert(!w.document.getElementById("export-case").disabled);
    await w.document.getElementById("export-case").onclick();
    assert.equal(
      calls.find((m) => m.type === "jobs:corpus-failure-page").id,
      "case-1",
    );
    assert.equal(download, "jobs-corpus-page-123.json");
    assert.equal(blob.type, "application/json");
    assert(!calls.some((m) => /fill|command|submit|advance/.test(m.type)));
  } finally {
    dom.window.close();
  }
});
