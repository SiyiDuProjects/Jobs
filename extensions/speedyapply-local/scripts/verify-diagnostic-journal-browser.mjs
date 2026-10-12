// Isolated real-browser evidence transport test. Synthetic pages and storage only.
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const local = {},
  session = {};
const area = (data) => ({
  getKeys: async () => Object.keys(data),
  get: async (keys) =>
    Object.fromEntries([keys].flat().map((k) => [k, structuredClone(data[k])])),
  set: async (values) => Object.assign(data, structuredClone(values)),
  remove: async (keys) => [keys].flat().forEach((k) => delete data[k]),
});
const worker = vm.createContext({
  URL,
  TextEncoder,
  console,
  crypto: webcrypto,
  JobsBuildInfo: { id: "1234567890abcdef" },
  chrome: { storage: { local: area(local), session: area(session) } },
});
const custom = new URL("../src/custom/", import.meta.url);
vm.runInContext(
  await readWithDependencies(
    new URL("event-log-background.js", custom),
    "utf8",
  ),
  worker,
);
const source = (
  await Promise.all(
    ["control-fields", "diagnostics"].map((n) =>
      readWithDependencies(new URL(n + ".js", custom), "utf8"),
    ),
  )
).join("\n");
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
try {
  const context = await browser.newContext();
  await context.route("**/*", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<form data-automation-id="myExperiencePage"><label>Skills<input id="skills"></label><button type="button">Continue</button></form>',
    }),
  );
  await context.exposeFunction("captureDiagnostic", async (report) => {
    await worker.JobsEventLog.capture(report);
    return { ok: true };
  });
  const errors = [];
  for (let n = 1; n <= 2; n++) {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `https://fixture.wd1.myworkdayjobs.com/job/Role_R${n}/apply`,
    );
    await page.evaluate(() => {
      globalThis.JobsBuildInfo = { id: "1234567890abcdef" };
      globalThis.chrome = {
        runtime: {
          getManifest: () => ({ version: "fixture" }),
          onMessage: { addListener() {} },
          sendMessage: async (message) =>
            ["jobs:diagnostics-push", "jobs:event-log"].includes(message.type)
              ? captureDiagnostic(message.report)
              : {},
        },
      };
    });
    await page.addScriptTag({ content: source });
    await page.evaluate((n) => {
      const d = crypto.randomUUID(),
        run = crypto.randomUUID();
      JobsDiagnostics.start("workday", {
        pageSession: {
          documentId: d,
          runId: run,
          startedAt: Date.now(),
          phase: "in-progress",
          profileName: "Fixture",
        },
      });
      const node = document.querySelector("#skills");
      for (let i = 0; i < 80; i++) {
        JobsDiagnostics.evidence(node, {
          stage: "item",
          operation: 1,
          item: i,
          total: 80,
          result: "started",
        });
        JobsDiagnostics.trace(node, {
          source: "profile",
          topic: "skill",
          answer: `PRIVATE_${n}_${i}`,
          chosen: i ? `PRIVATE_${n}_${i}` : "",
          result: i ? "committed" : "no-options",
        });
        JobsDiagnostics.evidence(node, {
          stage: "item",
          operation: 1,
          item: i,
          total: 80,
          result: i ? "committed" : "failed",
          ...(!i ? { reason: "not_committed" } : {}),
        });
      }
      JobsDiagnostics.evidence(null, {
        stage: "guard",
        reason: "user_input",
        result: "blocked",
      });
      JobsDiagnostics.finishRun();
    }, n);
    await page.locator("#skills").focus();
    await page.locator("button").focus();
    await page.waitForFunction(
      () => JobsDiagnostics.snapshot().recording.pending === 0,
    );
  }
  assert.deepEqual(errors, []);
  const pending = await worker.JobsEventLog.pending(495000);
  assert.equal(pending.items.length, 2);
  for (const run of pending.items) {
    assert.equal(run.events.filter((e) => e.type === "fill_trace").length, 80);
    assert.equal(
      run.events.find((e) => e.type === "fill_trace").trace.result,
      "no-options",
    );
    assert(run.events.some((e) => e.evidence?.reason === "user_input"));
    assert(!JSON.stringify(run).includes("PRIVATE_"));
    const seq = run.events.filter((e) => e.sequence).map((e) => e.sequence);
    assert.equal(seq.length, new Set(seq).size);
  }
  await fs.writeFile(
    "/private/tmp/jobs-diagnostic-browser-packets.json",
    JSON.stringify({ protocolVersion: 1, history: pending.items }),
  );
  console.log(
    JSON.stringify({
      verified: true,
      pages: 2,
      perPageChoices: 80,
      failuresRetained: true,
      redacted: true,
      events: pending.items.map((r) => r.events.length),
      errors,
    }),
  );
} finally {
  await browser.close();
}
