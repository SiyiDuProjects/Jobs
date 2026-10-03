import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const code = (
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "response-contract",
      "control-fields",
      "answer-memory",
    ].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");

test("typing reuses discovery but reads current values, validity, labels and replacement fields", async () => {
  const dom = new JSDOM(
    "<form>" +
      Array.from(
        { length: 120 },
        (_, i) => `<label>Question ${i}<input id="f${i}"></label>`,
      ).join("") +
      "</form>",
    {
      url: "https://jobs.ashbyhq.com/example/job/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    root = doc.querySelector("form"),
    handlers = {},
    saved = [];
  const on = root.addEventListener.bind(root);
  root.addEventListener = (type, fn, ...args) => {
    handlers[type] = fn;
    on(type, fn, ...args);
  };
  w.eval(code);
  w.JobsPageSession = { profile: () => ({}) };
  const memory = w.JobsAnswerMemory.start(root, true, async (rows) =>
    saved.push(...rows),
  );
  const input = doc.querySelector("input");
  const fire = (type, node = input) =>
    handlers[type]({ type, target: node, isTrusted: true, key: "x" });
  try {
    for (let i = 0; i < 20; i++) {
      fire("keydown");
      input.value += "x";
      fire("input");
    }
    memory.flush();
    await Promise.resolve();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].response, "x".repeat(20));
    assert(
      w.JobsControlFields.scans() <= 3,
      "keystrokes must not rescan the whole form",
    );
    input.setCustomValidity("Rejected");
    fire("input");
    memory.flush();
    await Promise.resolve();
    assert.equal(
      saved.length,
      1,
      "property-only validity changes invalidate a pending answer",
    );
    input.setCustomValidity("");
    input.parentNode.firstChild.textContent = "Updated question";
    fire("input");
    memory.flush();
    await Promise.resolve();
    assert.equal(saved.at(-1).question, "Updated question");
    const replacement = input.cloneNode();
    replacement.value = "Replacement value";
    input.replaceWith(replacement);
    fire("input", replacement);
    memory.flush();
    await Promise.resolve();
    assert.equal(saved.at(-1).response, "Replacement value");
    assert.equal(saved.at(-1).question, "Updated question");
  } finally {
    memory.stop({ discard: true });
    w.close();
  }
});

test("narrow reads preserve native radio grouping and current property-only selection", () => {
  const dom = new JSDOM(
    '<form><fieldset><legend>Schedule</legend><label>Day<input type="radio" name="schedule"></label><label>Night<input type="radio" name="schedule"></label></fieldset></form>',
    { runScripts: "outside-only" },
  );
  try {
    const w = dom.window;
    w.eval(code);
    const reader = w.JobsControlFields.create(w.document);
    const row = reader.scan()[0];
    w.document.querySelectorAll("input")[1].checked = true;
    assert.equal(reader.response(reader.read(row)).response, "Night");
  } finally {
    dom.window.close();
  }
});
