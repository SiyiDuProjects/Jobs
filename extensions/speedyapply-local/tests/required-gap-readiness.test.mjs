import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { mountReviewPanel } from "./helpers/review-panel.mjs";

const codes = await Promise.all(
  [
    "job-match-rules",
    "job-match",
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const reasons = `<fieldset><legend>Reasons for applying*</legend>
  <fieldset data-automation-id="reasons-CheckboxGroup" aria-required="true">
    <div role="grid"><div role="row">${["Career growth", "Company reputation"].map((label, i) => `<div role="cell"><input type="checkbox" id="reason-${i}"><label for="reason-${i}">${label}</label></div>`).join("")}</div></div>
  </fieldset></fieldset>`;
const veteran = `<div data-automation-id="formField-veteran">
  <label for="veteran">Veterans Status:*</label>
  <button type="button" id="veteran" aria-haspopup="listbox" aria-label="Veterans Status: Select One Required">Select One</button>
</div>`;

function setup(body = reasons) {
  const dom = new JSDOM(
    `<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowPrimaryQuestionsPage">${body}</section><button type="button" id="next">Save and Continue</button></main>`,
    {
      url: "https://fixture.myworkdayjobs.com/en-US/careers/job/Engineer_R123/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    root = w.document.querySelector("section"),
    profile = { profileName: "Fixture" },
    events = [],
    requests = [],
    phases = [];
  let clicks = 0;
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.JobsPageSession = { root: () => root, profile: () => profile };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        assert.equal(message.type, "jobs:auto-answers");
        requests.push(message);
        return {
          data: {
            answers: message.fields.map((field) => ({
              fieldId: field.fieldId,
              state: "needs_input",
              reason: "The applicant must choose their own reasons",
            })),
          },
        };
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  mountReviewPanel(w);
  w.document.getElementById("next").onclick = () => clicks++;
  const reader = w.JobsControlFields.create(w.document, () => root, {
    write: true,
  });
  // Model a delayed browser callback without sleeping for a background-tab
  // throttle interval. All form reads and pipeline decisions remain real.
  function delayPoll(onWake = () => {}, repeat = false) {
    const schedule = w.setTimeout.bind(w),
      now = w.Date.now.bind(w.Date);
    let offset = 0,
      delayed = false;
    w.Date.now = () => now() + offset;
    w.setTimeout = (callback, delay, ...args) =>
      schedule(
        () => {
          if (delay === 50 && (!delayed || repeat)) {
            delayed = true;
            offset += 3000;
            onWake();
          }
          callback(...args);
        },
        delay === 50 ? 0 : delay,
      );
  }
  return {
    w,
    root,
    reader,
    events,
    requests,
    phases,
    delayPoll,
    clicks: () => clicks,
    run: (options = {}) =>
      w.JobsAutomatic.advance({
        root,
        profile,
        action: "next",
        selector: "#next",
        autoConfirm: true,
        resolveAnswers: async () => [],
        setMessage: (phase) => phases.push(phase),
        ...options,
      }),
    close: () => w.close(),
  };
}

test("a late readiness callback still sends a stable required checkbox gap to AI and review", async () => {
  const h = setup();
  try {
    h.delayPoll();
    assert.equal(await h.run(), false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].fields[0].type, "select-multiple");
    assert.equal(h.requests[0].fields[0].options.length, 2);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(h.phases.at(-1), "ai-review");
    assert.equal(h.clicks(), 0);
    assert.equal(h.root.querySelectorAll(":checked").length, 0);
    assert(!h.events.some(([type]) => type === "auto_readiness_timeout"));
  } finally {
    h.close();
  }
});

for (const [name, body] of [
  ["reasons", reasons],
  ["veteran", veteran],
])
  test(`a busy ${name} form exposes its required gap for manual review after timeout`, async () => {
    const h = setup(body);
    try {
      h.root.insertAdjacentHTML("beforeend", '<div aria-busy="true"></div>');
      h.delayPoll();
      assert.equal(await h.run(), false);
      assert.equal(
        h.requests.length,
        0,
        "no AI request from an unsettled form",
      );
      assert.equal(h.w.JobsAIReview.pending(), true);
      assert.equal(h.phases.at(-1), "ai-review");
      const review = h.w.JobsAIReview.remoteState(h.root);
      assert.equal(review.items.length, 1);
      assert.equal(review.items[0].fieldId, h.reader.scan()[0].public.id);
      const card = h.w.document.getElementById("jobs-ai-review").shadowRoot;
      assert.equal(card.querySelector("[data-group='pending']").hidden, false);
      assert.equal(card.querySelector(".answer").textContent, "待补充");
      assert.equal(
        card.querySelector(".question").textContent,
        h.reader.scan()[0].public.question,
      );
      assert.equal(await h.w.JobsAIReview.confirm(), true);
      assert.equal(
        h.clicks(),
        0,
        "acknowledging an empty card cannot continue",
      );
      assert.equal(h.reader.scan()[0].public.filled, false);
    } finally {
      h.close();
    }
  });

test("a field changed during a delayed poll is reviewed without sending the obsolete question to AI", async () => {
  const h = setup();
  try {
    h.delayPoll(() => {
      h.root.querySelector("legend").textContent = "New required question*";
    });
    assert.equal(await h.run(), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(
      h.w.document
        .getElementById("jobs-ai-review")
        .shadowRoot.querySelector(".question").textContent,
      "New required question*",
    );
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("cancellation at a delayed readiness callback creates no AI request, card or navigation", async () => {
  const h = setup();
  let current = true;
  try {
    h.delayPoll(() => {
      current = false;
    });
    assert.equal(await h.run({ canProceed: () => current }), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("late final-readiness callbacks never authorize a stale or busy form", async () => {
  for (const change of ["empty", "busy", "button"]) {
    const h = setup('<label>Name*<input required value="Example"></label>');
    try {
      h.delayPoll(() => {
        if (change === "empty") h.root.querySelector("input").value = "";
        if (change === "busy")
          h.root.insertAdjacentHTML(
            "beforeend",
            '<div aria-busy="true"></div>',
          );
        if (change === "button")
          h.w.document.getElementById("next").disabled = true;
      });
      const settled = await h.reader.settle({ selector: "#next" });
      assert.equal(settled, null, change);
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  }
});
