// Actual packaged HeroUI UI against synthetic extension messages. No real tabs,
// Profiles, network requests, form navigation or submission are used.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { buildPackage } from "./build.mjs";
import { discardCandidate } from "./package-state.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(root, "../../work/ui-answer-console");
await fs.mkdir(output, { recursive: true });
const candidate = process.argv[4] ? null : await buildPackage();
const stage = process.argv[4] || candidate.stage;
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.addInitScript(() => {
    const listeners = new Set(),
      closed = new Set();
    const event = { addListener() {}, removeListener() {} };
    const item = (id, question, editor) => ({
      id,
      question,
      originalQuestion: question,
      answer: "待补充",
      source: "待你确认",
      reason: "合成审核数据，用于检查界面。",
      reviewState: "pending",
      editor,
    });
    const editor = (kind, value, options) => ({
      kind,
      value,
      options,
      version: 1,
      schemaVersion: 1,
      valid: false,
      disabled: false,
    });
    const rows = [
      {
        tabId: 1,
        windowId: 3,
        index: 1,
        title: "Example · Software Engineer Intern",
        url: "https://example.invalid/job/1",
        operator: "person",
        profileName: "Synthetic Intern",
        status: { phase: "ai-review", text: "等待审核" },
        reviewPending: true,
        review: {
          id: "r1",
          documentId: "d1",
          data: {
            id: "r1",
            canConfirm: true,
            items: [
              item("0", "介绍你的项目", editor("textarea", "")),
              item(
                "1",
                "选择一个地区",
                editor(
                  "select",
                  "",
                  Array.from({ length: 25 }, (_, i) => ({
                    value: String(i),
                    label: "Synthetic region " + i,
                  })),
                ),
              ),
              {
                ...item("summary-0", "提交前核对项目说明", null),
                answer:
                  "This is a synthetic draft for reading before confirmation.",
                source: "提交前核对的草稿",
              },
            ],
          },
        },
      },
      {
        tabId: 2,
        windowId: 4,
        index: 2,
        title: "Example · Developer Tools Engineer",
        url: "https://example.invalid/job/2",
        operator: "agent",
        profileName: "Synthetic Newgrad",
        status: { phase: "ai-review", text: "等待审核" },
        reviewPending: true,
        review: {
          id: "r2",
          documentId: "d2",
          data: {
            id: "r2",
            canConfirm: true,
            items: [
              item(
                "0",
                "选择希望参与的方向",
                editor(
                  "multiple",
                  [],
                  [
                    { value: "dev", label: "Developer tools" },
                    { value: "infra", label: "Infrastructure" },
                  ],
                ),
              ),
            ],
          },
        },
      },
      {
        tabId: 3,
        windowId: 3,
        index: 3,
        title: "Example · Completed application",
        url: "https://example.invalid/job/3",
        status: { phase: "confirmed", text: "网站已确认，投递完成" },
        review: null,
      },
    ];
    const notify = (tabId) =>
      listeners.forEach((fn) =>
        fn({ type: "jobs:panel-changed", tabId }, { id: "fixture" }),
      );
    const fixture = {
      commands: [],
      reads: [],
      bump() {
        rows[0].review.data.items[0].editor.version++;
        notify(1);
      },
      close(id) {
        closed.add(id);
        notify(id);
      },
      add() {
        rows.push({
          ...structuredClone(rows[1]),
          tabId: 4,
          index: 4,
          title: "Example · New questions",
          review: {
            ...structuredClone(rows[1].review),
            id: "r4",
            documentId: "d4",
          },
        });
        notify(4);
      },
    };
    globalThis.fixture = fixture;
    const chrome = {
      tabs: { onRemoved: event, onUpdated: event },
      runtime: {
        id: "fixture",
        onMessage: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },
        async sendMessage(message) {
          if (message.type === "jobs:console-read") {
            fixture.reads.push(message.tabIds || "all");
            return {
              data: {
                tabs: structuredClone(
                  rows.filter(
                    (row) =>
                      !closed.has(row.tabId) &&
                      (!message.tabIds || message.tabIds.includes(row.tabId)),
                  ),
                ),
              },
            };
          }
          fixture.commands.push(structuredClone(message));
          if (message.type === "jobs:console-focus")
            return { data: { ok: true, located: true } };
          const row = rows.find((entry) => entry.tabId === message.tabId);
          if (message.type === "jobs:review-action") {
            if (message.action === "answer") {
              const item = row.review.data.items.find(
                (entry) => entry.id === message.itemId,
              );
              if (message.payload.version !== item.editor.version)
                return { error: "页面选项已变化，请按更新后的选项重新选择。" };
              item.editor.value = message.payload.value;
              item.editor.version++;
              item.editor.valid = true;
              item.reviewState = "ready";
              item.answer = String(message.payload.value);
              item.source = row.operator === "person" ? "你的回答" : "AI 补答";
            } else if (message.action === "confirm") {
              row.review = null;
              row.reviewPending = false;
              row.status = { phase: "page-complete", text: "本页已填好" };
            }
            notify(row.tabId);
            return { ok: true };
          }
          return { ok: true };
        },
      },
    };
    Object.defineProperty(globalThis, "chrome", {
      value: chrome,
      configurable: true,
    });
  });
  await page.goto(pathToFileURL(path.join(stage, "console.html")).href);
  const text = page.getByRole("textbox", { name: "介绍你的项目" });
  await text.waitFor();
  await text.fill("Synthetic draft retained between pages.");
  const selectPage = (title) =>
    page.locator(".console-list-item").filter({ hasText: title }).click();
  await selectPage("Developer Tools Engineer");
  await page
    .getByRole("button", { name: "Developer tools", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Developer tools（已选）", exact: true })
    .waitFor();
  await selectPage("Software Engineer Intern");
  assert.equal(
    await text.inputValue(),
    "Synthetic draft retained between pages.",
  );
  await selectPage("Developer Tools Engineer");
  await page
    .getByRole("button", { name: "Developer tools（已选）", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Developer tools（已选）", exact: true })
      .count(),
    1,
    "multi-choice drafts survive changing pages",
  );
  await selectPage("Software Engineer Intern");
  await page.evaluate(() => fixture.bump());
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /^填入/ }).click();
  await page.getByRole("alert").filter({ hasText: "页面选项已变化" }).waitFor();
  await page.getByRole("button", { name: /^填入/ }).click();
  assert.equal(
    await page.evaluate(
      () =>
        fixture.commands.filter((cmd) => cmd.action === "answer").at(-1).payload
          .version,
    ),
    1,
    "a rejected draft is never silently rebased",
  );
  await text.fill("Reviewed against the new page version.");
  await page.getByRole("button", { name: /^填入/ }).click();
  const search = page.getByRole("textbox", { name: "筛选选项" });
  await search.waitFor();
  await search.fill("region 24");
  const before = await page.evaluate(() => fixture.commands.length);
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(
    await page.evaluate(() => fixture.commands.length),
    before,
    "IME confirmation never submits",
  );
  await search.press("Enter");
  await page
    .locator('.console-question[data-active="true"]')
    .filter({ hasText: "提交前核对项目说明" })
    .waitFor();
  await page.getByText("需要你处理 · 1 项", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(output, "narrow.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "narrow viewport has no horizontal overflow",
  );
  await page.getByRole("button", { name: "确认这些答案", exact: true }).click();
  await page
    .locator(".console-card-title")
    .filter({ hasText: "Developer Tools Engineer" })
    .waitFor();
  await page.getByRole("button", { name: /填入所选/ }).click();
  await page.locator(".console-settled summary").click();
  await page.getByText("AI 补答", { exact: true }).waitFor();
  await page.evaluate(() => fixture.add());
  await page
    .locator(".console-list-item")
    .filter({ hasText: "New questions" })
    .waitFor();
  await page.evaluate(() => fixture.close(4));
  await page
    .locator(".console-list-item")
    .filter({ hasText: "New questions" })
    .waitFor({ state: "detached" });
  assert(
    (await page.evaluate(() => fixture.reads)).some(
      (ids) => Array.isArray(ids) && ids.length === 1,
    ),
    "announcements refresh only the changed tab",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      screenshots: output,
      checks: [
        "drafts",
        "stale-version",
        "IME",
        "long-options",
        "read-only-drafts",
        "next-page",
        "live-tabs",
        "targeted-refresh",
        "desktop",
        "narrow",
      ],
    }),
  );
} finally {
  await browser.close();
  if (candidate) await discardCandidate(root, candidate.stage);
}
