// Main-thread observation benchmark, isolated Chromium and synthetic form only.
// node scripts/measure-observer-browser.mjs <playwright-core> <chromium> [--capture-baseline]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, "..");
const baseline = path.join(root, ".qa/observer-performance-baseline.js");
const current = (
  await Promise.all(
    [
      "diagnostics",
      "control-fields",
      "operation-context",
      "review-presenter",
      "ai-review",
      "automatic-fill",
    ].map((name) =>
      readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
await fs.mkdir(path.join(root, ".qa"), { recursive: true });
if (process.argv.includes("--capture-baseline"))
  await fs.writeFile(baseline, current, { flag: "wx" });
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
const results = [];
try {
  for (const [version, code] of [
    ["before", await fs.readFile(baseline, "utf8")],
    ["after", current],
  ]) {
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<form aria-labelledby="job-application-form">${Array.from({ length: 120 }, (_, i) => `<label>Question ${i}<input required value="Synthetic answer"></label>`).join("")}<div id="status">Ready</div></form>`,
      }),
    );
    const page = await context.newPage();
    await page.goto("https://jobs.ashbyhq.com/fixture/test/application");
    await page.evaluate(() => {
      globalThis.JobsControlConfig = { enabled: false, observe: true };
      globalThis.chrome = {
        runtime: {
          id: "synthetic",
          getManifest: () => ({ version: "1" }),
          onMessage: { addListener() {} },
          sendMessage: async () => ({}),
        },
      };
    });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      JobsPageSession = { root: () => document.querySelector("form") };
      JobsDiagnostics.start("ashby", {});
      globalThis.flow = JobsAutomatic.observe({
        getProfile: async () => ({}),
        setMessage() {},
        ctx: { onInvalidated() {} },
      });
      flow.setMessage("complete-manually");
    });
    await page.waitForTimeout(350);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    const sample = await page.evaluate(async () => {
      const longTasks = [];
      const observer = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((e) => e.duration)),
      );
      observer.observe({ type: "longtask" });
      const scans = JobsControlFields.scans(),
        structures = JobsControlFields.structuralScans();
      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        const status = document.querySelector("#status");
        status.className = "validation-" + i;
        status.textContent = "Validation status " + i;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      observer.disconnect();
      return {
        elapsedMs: Math.round(performance.now() - start),
        scans: JobsControlFields.scans() - scans,
        structuralScans: JobsControlFields.structuralScans() - structures,
        longTasks: longTasks.length,
        blockingMs: Math.round(
          longTasks.reduce((n, d) => n + Math.max(0, d - 50), 0),
        ),
      };
    });
    const after = (await cdp.send("Performance.getMetrics")).metrics;
    const metric = (list, name) =>
      list.find((m) => m.name === name)?.value || 0;
    results.push({
      version,
      ...sample,
      mainThreadMs: Math.round(
        1000 * (metric(after, "TaskDuration") - metric(before, "TaskDuration")),
      ),
      scriptMs: Math.round(
        1000 *
          (metric(after, "ScriptDuration") - metric(before, "ScriptDuration")),
      ),
    });
    await context.close();
  }
  const evidence = {
    fixture:
      "120 synthetic fields; 60 status/class mutations at 16ms intervals; diagnostics and passive status observers; no autofill or network",
    results,
  };
  await fs.writeFile(
    path.join(root, ".qa/observer-performance.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
