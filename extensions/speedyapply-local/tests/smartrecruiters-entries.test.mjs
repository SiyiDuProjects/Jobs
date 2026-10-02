import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { readModule } from "./helpers/module-source.mjs";

const sources = await Promise.all(
  ["dom-wait", "control-fields", "form-pipeline"].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const adapter = await readModule(
  new URL("../source/content/adapters/smartrecruiters.js", import.meta.url),
  "utf8",
);

test("SmartRecruiters keeps a replaced field in its entry but never follows another entry", async () => {
  const w = new JSDOM(
    "<form><oc-education-entry><label>Degree<input></label></oc-education-entry></form>",
    {
      url: "https://jobs.smartrecruiters.com/fixture",
      runScripts: "outside-only",
    },
  ).window;
  try {
    sources.forEach((s) => w.eval(s));
    const root = w.document.querySelector("form");
    const entry = root.firstElementChild;
    const first = entry.querySelector("input");
    const book = w.JobsFormPipeline.ledger(root);
    assert.equal(
      (
        await w.JobsFormPipeline.write(
          first,
          { value: "First degree" },
          { ledger: book, root, decider: "binding:degree" },
        )
      ).ok,
      true,
    );
    const replacement = first.cloneNode();
    replacement.value = first.value;
    first.replaceWith(replacement);
    assert.equal(book.peek(replacement)?.state, "decided");
    entry.remove();
    const second = w.document.createElement("oc-education-entry");
    second.innerHTML = "<label>Degree<input></label>";
    root.append(second);
    const next = second.querySelector("input");
    assert.equal(book.peek(next), null);
    assert.equal(
      (
        await w.JobsFormPipeline.write(
          next,
          { value: "Second degree" },
          { ledger: book, root, decider: "binding:degree" },
        )
      ).ok,
      true,
    );
    assert.equal(next.value, "Second degree");
  } finally {
    w.close();
  }
});

for (const saved of [true, false])
  test(`SmartRecruiters entry Save ${saved ? "advances with scoped bindings" : "holds without creating a second editor"}`, async () => {
    const w = new JSDOM(
      '<section data-test="experience"><button data-test="add-experience">Add</button></section>',
      {
        url: "https://jobs.smartrecruiters.com/fixture",
        runScripts: "outside-only",
      },
    ).window;
    try {
      sources.forEach((s) => w.eval(s));
      const until = w.JobsDOMWait.until;
      w.JobsDOMWait.until = (read, options) =>
        until(read, { ...options, timeout: 60 });
      w.jobsClick = (selector) =>
        w.JobsPageActions.click(w.document.querySelector(selector));
      w.eval(adapter);
      let adds = 0,
        saves = 0;
      const values = [];
      w.document.querySelector("button").onclick = () => {
        adds++;
        const entry = w.document.createElement("oc-experience-entry");
        entry.innerHTML =
          '<div data-test="experience-edit-form"><label>Title<input></label><button data-test="experience-save">Save</button></div>';
        w.document.querySelector("section").append(entry);
        entry.querySelector("button").onclick = () => {
          saves++;
          values.push(entry.querySelector("input").value);
          if (saved)
            entry.querySelector('[data-test="experience-edit-form"]').remove();
        };
      };
      const root = w.document.querySelector("section");
      const result = await w.JobsFormPipeline.within(
        {
          root,
          ledger: w.JobsFormPipeline.ledger(root),
          canProceed: () => true,
        },
        () =>
          w.smartrecruitersAddEntries(
            "experience",
            ["First", "Second"],
            (value) => [{ name: "title", find: "input", answer: value }],
          ),
      );
      assert.equal(adds, saved ? 2 : 1);
      assert.equal(saves, saved ? 2 : 1);
      assert.deepEqual(values, saved ? ["First", "Second"] : ["First"]);
      assert.equal(!!result?.hold, !saved);
      if (!saved) {
        await w.smartrecruitersAddEntries("experience", ["Replacement"], () => {
          throw Error("must preserve open editor");
        });
        assert.equal(adds, 1);
        assert.equal(w.document.querySelector("input").value, "First");
      }
    } finally {
      w.close();
    }
  });
