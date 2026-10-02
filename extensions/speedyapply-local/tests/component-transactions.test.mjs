import { readWithDependencies } from "./helpers/runtime-source.mjs";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const directory = new URL("../src/custom/", import.meta.url);
const names = (await fs.readdir(directory)).filter((name) =>
  name.endsWith("-controls.js"),
);
const source = await readWithDependencies(
  new URL("control-fields.js", directory),
  "utf8",
);

test("every registered component exposes one selection transaction and no answer trace", async () => {
  const dom = new JSDOM("", {
    url: "https://fixture.invalid",
    runScripts: "outside-only",
  });
  try {
    dom.window.eval(source);
    for (const name of names) {
      const content = await fs.readFile(new URL(name, directory), "utf8");
      assert(
        !/JobsDiagnostics\??\.trace/.test(content),
        name + " must let the shared entrance record the answer",
      );
      dom.window.eval(
        await readWithDependencies(new URL(name, directory), "utf8"),
      );
      const exported = content.match(/export var (Jobs\w+Controls)/)?.[1];
      assert(exported, name);
      const api = dom.window[exported];
      assert.equal(typeof api.chooseFrom, "function", name);
      assert.deepEqual(
        Object.keys(api).filter((key) => /^(?:choose|setInput)/.test(key)),
        ["chooseFrom"],
        name,
      );
    }
  } finally {
    dom.window.close();
  }
});

test("scalar, boolean, date and multiselect literals produce one verified common trace each", async () => {
  const dom = new JSDOM(
    `<form><label>First Name<input id="name"></label><label>Required acknowledgement<input type="checkbox" id="check" required></label><label>Start Date<input id="date" type="date"></label><label>Languages<select multiple id="multi"><option value="py">Python</option><option value="cpp">C++</option><option value="java">Java</option></select></label></form>`,
    { url: "https://fixture.invalid", runScripts: "outside-only" },
  );
  const w = dom.window,
    traces = [];
  try {
    w.eval(source);
    w.JobsDiagnostics = {
      trace: (_node, entry) => traces.push(entry),
      note() {},
    };
    const reader = w.JobsControlFields.create(
      w.document,
      () => w.document.querySelector("form"),
      { write: true },
    );
    const cases = [
      ["name", "Example", "Example"],
      ["check", true, "Yes"],
      ["date", "2027-05-18", "2027-05-18"],
      ["multi", ["py", "cpp"], "Python; C++"],
    ];
    for (const [id, value, expected] of cases) {
      const row = reader.scan().find((item) => item.node.id === id),
        before = traces.length;
      await reader.apply(row, value, () => true, {
        source: "review-card",
        reason: "Confirmed by owner",
      });
      assert.equal(
        reader.response(reader.scan().find((item) => item.node.id === id))
          .response,
        expected,
      );
      assert.equal(traces.length, before + 1, id + " records one transaction");
      assert.equal(traces.at(-1).result, "committed");
      assert.equal(traces.at(-1).source, "review-card");
      assert.equal(traces.at(-1).reason, "Confirmed by owner");
    }
    const row = reader.scan().find((item) => item.node.id === "multi");
    await assert.rejects(
      reader.apply(row, ["invented"], () => true, { replace: true }),
    );
    assert.equal(
      reader.response(reader.scan().find((item) => item.node.id === "multi"))
        .response,
      "Python; C++",
    );
    assert.equal(traces.at(-1).result, "no-matching-option");
  } finally {
    dom.window.close();
  }
});

test("independent checks in one fieldset keep their own boolean answer and preserve a different existing answer", async () => {
  const dom = new JSDOM(
    '<fieldset><legend>Available days</legend><label>Monday<input type="checkbox"></label><label>Tuesday<input type="checkbox"></label></fieldset>',
    { url: "https://fixture.invalid", runScripts: "outside-only" },
  );
  try {
    const w = dom.window,
      traces = [];
    w.eval(source);
    w.JobsDiagnostics = {
      trace: (_node, entry) => traces.push(entry),
      note() {},
    };
    const reader = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    const [monday, tuesday] = reader.scan();
    await reader.apply(monday, true);
    assert.equal(monday.node.checked, true);
    assert.equal(tuesday.node.checked, false);
    assert.equal(
      await w.JobsControlFields.chooseSpec(
        monday.node,
        w.JobsControlFields.literalSpec(monday.node, false),
      ),
      null,
    );
    assert.equal(monday.node.checked, true);
    assert.equal(traces.at(-1).result, "preserved-existing");
    await reader.apply(reader.scan()[0], false, () => true, { replace: true });
    assert.equal(monday.node.checked, false);
    assert.equal(traces.at(-1).result, "committed");
  } finally {
    dom.window.close();
  }
});
