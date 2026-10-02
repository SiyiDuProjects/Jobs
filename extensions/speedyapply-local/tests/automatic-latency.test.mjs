import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const codes = await Promise.all(
  [
    "dom-wait",
    "control-fields",
    "workday-controls",
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
);
function fixture(
  t,
  { count = 6, filled = false, latency = 0, workday = false } = {},
) {
  const w = new JSDOM(
    `<form>${Array.from({ length: count }, (_, i) =>
      workday
        ? `<div data-automation-id="formField-choice${i}"><label id="question${i}">Decision ${i} *</label><button type="button" aria-labelledby="question${i}" aria-required="true" aria-haspopup="listbox">Select One</button></div>`
        : `<label>Question ${i}<input required value="${filled ? "Synthetic answer" : ""}"></label>`,
    ).join("")}</form><button type="button" id="next">Continue</button>`,
    {
      url: workday
        ? "https://fixture.myworkdayjobs.com/apply"
        : "https://fixture.example/apply",
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  const profile = { profileName: "Synthetic" },
    checks = [],
    notes = [];
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        assert.equal(message.type, "jobs:tab-profile");
        checks.push(message.verify === true);
        if (latency)
          await new Promise((resolve) => setTimeout(resolve, latency));
        return { data: { id: "synthetic", profile, tabId: 1 } };
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
  };
  for (const code of codes) w.eval(code);
  let clicks = 0;
  w.document.addEventListener("click", (event) => {
    if (event.target.id === "next") clicks++;
  });
  const root = w.document.querySelector("form");
  return {
    w,
    root,
    profile,
    checks,
    notes,
    clicks: () => clicks,
    run: (options = {}) =>
      w.JobsAutomatic.advance({
        root,
        profile,
        action: "next",
        selector: "#next",
        resolveAnswers: async (questions) =>
          questions.map((_, index) => ({
            index,
            answer: "Synthetic answer",
            source: "profile",
          })),
        ...options,
      }),
  };
}

test("known answers share one bound Profile check even with a slow extension background", async (t) => {
  const h = fixture(t, { latency: 200 });
  assert.equal(await h.run(), true);
  assert.equal(h.clicks(), 1);
  assert(
    [...h.root.querySelectorAll("input")].every(
      (node) => node.value === "Synthetic answer",
    ),
  );
  const timing = JSON.parse(
    h.notes.find((row) => row.type === "auto_run_timing").detail,
  );
  t.diagnostic(
    JSON.stringify({
      fixture: "six known text answers; 200ms per background check",
      timing,
      checks: h.checks,
    }),
  );
  assert.equal(h.checks.length, 1);
  assert.equal(
    h.checks.filter(Boolean).length,
    0,
    "the adapter has already fetched the server Profile",
  );
});

test("Workday dropdowns keep committed answers and continue once with one binding check", async (t) => {
  const h = fixture(t, { workday: true, latency: 200 });
  for (const button of h.root.querySelectorAll("button")) {
    button.onclick = () => {
      button.setAttribute("aria-controls", "options");
      button.setAttribute("aria-expanded", "true");
      h.w.document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
      );
      for (const option of h.w.document.querySelectorAll('[role="option"]'))
        option.onclick = () => {
          button.textContent = option.textContent;
          h.w.document.getElementById("options").remove();
          button.removeAttribute("aria-controls");
          h.w.setTimeout(() => button.removeAttribute("aria-expanded"), 60);
        };
    };
  }
  assert.equal(
    await h.run({
      resolveAnswers: async (questions) =>
        questions.map((_, index) => ({
          index,
          answer: "No",
          source: "profile",
        })),
    }),
    true,
  );
  assert.equal(h.clicks(), 1);
  assert.deepEqual(h.checks, [false]);
  assert(
    [...h.root.querySelectorAll("button")].every(
      (button) =>
        button.textContent === "No" && !button.hasAttribute("aria-expanded"),
    ),
  );
  assert.equal(
    h.notes.filter((row) => /abstained|failed/.test(row.type)).length,
    0,
  );
  t.diagnostic(
    JSON.stringify({
      fixture:
        "six Workday dropdowns with delayed popup collapse; 200ms background",
      timing: JSON.parse(
        h.notes.find((row) => row.type === "auto_run_timing").detail,
      ),
    }),
  );
});

for (const change of [
  "unchanged",
  "late-error",
  "cancelled",
  "replaced-button",
]) {
  test(`slow navigation authorization preserves the DOM budget: ${change}`, async (t) => {
    const h = fixture(t, { count: 1, filled: true });
    let authorization = 0,
      offset = 0,
      allowed = true;
    const now = h.w.Date.now.bind(h.w.Date);
    h.w.Date.now = () => now() + offset;
    h.w.JobsQueuePage = {
      guard: (fn) => () => allowed && fn(),
      allowed: () => allowed,
      verify: async () => {},
      beforeNavigate: async () => {
        authorization++;
        await Promise.resolve();
        offset += 4000;
        if (change === "late-error")
          h.root.querySelector("input").setAttribute("aria-invalid", "true");
        if (change === "cancelled") allowed = false;
        if (change === "replaced-button" && authorization === 1) {
          const button = h.w.document.querySelector("button");
          button.replaceWith(button.cloneNode(true));
        }
      },
      afterNavigate: () => {},
      clickNavigate: (action, button) => h.w.JobsPageActions.click(button),
    };
    assert.equal(
      await h.run(),
      change === "unchanged" || change === "replaced-button",
    );
    assert.equal(
      h.clicks(),
      change === "unchanged" || change === "replaced-button" ? 1 : 0,
    );
    assert(authorization >= 1);
    if (change === "unchanged") {
      assert.equal(authorization, 1);
      assert.equal(await h.run(), true);
      assert.equal(
        h.clicks(),
        1,
        "a dispatched navigation is never clicked again",
      );
    }
  });
}
