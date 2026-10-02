import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { JobsStorageMigrationPolicy } from "../src/custom/storage-migration-policy.js";
const code = await readModule(
  new URL("../src/custom/migration-ui.js", import.meta.url),
  "utf8",
);
const html = await fs.readFile(
  new URL("../src/migration.html", import.meta.url),
  "utf8",
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, preview) {
  const dom = new JSDOM(html, {
    url: "chrome-extension://fixture/migration.html",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    plan = {
      revision: 3,
      phase: "required_input",
      conflicts: [
        {
          id: "conflict",
          title: "资料有差异",
          detail: "请核对",
          choices: [
            { id: "source:0", label: "使用旧来源", requiresPreview: true },
            {
              id: "preserve",
              label: "保留当前内容和旧备份",
              requiresPreview: false,
            },
          ],
        },
      ],
    };
  w.TextEncoder = TextEncoder;
  w.policy = JobsStorageMigrationPolicy;
  w.JobsBuildInfo = { id: "fixture-build" };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(structuredClone(message));
        if (message.action === "preview")
          return { data: { preview: await preview(message.input) } };
        return { data: { status: { phase: "required_input" }, plan } };
      },
    },
  };
  w.eval(code);
  return { w, calls, doc: w.document };
}
test("private migration choice requires every bounded preview page and displays current/source as text", async (t) => {
  const h = fixture(t, ({ cursor }) =>
    cursor
      ? {
          rows: [
            {
              path: "/second",
              type: "value",
              current: "Current",
              source: "Old",
            },
          ],
          complete: true,
          previewId: "completed-proof",
        }
      : {
          rows: [
            {
              path: "/name",
              type: "value",
              current: "Current name",
              source: "<img src=x onerror=alert(1)>",
            },
          ],
          complete: false,
          nextCursor: "page2",
        },
  );
  await tick();
  const select = h.doc.querySelector("article select"),
    buttons = h.doc.querySelectorAll("article button");
  select.value = "source:0";
  select.dispatchEvent(new h.w.Event("change"));
  assert.equal(buttons[1].disabled, true);
  buttons[0].click();
  await tick();
  assert.equal(buttons[1].disabled, true);
  assert.equal(h.doc.querySelector("article img"), null);
  assert.match(h.doc.querySelector("article").textContent, /Current name/);
  buttons[0].click();
  await tick();
  assert.equal(buttons[1].disabled, false);
  buttons[1].click();
  await tick();
  const resolved = h.calls.find((call) => call.action === "resolve");
  assert.equal(resolved.input.previewId, "completed-proof");
  assert.equal(resolved.input.planRevision, 3);
});
test("incomplete oversized preview cannot authorize a fact choice; preserving the existing source needs no personal read", async (t) => {
  const h = fixture(t, () => ({
    rows: [{ path: "/notes", source: "x".repeat(262145), current: "current" }],
    complete: true,
    previewId: "must-not-use",
  }));
  await tick();
  const select = h.doc.querySelector("article select"),
    [show, confirm] = h.doc.querySelectorAll("article button");
  select.value = "source:0";
  select.dispatchEvent(new h.w.Event("change"));
  show.click();
  await tick();
  assert.equal(confirm.disabled, true);
  assert.match(h.doc.getElementById("status").textContent, /未.*完整|超过/);
  select.value = "preserve";
  select.dispatchEvent(new h.w.Event("change"));
  assert.equal(confirm.disabled, false);
  confirm.click();
  await tick();
  assert.equal(h.calls.filter((call) => call.action === "preview").length, 1);
  assert.equal(
    h.calls.find((call) => call.action === "resolve").input.previewId,
    undefined,
  );
});
