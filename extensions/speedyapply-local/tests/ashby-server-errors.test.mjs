import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const summary =
  '<div role="alert"><h2>Your form needs corrections</h2><ul><li>Missing entry for required field: <button type="button">Name</button></li></ul></div>';
function fixture(body, url = "https://jobs.ashbyhq.com/fixture/application") {
  const dom = new JSDOM("<form>" + body + "</form>", {
    url,
    runScripts: "outside-only",
  });
  dom.window.eval(source);
  return {
    dom,
    doc: dom.window.document,
    reader: dom.window.JobsControlFields.create(dom.window.document, () =>
      dom.window.document.querySelector("form"),
    ),
  };
}
test("Ashby server error blocks a filled native-valid field until the actual error is removed", () => {
  const f = fixture(
    summary + '<label>Name*<input required value="Fixture Applicant"></label>',
  );
  try {
    assert.equal(f.doc.querySelector("input").validity.valid, true);
    let state = f.reader.state();
    assert.equal(state.ready, false);
    assert.equal(state.phase, "complete-required");
    assert.equal(state.rows[0].public.invalid, true);
    assert.equal(state.rows[0].public.filled, true);
    assert.equal(state.errors.length, 1);
    assert.equal(
      f.dom.window.JobsControlFields.needsAnswer(state.rows[0].public),
      false,
      "do not replace an existing answer with AI",
    );
    f.doc.querySelector('[role="alert"]').remove();
    state = f.reader.state();
    assert.equal(state.ready, true);
    assert.equal(state.rows[0].public.invalid, false);
  } finally {
    f.dom.window.close();
  }
});
test("Ashby server summary blocks but does not guess which duplicate label owns an error", () => {
  const f = fixture(
    summary +
      '<label>Name*<input value="First"></label><label>Name*<input value="Second"></label>',
  );
  try {
    const state = f.reader.state();
    assert.equal(state.ready, false);
    assert(state.rows.every((row) => !row.public.invalid));
  } finally {
    f.dom.window.close();
  }
});
test("ordinary alerts, hidden errors and non-Ashby content do not acquire Ashby error semantics", () => {
  for (const [alert, url] of [
    [
      '<div role="alert">Resume uploaded successfully</div>',
      "https://jobs.ashbyhq.com/fixture",
    ],
    [
      summary.replace('role="alert"', 'role="alert" hidden'),
      "https://jobs.ashbyhq.com/fixture",
    ],
    [summary, "https://example.test/form"],
  ]) {
    const f = fixture(
      alert + '<label>Name*<input required value="Fixture Applicant"></label>',
      url,
    );
    try {
      assert.equal(f.reader.state().ready, true);
    } finally {
      f.dom.window.close();
    }
  }
});
