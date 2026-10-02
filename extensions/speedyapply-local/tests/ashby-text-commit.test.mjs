import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="root"></div>', {
  url: "https://jobs.ashbyhq.com/fixture",
  runScripts: "outside-only",
});
const w = dom.window;
Object.assign(globalThis, {
  window: w,
  document: w.document,
  HTMLElement: w.HTMLElement,
});
const React = await import("react"),
  { createRoot } = await import("react-dom/client"),
  { flushSync } = await import("react-dom");
w.eval(
  await readWithDependencies(
    new URL("../src/custom/control-fields.js", import.meta.url),
    "utf8",
  ),
);
w.eval(
  await readWithDependencies(
    new URL("../src/custom/ashby-controls.js", import.meta.url),
    "utf8",
  ),
);

// Ashby's public Jje/Gj text control maintains a draft, saves on blur and
// debounces saving by 500ms otherwise. Blur reads rendered state, not DOM value.
test("Ashby text writer flushes the rendered draft before blur instead of relying on the debounce", async () => {
  const saves = [];
  function Field() {
    const [draft, setDraft] = React.useState("");
    const timer = React.useRef();
    const save = () => {
      if (draft) saves.push(draft);
    };
    React.useEffect(() => {
      timer.current = setTimeout(save, 500);
      return () => clearTimeout(timer.current);
    }, [draft]);
    return React.createElement("input", {
      id: "name",
      "aria-label": "First Name",
      value: draft,
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => {
        clearTimeout(timer.current);
        save();
      },
    });
  }
  const root = createRoot(w.document.getElementById("root"));
  try {
    flushSync(() => root.render(React.createElement(Field)));
    await chooseAnswer(w.document.getElementById("name"), "Fixture Applicant");
    assert.deepEqual(
      saves,
      ["Fixture Applicant"],
      "saving must start before the adapter reports completion",
    );
  } finally {
    flushSync(() => root.unmount());
  }
});
