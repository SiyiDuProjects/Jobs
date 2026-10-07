// Packaged HeroUI surface, synthetic data, isolated browser; no owner's tabs.
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
const output = path.resolve(root, "../../work/ui-side-panel");
await fs.mkdir(output, { recursive: true });
const stage = await buildPackage();
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.addInitScript(() => {
    const listeners = new Set();
    const tabs = new Set();
    let current = 12,
      value = "",
      version = 1,
      review = true,
      kind = "intern";
    const event = { addListener() {}, removeListener() {} };
    const notify = () =>
      listeners.forEach((fn) =>
        fn({ type: "jobs:panel-changed", tabId: current }, { id: "fixture" }),
      );
    globalThis.fixture = {
      commands: [],
      switchTab() {
        current = 13;
        tabs.forEach((fn) => fn({ tabId: current, windowId: 5 }));
      },
    };
    const chrome = {
      tabs: {
        query: async () => [
          {
            id: current,
            windowId: 5,
            title: "Software Engineering Intern · Example",
            url: "https://fixture.invalid/job/" + current,
          },
        ],
        onActivated: {
          addListener: (fn) => tabs.add(fn),
          removeListener: (fn) => tabs.delete(fn),
        },
        onUpdated: event,
      },
      storage: { onChanged: event },
      runtime: {
        id: "fixture",
        onMessage: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },
        async sendMessage(message) {
          if (message.type === "jobs:popup-profile") {
            if (message.action === "select") kind = message.kind;
            return {
              data: {
                available: true,
                bound: true,
                kind,
                profileName: kind,
                source: "manual",
                choices: { intern: true, newgrad: true },
              },
            };
          }
          if (message.type === "jobs:job-action") return { state: "ready" };
          if (message.type === "jobs:panel-read")
            return current === 12
              ? {
                  status: { text: review ? "等待你确认答案" : "本页已填好" },
                  review: review
                    ? {
                        id: "review",
                        documentId: "doc",
                        data: {
                          id: "review",
                          title: "需要你补充 · 1 项",
                          status: "检查答案后确认，再继续申请。",
                          canConfirm: true,
                          items: [
                            {
                              id: "0",
                              question: "你希望参与哪类项目？",
                              answer: value || "待补充",
                              source: value ? "你的回答" : "待核对",
                              editor: {
                                kind: "textarea",
                                value,
                                version,
                                schemaVersion: 1,
                                valid: !!value,
                              },
                            },
                          ],
                        },
                      }
                    : null,
                }
              : { status: { text: "就绪" } };
          if (message.type === "jobs:review-action") {
            fixture.commands.push(message);
            if (message.action === "answer") {
              value = message.payload.value;
              version++;
            }
            if (message.action === "confirm") review = false;
            notify();
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
  await page.goto(pathToFileURL(path.join(stage.stage, "popup.html")).href);
  await page.getByRole("textbox", { name: "你希望参与哪类项目？" }).waitFor();
  await page.getByRole("radio", { name: "全职 Newgrad" }).click();
  await page
    .getByRole("textbox", { name: "你希望参与哪类项目？" })
    .fill("I would like to work on developer tools.");
  await page.getByRole("button", { name: "确认这些答案" }).click();
  await page.getByText("本页已填好", { exact: true }).waitFor();
  const commands = await page.evaluate(() => fixture.commands);
  assert.deepEqual(
    commands.map((item) => item.action),
    ["answer", "confirm"],
  );
  assert.equal(
    commands[0].payload.value,
    "I would like to work on developer tools.",
  );
  await page.reload();
  await page.getByRole("textbox", { name: "你希望参与哪类项目？" }).waitFor();
  for (const width of [320, 380, 520]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(output, `panel-${width}.png`),
      fullPage: true,
    });
  }
  const style = await page.locator("#jobs-ai-review").evaluate((host) => {
    const button = host.shadowRoot.querySelector("#confirm");
    return {
      position: getComputedStyle(host).position,
      background: getComputedStyle(button).backgroundColor,
    };
  });
  assert.equal(style.position, "static");
  assert.notEqual(style.background, "rgba(0, 0, 0, 0)");
  await page.evaluate(() => fixture.switchTab());
  await page.waitForFunction(() => !document.querySelector("#jobs-ai-review"));
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        buildId: stage.buildId,
        widths: [320, 380, 520],
        style,
        checks: [
          "HeroUI packaged surface",
          "draft flushed before confirm",
          "tab switch clears review",
          "responsive no horizontal overflow",
        ],
        nativeSidePanelChromeUI: "not exercised",
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, style, errors }));
} finally {
  await browser.close();
  await discardCandidate(root, stage.stage);
}
