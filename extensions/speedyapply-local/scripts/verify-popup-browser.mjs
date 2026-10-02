// Synthetic UI fixtures in an isolated Chromium profile; no owner's tabs or facts.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildPackage } from "./build.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(root, "../../work/ui-blue-popup");
await fs.mkdir(output, { recursive: true });
const stage = await buildPackage();
const profile = await fs.mkdtemp(path.join(root, ".qa/popup-browser-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.argv[3],
  headless: true,
  args: [
    `--disable-extensions-except=${stage.stage}`,
    `--load-extension=${stage.stage}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
  ],
});
const errors = [];
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.addInitScript(() => {
    const handlers = new Set();
    const event = {
      addListener(fn) {
        handlers.add(fn);
      },
      removeListener(fn) {
        handlers.delete(fn);
      },
    };
    let state = { state: "ready" };
    let kind = "intern";
    globalThis.fixture = {
      sent: [],
      unavailable() {
        state = { error: "当前页面无法识别岗位" };
        handlers.forEach((fn) => fn({ jobsSyncV1: {} }, "local"));
      },
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        tabs: {
          query: async () => [
            {
              id: 12,
              title: "Software Engineering Intern · Example",
              url: "https://fixture.invalid/job/123",
            },
          ],
          onActivated: { addListener() {}, removeListener() {} },
          onUpdated: { addListener() {}, removeListener() {} },
        },
        storage: { onChanged: event },
        runtime: {
          async sendMessage(message) {
            fixture.sent.push(message);
            if (message.type === "jobs:popup-profile") {
              if (message.action === "select") kind = message.kind;
              return {
                data: {
                  available: true,
                  kind,
                  choices: { intern: true, newgrad: true },
                  profileName: kind,
                  source: "manual",
                },
              };
            }
            if (message.action === "delete")
              state = {
                state: "removed",
                removal_detail: message.detail,
                event_id: "fixture-event",
                expires_at: Date.now() / 1000 + 86400,
              };
            if (message.action === "restore") state = { state: "restored" };
            return structuredClone(state);
          },
        },
      },
    });
  });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("radio", { name: "实习 Intern" }).waitFor();
  await popup.getByRole("radio", { name: "全职 Newgrad" }).click();
  await popup.waitForFunction(
    () =>
      document
        .querySelector('[data-kind="newgrad"]')
        .getAttribute("aria-checked") === "true",
  );
  // Exercise the component's native keyboard selection as well as pointer input.
  await popup.getByRole("radio", { name: "全职 Newgrad" }).press("ArrowLeft");
  await popup.keyboard.press("Space");
  await popup.waitForFunction(
    () =>
      document
        .querySelector('[data-kind="intern"]')
        .getAttribute("aria-checked") === "true",
  );
  assert(
    await popup.getByRole("button", { name: "删除当前岗位" }).isDisabled(),
  );
  await popup.getByRole("textbox", { name: "删除原因" }).fill("岗位方向不匹配");
  assert(
    !(await popup.getByRole("button", { name: "删除当前岗位" }).isDisabled()),
  );
  const theme = await popup.evaluate(() => ({
    accent: getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim(),
    selected: getComputedStyle(document.querySelector(".segment__indicator"))
      .backgroundColor,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.match(theme.accent, /^oklch\(0?\.6204 0?\.195 253\.83\)$/);
  assert.equal(theme.overflow, false);
  await popup.locator("main").screenshot({
    path: path.join(output, "popup-job.png"),
  });
  await popup.getByRole("button", { name: "删除当前岗位" }).click();
  await popup.getByRole("button", { name: "撤销删除" }).click();
  await popup.getByText("岗位已恢复", { exact: true }).waitFor();
  await popup.evaluate(() => fixture.unavailable());
  await popup.getByText("当前页面暂无可操作岗位", { exact: true }).waitFor();
  assert.equal(await popup.getByRole("textbox").count(), 0);
  await popup.locator("main").screenshot({
    path: path.join(output, "popup-empty.png"),
  });

  const board = await context.newPage();
  await board.setViewportSize({ width: 1600, height: 950 });
  const staticDir = path.resolve(
    root,
    "../../services/jobs-radar/jobs_radar/static",
  );
  const jobs = [
    {
      company: "WEX",
      title: "Software Engineering Intern — Enterprise Data & Systems",
      status: "in_progress",
    },
    {
      company: "Univera Healthcare",
      title: "College Intern — Summer 2027 — Software Engineering",
      status: "not_started",
    },
    {
      company: "Example Employer",
      title: "Software Engineering Intern",
      status: "submitted_unconfirmed",
    },
  ].map((job, index) => ({
    ...job,
    id: "fixture-" + index,
    active: true,
    locations: ["United States"],
    sources: ["speedyapply"],
    apply_url: "https://fixture.invalid/job/" + index,
    screening: "keep",
    review: null,
    group: "other",
    posted_at: Date.now() / 1000,
    added_at: Date.now() / 1000,
  }));
  await board.route("https://preview.jobs.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) {
      const asset = url.pathname.startsWith("/assets/")
        ? url.pathname.slice(8)
        : "index.html";
      return route.fulfill({
        body: await fs.readFile(path.join(staticDir, asset)),
        contentType: asset.endsWith(".css")
          ? "text/css"
          : asset.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      });
    }
    let value = {};
    if (url.pathname === "/api/session") value = { authenticated: true };
    if (url.pathname === "/api/filter-counts")
      value = {
        total: 3,
        newgrad: { total: 0, submitted: 0 },
        internship: { total: 3, submitted: 0 },
      };
    if (url.pathname === "/api/jobs")
      value = {
        total: 3,
        jobs,
        groups: { other: 3 },
        recent_opened: [],
        source_health: [],
        application_counts: { submitted: 0 },
      };
    await route.fulfill({ json: value });
  });
  await board.goto("https://preview.jobs.invalid/?kind=internship");
  await board.getByRole("link", { name: "申请 ↗", exact: true }).first().waitFor();
  assert.equal(await board.getByRole("link", { name: "申请 ↗", exact: true }).count(), 3);
  const boardAccent = await board.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim(),
  );
  assert.match(boardAccent, /^oklch\((?:0?\.6204|62\.04%) 0?\.195 253\.83\)$/);
  await board.screenshot({
    path: path.join(output, "website.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        stage: stage.stage,
        buildId: stage.buildId,
        theme,
        boardAccent,
        errors,
        checks: [
          "Packaged MV3 popup with real HeroUI and Pro styles",
          "Pointer and keyboard Profile switching",
          "Required deletion reason and undo",
          "Non-job empty state",
          "Website application action labels",
          "Shared default HeroUI blue",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, stage: stage.stage, theme, errors }));
} finally {
  await context.close();
}
