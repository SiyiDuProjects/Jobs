import { readModule } from "./helpers/module-source.mjs";
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
      events: [{ at: Date.now(), type: "memory_saved", fieldId: "f1" }],
    },
  };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(message.type);
        return {
          data:
            message.type === "jobs:repro-list"
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
          "jobs:repro-list",
        ].includes(type),
      ),
    );
    assert(w.document.getElementById("export-case").disabled);
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
          "jobs:repro-list": archived
            ? [
                {
                  id: "case-1",
                  at: 1,
                  origin: report.pageUrl,
                  fields: 1,
                  build: "fixture",
                },
              ]
            : [],
          "jobs:repro-get": {
            capturedAt: 123,
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
    assert.equal(calls.find((m) => m.type === "jobs:repro-get").id, "case-1");
    assert.equal(download, "jobs-repro-123.json");
    assert.equal(blob.type, "application/json");
    assert(!calls.some((m) => /fill|command|submit|advance/.test(m.type)));
  } finally {
    dom.window.close();
  }
});
