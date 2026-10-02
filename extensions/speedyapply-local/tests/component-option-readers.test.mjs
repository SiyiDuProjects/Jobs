import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("an unconfirmed component neither queues AI again nor becomes required-empty", async () => {
  const dom = new JSDOM('<form><input id="control"></form>', {
    url: "https://fixture.example/apply",
    runScripts: "outside-only",
  });
  const w = dom.window,
    node = w.document.querySelector("input");
  w.JobsMenuControls = {
    find: () => [node],
    isControl: (other) => other === node,
    describe: () => ({
      question: "Question*",
      type: "combobox",
      value: "",
      required: true,
      requiredKnown: true,
      supported: true,
      readable: false,
      commitState: "unconfirmed",
      group: [node],
    }),
  };
  try {
    w.eval(
      await readWithDependencies(
        new URL("../src/custom/control-fields.js", import.meta.url),
        "utf8",
      ),
    );
    const reader = w.JobsControlFields.create(
        w.document,
        () => w.document.querySelector("form"),
        { write: true },
      ),
      state = reader.state();
    assert.equal(state.rows.length, 1);
    assert.equal(state.invalid.length, 0);
    assert.equal(state.ready, false);
    assert.equal(state.blockers[0].reason, "unconfirmed");
    assert.equal(w.JobsControlFields.needsAnswer(state.rows[0].public), false);
    assert.equal(reader.response(state.rows[0]), null);
    await assert.rejects(
      reader.apply(state.rows[0], "Answer"),
      /no longer an editable empty control/,
    );
  } finally {
    w.close();
  }
});
