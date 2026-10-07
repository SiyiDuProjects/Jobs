// Isolated Chrome; all URLs are fulfilled locally with synthetic form data.
// Controlled hidden-state/timer scheduling is a reproduction, not ATS acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const source = (
  await Promise.all(
    [
      "option-match",
      "profile-answers",
      "dom-wait",
      "control-fields",
      "workday-controls",
    ].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
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
      body: `
    <form><div data-automation-id="formField-skills"><label for="skills">Skills</label>
    <div data-automation-id="multiSelectContainer"><input id="skills" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="prompt">
    <ul data-automation-id="selectedItemList"></ul></div></div><button type="button" id="next">Next</button></form>`,
    }),
  );
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const errors = [];
  for (const [index, page] of pages.entries()) {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`https://fixture.myworkdayjobs.com/skills-${index}`);
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const doc = document,
        input = doc.querySelector("input"),
        selected = doc.querySelector("ul");
      const timer = window.setTimeout.bind(window);
      // Site rendering continues through real browser tasks; extension's old
      // zero-delay search writes would stall indefinitely under this schedule.
      window.setTimeout = (callback, delay, ...args) =>
        delay === 0 ? -1 : timer(callback, delay, ...args);
      let hidden = true;
      Object.defineProperty(doc, "hidden", { get: () => hidden });
      window.foreground = () => {
        hidden = false;
        doc.dispatchEvent(new Event("visibilitychange"));
      };
      const until = JobsDOMWait.until;
      JobsDOMWait.until = (read, options = {}) =>
        until(read, { ...options, timeout: 100 });
      const attempts = {},
        searches = [],
        clicks = [];
      const diagnostics = [];
      window.JobsDiagnostics = {
        note: (type) => diagnostics.push(type),
        trace: (_node, entry) => diagnostics.push("trace:" + entry.result),
        evidence: (_node, entry) =>
          diagnostics.push(entry.stage + ":" + entry.result),
      };
      let host,
        nextClicks = 0;
      doc.querySelector("#next").onclick = () => nextClicks++;
      const addPill = (label) => {
        const li = doc.createElement("li");
        li.dataset.automationId = "menuItem";
        const span = li.appendChild(doc.createElement("span"));
        span.dataset.automationId = "selectedItem";
        span.appendChild(doc.createElement("p")).textContent = label;
        selected.append(li);
      };
      addPill("Manual skill");
      const render = (label, search) => {
        const group = doc.createElement("div");
        group.dataset.uxiMultiselectlistIssearch = String(search);
        group.innerHTML =
          '<div data-automation-id="activeListContainer"><div role="presentation"><div role="option"><input type="checkbox"><span data-automation-id="promptOption"></span></div></div></div>';
        group.querySelector("span").textContent = label;
        group.querySelector("input").onclick = () => {
          clicks.push(label);
          addPill(label);
          input.value = "";
          host.remove();
        };
        return group;
      };
      input.onclick = () => {
        if (host?.isConnected) return;
        host = doc.createElement("div");
        host.dataset.associatedWidget = "prompt";
        host.append(render("Unrelated initial option", false));
        doc.body.append(host);
      };
      input.onkeydown = (event) => {
        if (event.key === "Escape") {
          host?.remove();
          return;
        }
        if (event.key !== "Enter") return;
        const query = input.value,
          destination = host;
        searches.push(query);
        attempts[query] = (attempts[query] || 0) + 1;
        const label =
          query === "Python"
            ? attempts[query] === 1
              ? "Unrelated skill"
              : "Python (Programming Language)"
            : query;
        timer(
          () => {
            if (destination.isConnected)
              destination.replaceChildren(render(label, true));
          },
          query === "SQL" ? 140 : 10,
        );
      };
      window.fillSkills = () =>
        JobsFormPipeline.bind([
          {
            name: "skills",
            find: () => input,
            answers: ["Python", "SQL", "SQL"].map((skill) =>
              JobsProfileAnswers.skillSpec(skill),
            ),
          },
        ]);
      window.report = () => ({
        values: [...selected.querySelectorAll("p")].map(
          (node) => node.textContent,
        ),
        searches,
        clicks,
        nextClicks,
        diagnostics: diagnostics.slice(-15),
      });
    });
  }
  const results = await Promise.allSettled(
    pages.map(async (page, index) => {
      await page.evaluate(() => {
        window.skillsFinished = false;
        void (async () => {
          try {
            await fillSkills();
          } catch (error) {
            window.skillsError = error.message;
          } finally {
            window.skillsFinished = true;
          }
        })();
      });
      if (index === 1) {
        await page.waitForFunction(
          () => report().searches.includes("SQL"),
          null,
          { timeout: 5000 },
        );
        await page.evaluate(() => foreground());
      }
      try {
        await page.waitForFunction(() => window.skillsFinished, null, {
          timeout: 5000,
        });
      } catch {
        throw Error(
          "Skills did not finish: " +
            JSON.stringify(await page.evaluate(() => report())),
        );
      }
      const report = await page.evaluate(() => ({
        ...report(),
        error: window.skillsError,
      }));
      assert.equal(report.error, undefined);
      assert.deepEqual(report.values, [
        "Manual skill",
        "SQL",
        "Python (Programming Language)",
      ]);
      assert.deepEqual(report.searches, ["Python", "SQL", "Python"]);
      assert.deepEqual(report.clicks, ["SQL", "Python (Programming Language)"]);
      assert.equal(report.nextClicks, 0);
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      browser: await browser.version(),
      pages: 2,
      checks: [
        "delayed hidden search",
        "visibility resumption",
        "earlier failure recovery",
        "duplicate suppression",
        "manual pill preservation",
        "no navigation",
      ],
      scheduling:
        "controlled hidden-state and zero-delay timers; synthetic site only",
    }),
  );
} finally {
  await browser.close();
}
