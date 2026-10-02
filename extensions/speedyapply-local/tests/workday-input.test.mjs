import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

// React must initialize after the DOM exists; asserting input.value alone
// would miss the original regression, whose visible value was already right.
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://fixture.myworkdayjobs.com/",
  runScripts: "outside-only",
});
const w = dom.window;
Object.assign(globalThis, {
  window: w,
  document: w.document,
  HTMLElement: w.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
w.eval(
  await readWithDependencies(
    new URL("../src/custom/control-fields.js", import.meta.url),
    "utf8",
  ),
);
w.eval(
  await readWithDependencies(
    new URL("../src/custom/workday-controls.js", import.meta.url),
    "utf8",
  ),
);
w.DataTransfer = class {
  items = new Map();
  setData(type, value) {
    this.items.set(type, value);
  }
  getData(type) {
    return this.items.get(type) || "";
  }
};
w.ClipboardEvent = class extends w.Event {
  constructor(type, options) {
    super(type, options);
    this.clipboardData = options.clipboardData;
  }
};
// A Workday text field is one binding, as the adapters declare it.
const write = (value, field) =>
  w.JobsFormPipeline.bind([
    { name: "field", find: field, answer: value, replace: true },
  ]);

test("Workday text bindings commit into React state, including previously visible but uncommitted values", async () => {
  try {
    for (const company of [false, true])
      for (const poisoned of [false, true])
        for (const tag of ["input", "textarea"]) {
          const state = { value: "", changes: 0, paste: [], diagnostics: 0 };
          function App() {
            const [value, set] = React.useState("");
            state.value = value;
            return React.createElement(tag, {
              id: "field",
              "data-automation-id": company ? "company" : "jobTitle",
              value,
              onChange: (e) => {
                state.changes++;
                set(e.target.value);
              },
            });
          }
          const root = createRoot(w.document.getElementById("root"));
          await React.act(() => root.render(React.createElement(App)));
          const input = w.document.getElementById("field");
          input.addEventListener("paste", (event) =>
            state.paste.push(event.clipboardData.getData("text/plain")),
          );
          w.JobsDiagnostics = {
            note: () => {},
            trace: (node, entry) => {
              if (
                entry.source?.startsWith("binding:") &&
                entry.result === "committed"
              ) {
                assert.equal(node, input);
                state.diagnostics++;
              }
            },
          };
          if (poisoned) {
            await React.act(() => {
              input.value = "Example Company";
              input.dispatchEvent(new w.Event("input", { bubbles: true }));
            });
            assert.equal(input.value, "Example Company");
            assert.equal(state.value, "");
            assert.equal(state.changes, 0);
          }
          await React.act(async () => {
            await write("Example Company", '//*[@id="field"]');
          });
          assert.equal(
            state.value,
            "Example Company",
            `company=${company}/${tag}/poisoned=${poisoned}: submitted model must update`,
          );
          assert.equal(state.changes, 1);
          assert.equal(state.diagnostics, 1);
          assert.equal(input.value, "Example Company");
          assert.deepEqual(
            state.paste,
            company && tag === "input" ? ["Example Company"] : [],
            "the registered company input owns paste; ordinary textareas use the shared text commit",
          );
          await React.act(async () => {
            await write("", "#field");
          });
          assert.equal(
            state.value,
            "Example Company",
            "missing profile text must not erase an existing value",
          );
          assert.equal(input.value, "Example Company");
          assert.equal(state.changes, 1);
          await React.act(() => root.unmount());
        }
  } finally {
    dom.window.close();
  }
});
