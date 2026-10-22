// Isolated synthetic Workday form. Exercise the exact review-command receiver
// and original writer with hidden/focus-unavailable scheduling; no real ATS.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const source = (
  await Promise.all(
    ["control-fields", "workday-controls", "ai-review"].map((name) =>
      readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
try {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form>
    <div data-automation-id="formField-choice"><label id="question">Decision *</label><button type="button" aria-labelledby="question" aria-haspopup="listbox">Select One</button></div>
    <div data-automation-id="formField-date"><fieldset><legend>Available date *</legend><div data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<input data-automation-id="dateSection${part}-input">`).join("")}</div></fieldset></div>
    </form><button id="next">Continue</button>`,
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    "https://fixture.myworkdayjobs.com/en-US/jobs/job/Engineer_R1/apply",
  );
  await page.evaluate(() => {
    const listeners = [];
    globalThis.fixture = { presentation: null, nextClicks: 0 };
    globalThis.chrome = {
      runtime: {
        id: "fixture",
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    };
    globalThis.JobsReviewPresenter = {
      show: (data) => {
        fixture.presentation = data;
      },
    };
    globalThis.command = (message) =>
      new Promise((resolve) => {
        for (const fn of listeners) {
          let replied = false;
          const result = fn(message, { id: "fixture" }, (value) => {
            replied = true;
            resolve(value);
          });
          if (replied || result === true) return;
        }
        resolve(null);
      });
    Object.defineProperty(document, "hidden", { get: () => true });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    HTMLElement.prototype.focus = () => {};
    // A hidden page cannot depend on animation frames for form commits.
    globalThis.requestAnimationFrame = () => -1;
    document.querySelector("#next").onclick = () => fixture.nextClicks++;
    const button = document.querySelector("form button");
    const close = () => {
      document.querySelector("#options")?.remove();
      button.removeAttribute("aria-controls");
      button.removeAttribute("aria-expanded");
    };
    button.onkeydown = (event) => {
      if (event.key === "Escape") close();
    };
    button.onclick = () => {
      close();
      button.setAttribute("aria-controls", "options");
      button.setAttribute("aria-expanded", "true");
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
      );
      for (const option of document.querySelectorAll('[role="option"]'))
        option.onclick = () => {
          button.textContent = option.textContent;
          close();
        };
    };
    button.click();
  });
  await page.addScriptTag({ content: source });
  const result = await page.evaluate(async () => {
    JobsOperator.update({ mode: "person", epoch: "fixture" });
    const root = document.querySelector("form");
    const reader = JobsControlFields.create(document, () => root, {
      write: true,
    });
    for (const row of reader.scan()) await reader.readOptions(row);
    for (const row of reader.scan())
      JobsAIReview.add(root, reader, row, { needsInput: true });
    JobsAIReview.ready(async () => {}, "fill");
    for (const question of ["Decision", "Available date"]) {
      const state = fixture.presentation;
      const item = state.items.find((entry) =>
        entry.question.includes(question),
      );
      if (!item?.editor)
        throw Error("Missing editor: " + JSON.stringify(state));
      const value =
        question === "Decision"
          ? item.editor.options.find((option) => option.label === "No").value
          : "2030-05-19";
      const reply = await command({
        type: "jobs:review-command",
        id: state.id,
        action: "answer",
        itemId: item.id,
        payload: { version: item.editor.version, value },
      });
      if (!reply?.ok) throw Error(JSON.stringify(reply));
    }
    return {
      choice: root.querySelector("button").textContent,
      parts: [...root.querySelectorAll("input")].map((node) => node.value),
      nextClicks: fixture.nextClicks,
      hidden: document.hidden,
    };
  });
  assert.equal(result.choice, "No");
  assert.deepEqual(result.parts.map(Number), [5, 19, 2030]);
  assert.equal(result.nextClicks, 0);
  assert.equal(result.hidden, true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      browser: await browser.version(),
      checks: [
        "review-command",
        "Workday button dropdown",
        "segmented date",
        "unavailable focus",
        "suspended animation frames",
        "no navigation",
      ],
      boundary: "synthetic controlled hidden state, not ATS acceptance",
    }),
  );
} finally {
  await browser.close();
}
