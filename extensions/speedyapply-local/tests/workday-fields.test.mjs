import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const load = async (name) =>
  readWithDependencies(
    new URL("../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const [fields, workday, wait, presenter, review] = await Promise.all(
  [
    "control-fields",
    "workday-controls",
    "dom-wait",
    "review-presenter",
    "ai-review",
  ].map(load),
);
const pill = (label) =>
  `<li><div data-automation-id="selectedItem"><p data-automation-id="promptOption">${label}</p></div></li>`;
const prompt = (id, label, selection = "") =>
  `<label for="${id}">${label}</label><div data-automation-id="multiSelectContainer"><input id="${id}" data-uxi-widget-type="selectinput" aria-required="true" aria-invalid="false" value=""><ul data-automation-id="selectedItemList">${selection ? pill(selection) : ""}</ul></div>`;
function setup(html) {
  const dom = new JSDOM("<form>" + html + "</form>", {
      url: "https://employer.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    }),
    w = dom.window;
  w.chrome = { runtime: { onMessage: { addListener() {} } } };
  w.eval(fields);
  w.eval(workday);
  w.eval(wait);
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options) =>
    until(read, { ...options, timeout: 30 });
  return {
    w,
    reader: w.JobsControlFields.create(
      w.document,
      () => w.document.querySelector("form"),
      { write: true },
    ),
    close: () => w.close(),
  };
}

test("Workday committed pills are answers, blank search inputs and typed search terms are not answers", async () => {
  const h = setup(
    prompt(
      "school",
      "School or University",
      "University of California-Berkeley",
    ) +
      prompt("major", "Field of Study", "Applied Physics") +
      prompt("other", "Other school"),
  );
  try {
    h.w.document.querySelector("#other").value = "Unselected search";
    let rows = h.reader.scan();
    assert.equal(rows.length, 3);
    assert.equal(
      h.reader.response(rows[0]).response,
      "University of California-Berkeley",
    );
    assert.equal(h.reader.response(rows[1]).response, "Applied Physics");
    assert.equal(rows[0].public.filled, true);
    assert.equal(rows[0].public.supported, true);
    assert.equal(h.w.JobsControlFields.complete(rows[0].public), true);
    assert.equal(rows[2].public.filled, false);
    assert.equal(h.reader.response(rows[2]), null);
    assert.equal(h.w.JobsControlFields.complete(rows[2].public), false);
    await assert.rejects(
      h.reader.apply(rows[2], "Invented selection"),
      /not committed/,
    );
    h.w.document.querySelector("#school").setAttribute("aria-invalid", "true");
    rows = h.reader.scan();
    assert.equal(h.reader.response(rows[0]), null);
    assert.equal(h.w.JobsControlFields.complete(rows[0].public), false);
  } finally {
    h.close();
  }
});

test("optional Workday currently-work-here stays unchecked without dates and is never an AI candidate", () => {
  const h = setup(
    '<div data-automation-id="formField-currentlyWorkHere"><label>I currently work here<input type="checkbox" aria-required="false"></label></div><label>Other question<input type="checkbox"></label>',
  );
  try {
    const [current, other] = h.reader.scan();
    assert.equal(current.node.checked, false);
    assert.equal(current.public.supplement, false);
    assert.equal(h.w.JobsControlFields.needsAnswer(current.public), false);
    assert.equal(h.w.JobsControlFields.complete(current.public), true);
    assert.equal(
      h.w.JobsControlFields.needsAnswer(other.public),
      false,
      "other optional Workday questions also stay out of supplemental AI",
    );
    current.node.required = true;
    assert.equal(
      h.w.JobsControlFields.needsAnswer(h.reader.scan()[0].public),
      true,
      "an actual required field stays visible",
    );
  } finally {
    h.close();
  }
});

test("review updates when a Workday pill changes without an input/change event", async () => {
  const h = setup(prompt("school", "School or University", "Berkeley"));
  try {
    h.w.eval(presenter);
    h.w.eval(review);
    h.w.JobsAIReview.add(
      h.w.document.querySelector("form"),
      h.reader,
      h.reader.scan()[0],
      { source: "profile" },
    );
    const card = h.w.document.querySelector("#jobs-ai-review").shadowRoot;
    assert.equal(card.querySelector(".answer").textContent, "Berkeley");
    h.w.document.querySelector(
      '[data-automation-id="selectedItemList"]',
    ).innerHTML = pill("Updated school");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(card.querySelector(".answer").textContent, "Updated school");
    h.w.document.querySelector(
      '[data-automation-id="selectedItemList"]',
    ).innerHTML = "";
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(card.querySelector(".answer").textContent, "待补充");
  } finally {
    h.close();
  }
});
