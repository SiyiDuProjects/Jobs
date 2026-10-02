import { runAnswerStage } from "./helpers/answer-stage.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const scripts = await Promise.all(
  [
    "dom-wait",
    "control-fields",
    "workday-controls",
    "ashby-controls",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const group = (question, options, selected = []) =>
  `<fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title">${question}</label>${options.map((label, i) => `<label>${label}<input type="checkbox" ${selected.includes(i) ? "checked" : ""}></label>`).join("")}</fieldset>`;
function setup(html) {
  const dom = new JSDOM(`<form>${html}</form>`, {
    url: "https://jobs.ashbyhq.com/fixture/application",
    runScripts: "outside-only",
  });
  scripts.forEach((source) => dom.window.eval(source));
  return {
    w: dom.window,
    doc: dom.window.document,
    reader: dom.window.JobsControlFields.create(
      dom.window.document,
      () => dom.window.document,
      { write: true },
    ),
  };
}
test("two Ashby checkbox questions stay two multiple-choice fields, not fifteen boolean questions", () => {
  const h = setup(
    group(
      "Which ethnicity(ies)? Select all that apply.",
      Array.from({ length: 8 }, (_, i) => "Ethnicity " + i),
      [0],
    ) +
      group(
        "Which communities? Select all that apply.",
        Array.from({ length: 7 }, (_, i) => "Community " + i),
      ),
  );
  try {
    const rows = h.reader.scan();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      Array.from(rows, (r) => r.public.type),
      ["select-multiple", "select-multiple"],
    );
    assert.deepEqual(
      Array.from(rows, (r) => r.public.options.length),
      [8, 7],
    );
    assert.equal(h.reader.response(rows[0]).response, "Ethnicity 0");
    assert.equal(h.w.JobsControlFields.needsAnswer(rows[0].public), false);
    assert.equal(h.w.JobsControlFields.needsAnswer(rows[1].public), false);
  } finally {
    h.w.close();
  }
});
test("group apply uses option clicks, preserves existing answers by default and supports exact review replacement", async () => {
  const h = setup(group("Tools", ["A", "B", "C"]));
  try {
    let changes = 0;
    h.doc.querySelector("fieldset").addEventListener("change", () => changes++);
    const row = h.reader.scan()[0],
      values = [row.public.options[0].value, row.public.options[2].value];
    await h.reader.apply(row, values);
    assert.equal(changes, 2);
    const after = h.reader.scan()[0];
    assert.equal(h.reader.response(after).response, "A; C");
    await assert.rejects(
      h.reader.apply(after, [row.public.options[1].value]),
      /editable empty/,
    );
    await h.reader.apply(after, [row.public.options[1].value], () => true, {
      replace: true,
    });
    assert.equal(h.reader.response(h.reader.scan()[0]).response, "B");
    assert.equal(h.reader.scan()[0].public.id, row.public.id);
  } finally {
    h.w.close();
  }
});
test("a group rejects unknown, disabled or replaced options before changing any checkbox", async () => {
  for (const cause of ["unknown", "disabled", "replaced"]) {
    const h = setup(group("Tools", ["A", "B"]));
    try {
      const row = h.reader.scan()[0];
      const values = row.public.options.map((o) => o.value);
      if (cause === "unknown") values.push("not-an-option");
      if (cause === "disabled") row.group[1].disabled = true;
      if (cause === "replaced")
        row.group[1].replaceWith(row.group[1].cloneNode());
      await assert.rejects(h.reader.apply(row, values));
      assert.equal(h.doc.querySelectorAll("input:checked").length, 0);
    } finally {
      h.w.close();
    }
  }
});
test("separate consent boxes and native multiple selects retain their existing semantics", () => {
  const h = setup(
    group("Tools", ["A", "B"]) +
      '<label>I agree<input type="checkbox" required></label><label>Locations<select multiple><option value="a" selected>A</option></select></label>',
  );
  try {
    assert.deepEqual(
      Array.from(h.reader.scan(), (r) => r.public.type),
      ["select-multiple", "checkbox", "select-multiple"],
    );
  } finally {
    h.w.close();
  }
});
test("the answer stage receives a grouped multi-select as one question with its options, never its fragments", async () => {
  const h = setup(
    group("Tools", ["A", "B"]) +
      '<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Consent</label><label>I agree<input type="checkbox"></label></div>',
  );
  try {
    let questions;
    await runAnswerStage(h.w, {
      root: h.doc.querySelector("form"),
      profile: {},
      resolveAnswers: async (q) => {
        questions = q;
        return [];
      },
    });
    assert.equal(questions.length, 2);
    assert.equal(questions[0].type, "select-multiple");
    assert.deepEqual(JSON.parse(JSON.stringify(questions[0].options)), [
      "A",
      "B",
    ]);
    assert.match(questions[1].question, /Consent/);
  } finally {
    h.w.close();
  }
});
