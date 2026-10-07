import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
function fixture({
  modern = false,
  accept = true,
  focus = "normal",
  edge = "start",
  normalized = false,
} = {}) {
  const dom = new JSDOM(
    `<form data-automation-id="${modern ? "ApplyFlowPage" : "applyFlowPage"}"><div data-automation-id="formField-${edge}Date"><label>From*</label><div id="date" data-automation-id="dateInputWrapper"><input id="month" role="spinbutton" data-automation-id="dateSectionMonth-input"><input id="year" role="spinbutton" data-automation-id="dateSectionYear-input"></div><p data-automation-id="inputAlert">The field From is required and must have a value.</p></div><label>Other (optional)<input id="outside" value="Keep"></label></form>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document;
  scripts.forEach((code) => w.eval(code));
  const node = doc.querySelector("#date"),
    parts = [doc.querySelector("#month"), doc.querySelector("#year")],
    draft = ["", ""];
  let stored = "",
    commits = 0,
    early = 0;
  parts.forEach((part, index) => {
    part.addEventListener("input", () => {
      const value = part.value;
      w.setTimeout(() => {
        draft[index] = normalized && value ? String(Number(value)) : value;
        part.value = draft[index];
      }, 0);
    });
    part.addEventListener("focusout", (event) => {
      if (node.contains(event.relatedTarget)) return;
      if (!draft.every(Boolean)) {
        early++;
        return;
      }
      if (accept) {
        stored = `${draft[1]}-${draft[0].padStart(2, "0")}`;
        commits++;
        doc.querySelector('[data-automation-id="inputAlert"]')?.remove();
      }
    });
    if (focus === "unavailable") part.focus = () => {};
  });
  if (focus === "redirected")
    parts[1].addEventListener("focus", () => parts[0].focus());
  return {
    w,
    doc,
    node,
    parts,
    stored: () => stored,
    commits: () => commits,
    early: () => early,
    reader: w.JobsControlFields.create(doc, () => doc.querySelector("form"), {
      write: true,
    }),
    close: () => w.close(),
  };
}
for (const modern of [false, true])
  for (const entrance of ["binding", "shared"])
    for (const focus of ["normal", "unavailable", "redirected"])
      test(`Workday month ${entrance} commits after both parts settle (${modern ? "modern" : "standard"}, ${focus})`, async () => {
        const h = fixture({ modern, focus, normalized: true });
        try {
          if (entrance === "binding")
            assert(
              (
                await h.w.JobsFormPipeline.bind([
                  {
                    name: "employment-date",
                    find: () => h.node,
                    answer: "2031-05",
                    replace: true,
                  },
                ])
              )[0],
            );
          else await h.reader.apply(h.reader.scan()[0], "2031-05");
          assert.equal(
            h.stored(),
            "2031-05",
            "visible values must reach the form model before success",
          );
          assert.equal(h.commits(), 1, "one complete group commit");
          assert.equal(h.early(), 0, "never leave the group while incomplete");
          assert.equal(h.reader.state().ready, true);
          assert.equal(h.doc.querySelector("#outside").value, "Keep");
        } finally {
          h.close();
        }
      });
for (const modern of [false, true])
  test(`Workday month refuses populated segments with a persistent outer error (${modern})`, async () => {
    const h = fixture({ modern, accept: false, edge: "end" });
    try {
      await assert.rejects(h.reader.apply(h.reader.scan()[0], "2031-10"));
      assert.equal(h.stored(), "");
      assert.equal(h.reader.scan()[0].public.invalid, true);
      assert.equal(h.reader.state().ready, false);
    } finally {
      h.close();
    }
  });
for (const mode of ["cancel", "replace", "edit"])
  test(`Workday month stops on ${mode} before another segment or final commit`, async () => {
    const h = fixture();
    let live = true;
    try {
      const pending = h.reader.apply(h.reader.scan()[0], "2031-10", () => live);
      if (mode === "cancel") live = false;
      if (mode === "replace")
        h.parts[1].replaceWith(h.parts[1].cloneNode(true));
      if (mode === "edit") {
        h.parts[0].value = "12";
        h.parts[0].dispatchEvent(new h.w.Event("input", { bubbles: true }));
      }
      await assert.rejects(pending);
      assert.equal(h.stored(), "");
      assert.equal(h.parts[1].value, "");
    } finally {
      h.close();
    }
  });
