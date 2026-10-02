import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
test("stable representative form reuses discovery and re-reads current values; mutations invalidate immediately", (t) => {
  const w = new JSDOM(
    "<form>" +
      Array.from(
        { length: 60 },
        (_, i) =>
          `<label>Question ${i}<input id="field-${i}" required></label>`,
      ).join("") +
      "</form>",
    { url: "https://fixture.test", runScripts: "outside-only" },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  const api = w.JobsControlFields,
    root = w.document.querySelector("form");
  function sample(cache) {
    const before = api.structuralScans(),
      start = performance.now();
    for (let i = 0; i < 40; i++)
      api.create(w.document, () => root, { cache }).scan();
    return {
      structuralScans: api.structuralScans() - before,
      ms: performance.now() - start,
    };
  }
  const before = sample(false),
    after = sample(true);
  assert.equal(before.structuralScans, 40);
  assert(after.structuralScans <= 1);
  const input = root.querySelector("input");
  input.value = "Manual value without synthetic event";
  assert.equal(api.create(w.document, () => root).scan()[0].raw, input.value);
  root.insertAdjacentHTML(
    "beforeend",
    '<label>Conditional<select required><option value="">Select</option><option>Yes</option></select></label>',
  );
  assert.equal(api.create(w.document, () => root).scan().length, 61);
  t.diagnostic(
    JSON.stringify({
      sample: "60 required fields / 40 repeated readers",
      before,
      after,
      target: "at least 90% fewer structural scans on stable pages",
    }),
  );
});
