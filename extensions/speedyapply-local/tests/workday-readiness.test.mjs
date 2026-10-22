import { withFixtureClock } from "./helpers/fixture-clock.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const codes = await Promise.all(
  [
    "control-fields",
    "workday-controls",
    "operation-context",
    "dom-wait",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function setup(body) {
  const dom = new JSDOM(
    `<main data-automation-id="ApplyFlowPage"><section data-automation-id="contactInformationPage">${body}</section><button id="next" type="button">Save and Continue</button></main>`,
    {
      url: "https://acme.wd5.myworkdayjobs.com/en-US/careers/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    profile = { profileName: "Newgrad" },
    phases = [],
    events = [];
  let calls = 0,
    clicks = 0;
  w.JobsAIReview = { pending: () => false };
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "test", profile } };
        calls++;
        throw Error("No AI request should be made for this completed page");
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("section");
  w.JobsPageSession = { root: () => w.document.querySelector("main") };
  w.document.querySelector("#next").onclick = () => clicks++;
  return {
    w,
    root,
    profile,
    phases,
    events,
    calls: () => calls,
    clicks: () => clicks,
    run: () =>
      w.JobsAutomatic.advance({
        root,
        profile,
        action: "next",
        selector: "#next",
        setMessage: (phase) => phases.push(phase),
      }),
    close: () => w.close(),
  };
}
const complete =
  '<label>First Name*<input required value="Test"></label><label>Last Name*<input required value="Applicant"></label>';

test("Upbound degree question is stable across placeholder and selected values in the accessible name", () => {
  for (const value of [
    "Select One",
    "Bachelor of Science (B.S)",
    "Bachelor of Arts (B.A)",
  ]) {
    const h = setup(
      `<div data-automation-id="formField-degree"><label for="education-116--degree"><span>Degree<abbr>*</abbr></span></label><div><button id="education-116--degree" name="degree" aria-haspopup="listbox" aria-label="Degree ${value} Required">${value}</button><input type="text" value="opaque-id" style="display:none"></div></div>`,
    );
    try {
      const row = h.w.JobsControlFields.create(
        h.w.document,
        () => h.root,
      ).scan()[0];
      assert.equal(row.public.question, "Degree*");
      assert.equal(row.public.required, true);
    } finally {
      h.close();
    }
  }
});
const prompt = (selected) =>
  `<label for="source">How Did You Hear About Us?*</label><div data-automation-id="multiSelectContainer"><input id="source" data-uxi-widget-type="selectinput" value="" aria-required="true"><ul data-automation-id="selectedItemList">${selected ? '<li data-automation-id="selectedItem"><p data-automation-id="promptOption">Corporate Website</p></li>' : ""}</ul></div>`;

test("Workday information: committed source plus optional blanks continues once without AI", async () => {
  const h = setup(
    complete +
      prompt(true) +
      '<label>Address Line 2<input></label><label>Phone Extension<input></label><label>I have a preferred name<input type="checkbox"></label>',
  );
  try {
    assert.equal(await h.run(), true);
    assert.equal(h.calls(), 0);
    assert.equal(h.clicks(), 1);
    assert(!h.phases.includes("ai-thinking"));
    assert(!h.phases.includes("complete-required"));
    await h.run();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});
test("source preferences preserve an existing site-valid choice and allow Next once", async () => {
  for (const profile of [
    {},
    {
      applicationData: {
        aiNotes:
          "Recruiting-source preference: prefer LinkedIn, then Job Board/Online.",
      },
    },
  ]) {
    const h = setup(complete + prompt(true));
    try {
      const input = h.w.document.getElementById("source"),
        container = input.parentElement,
        selected = container.querySelector(
          '[data-automation-id="promptOption"]',
        );
      // A retained selection can differ from both a failed search preference
      // and an earlier exact selection marker after the person edits the field.
      container.setAttribute("data-jobs-expected-choice", "Corporate Website");
      selected.textContent = "University / Example Campus Job Board";
      h.w.JobsWorkdayControls.expect(
        input,
        h.w.JobsProfileAnswers.recruitingSourceSpec(profile),
      );
      assert.equal(await h.run(), true);
      assert.equal(
        selected.textContent,
        "University / Example Campus Job Board",
      );
      assert.equal(h.calls(), 0);
      assert.equal(h.clicks(), 1);
      await h.run();
      assert.equal(h.clicks(), 1);
    } finally {
      h.close();
    }
  }
});
test("source preferences still require a single committed choice without website errors", () => {
  for (const failure of ["aria", "native", "empty", "multiple"]) {
    const h = setup(complete + prompt(true));
    try {
      const input = h.w.document.getElementById("source"),
        list = input.parentElement.querySelector("ul");
      h.w.JobsWorkdayControls.expect(
        input,
        h.w.JobsProfileAnswers.recruitingSourceSpec({}),
      );
      if (failure === "aria") input.setAttribute("aria-invalid", "true");
      if (failure === "native")
        input.setCustomValidity("Choose a valid source");
      if (failure === "empty") {
        list.replaceChildren();
        input.value = "Search text is not a selection";
      }
      if (failure === "multiple")
        list.append(list.firstElementChild.cloneNode(true));
      const reader = h.w.JobsControlFields.create(h.w.document, () => h.root);
      assert.equal(reader.state().ready, false, failure);
    } finally {
      h.close();
    }
  }
});
test("explicit source facts and other answer expectations remain strict", () => {
  const h = setup(complete + prompt(true));
  try {
    const input = h.w.document.getElementById("source"),
      api = h.w.JobsProfileAnswers,
      reader = h.w.JobsControlFields.create(h.w.document, () => h.root);
    for (const spec of [
      api.recruitingSourceSpec({}, { recruitingSource: "LinkedIn" }),
      api.knownSpec("Field of study", "Physics"),
    ]) {
      h.w.JobsWorkdayControls.expect(input, spec);
      assert.equal(reader.state().ready, false);
      assert.equal(
        reader.scan().find((row) => row.node === input).public.invalid,
        true,
      );
    }
  } finally {
    h.close();
  }
});
test("Workday observer does not start a second supplement for optional information blanks", async () => {
  const h = setup(complete + "<label>Address Line 2<input></label>");
  try {
    const wrapped = h.w.JobsAutomatic.observe({
      getProfile: async () => h.profile,
      setMessage: (phase) => h.phases.push(phase),
    });
    await wrapped.getProfile();
    wrapped.setMessage("page-complete");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.calls(), 0);
    assert.equal(h.phases.at(-1), "page-complete");
  } finally {
    h.close();
  }
});
test("Workday missing committed source and real validation errors still block Next", async () => {
  for (const body of [
    complete + prompt(false),
    complete +
      prompt(true) +
      '<p data-automation-id="inputError">Please verify your address</p>',
  ]) {
    const h = setup(body);
    try {
      assert.equal(await withFixtureClock(h.w, h.run), false);
      assert.equal(h.clicks(), 0);
      assert.equal(
        h.calls(),
        body.includes("Please verify your address") ? 0 : 1,
      );
      assert.equal(h.phases.at(-1), "complete-required");
    } finally {
      h.close();
    }
  }
});
test("Unknown optional control permits ordinary next but not final submit", async () => {
  const h = setup(
    complete +
      '<div contenteditable="true" aria-label="Optional custom control"></div>',
  );
  try {
    assert.equal(
      h.w.JobsControlFields.create(h.w.document, () => h.root).state().ready,
      false,
    );
    assert.equal(await h.run(), true);
    assert.equal(h.clicks(), 1);
    assert.equal(h.phases.at(-1), "awaiting-transition");
  } finally {
    h.close();
  }
});
test("Hidden Workday step errors do not block the completed visible step", async () => {
  const h = setup(
    complete +
      '<div hidden><span role="progressbar"></span><input aria-invalid="true"><p data-automation-id="inputAlert">Required on another step</p></div>',
  );
  try {
    assert.equal(await h.run(), true);
    assert.equal(h.clicks(), 1);
    assert.equal(h.calls(), 0);
  } finally {
    h.close();
  }
});
test("Workday reported field error takes precedence over the adapter page-complete message", async () => {
  const h = setup(
    '<label>Company*<input required value="Example Company" aria-invalid="true"></label><p data-automation-id="inputAlert">The field Company is required</p>',
  );
  try {
    const wrapped = h.w.JobsAutomatic.observe({
      getProfile: async () => h.profile,
      setMessage: (phase) => h.phases.push(phase),
    });
    await wrapped.getProfile();
    wrapped.setMessage("page-complete");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.phases.at(-1), "complete-required");
    assert.equal(h.calls(), 0);
  } finally {
    h.close();
  }
});
test("resolved Workday validation clears a stale required message without AI or another navigation", async () => {
  const h = setup(
    '<label>Company*<input required value="Example Company" aria-invalid="true"></label><p data-automation-id="inputAlert">The field Company is required</p>',
  );
  let invalidate;
  try {
    const wrapped = h.w.JobsAutomatic.observe({
      getProfile: async () => h.profile,
      setMessage: (phase) => h.phases.push(phase),
      ctx: { onInvalidated: (fn) => (invalidate = fn) },
    });
    await wrapped.getProfile();
    wrapped.setMessage("page-complete");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.phases.at(-1), "complete-required");
    h.w.document.querySelector("input").removeAttribute("aria-invalid");
    h.w.document.querySelector('[data-automation-id="inputAlert"]').remove();
    await h.w.JobsDOMWait.until(() => h.phases.at(-1) === "page-complete", {
      timeout: 1000,
      interval: 10,
    });
    assert.equal(h.phases.at(-1), "page-complete");
    assert.equal(h.calls(), 0);
    assert.equal(h.clicks(), 0);
    invalidate();
  } finally {
    h.close();
  }
});
