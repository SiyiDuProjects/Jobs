import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const bundle = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const codes = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const block = (name) => functionBlock(bundle, name);
function setup({
  autoSubmit = true,
  invalid = false,
  profileFailure = false,
} = {}) {
  const dom = new JSDOM(
      `<div data-automation-id="applyFlowReviewPage"><h3>Review</h3>${invalid ? '<p data-automation-id="inputAlert">Required answer missing</p>' : ""}<div hidden><div role="alert">Resume successfully uploaded</div></div></div><button data-automation-id="pageFooterNextButton">Submit</button>`,
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  const root = w.document.querySelector(
      '[data-automation-id="applyFlowReviewPage"]',
    ),
    profile = { profileName: "Newgrad" },
    messages = [],
    events = [];
  let clicks = 0,
    profiles = 0;
  w.JobsPageSession = { root: () => root };
  w.JobsAIReview = { pending: () => false };
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.chrome = {
    runtime: { sendMessage: async () => ({ data: { id: "ng", profile } }) },
  };
  codes.forEach((code) => w.eval(code));
  w.jobsReportJobTitle = async () => false;
  w.eval(
    block("workdayTrackReviewSubmitClick") +
      "\n" +
      block("workdayHandleReviewPage") +
      "\n" +
      block("workdayRunApplication"),
  );
  w.jobsWaitForXPathNodes = (selector) =>
    selector.includes("reviewJobApplicationPage")
      ? Promise.resolve()
      : new Promise(() => {});
  w.document.querySelector("button").onclick = () => clicks++;
  const run = () =>
    w.workdayRunApplication({
      autofillSettings: { autoSubmit, saveApplications: false },
      accountSettings: {},
      ctx: {},
      setMessage: (m) => messages.push(m),
      getProfile: async () => {
        profiles++;
        messages.push("in-progress");
        if (profileFailure) throw Error("Profile unavailable");
        return profile;
      },
    });
  return {
    w,
    run,
    messages,
    events,
    clicks: () => clicks,
    profiles: () => profiles,
    close: () => w.close(),
  };
}
async function settle(h, predicate) {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  assert(predicate(), JSON.stringify(h.messages));
}

test("actual Workday Review callback submits once when autoSubmit is enabled and reports its attempt", async () => {
  const h = setup();
  try {
    await h.run();
    await settle(h, () => h.clicks() === 1);
    assert.equal(h.messages.at(-1), "submitting");
    assert.equal(h.profiles(), 1);
    assert(h.events.some(([type]) => type === "auto_navigation_attempt"));
  } finally {
    h.close();
  }
});
test("disabled autoSubmit reports waiting for manual submit without reading Profile or remaining in progress", async () => {
  const h = setup({ autoSubmit: false });
  try {
    await h.run();
    await settle(h, () => h.messages.includes("ready-submit"));
    assert.equal(h.clicks(), 0);
    assert.equal(h.profiles(), 0);
  } finally {
    h.close();
  }
});
test("Review validation and Profile failures report a stopped state and do not submit", async () => {
  for (const options of [{ invalid: true }, { profileFailure: true }]) {
    const h = setup(options);
    try {
      await h.run();
      await settle(h, () =>
        h.messages.some((m) =>
          ["complete-required", "complete-manually"].includes(m),
        ),
      );
      assert.equal(h.clicks(), 0);
      assert(h.events.some(([type]) => type === "auto_blocked"));
    } finally {
      h.close();
    }
  }
});

test("Review waits for the first enabled footer instead of abandoning the one submit attempt during mount", async () => {
  const h = setup();
  try {
    const button = h.w.document.querySelector("button");
    button.disabled = true;
    await h.run();
    setTimeout(() => {
      button.disabled = false;
    }, 50);
    await settle(h, () => h.clicks() === 1);
    assert.equal(h.messages.at(-1), "submitting");
    assert(h.events.some(([type]) => type === "auto_review_waiting"));
  } finally {
    h.close();
  }
});
