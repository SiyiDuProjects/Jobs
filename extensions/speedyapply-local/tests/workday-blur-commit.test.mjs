import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="root"></div>', {
  url: "https://fixture.myworkdayjobs.com/apply",
  runScripts: "outside-only",
});
const w = dom.window;
Object.assign(globalThis, {
  window: w,
  document: w.document,
  HTMLElement: w.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = await import("react"),
  { createRoot } = await import("react-dom/client");
w.eval(
  await readWithDependencies(
    new URL("../src/custom/control-fields.js", import.meta.url),
    "utf8",
  ),
);

// Workday's downloaded TextAreaField uses defaultValue and updates its form
// model only in React onBlur. It has no onInput/onChange model update.
test("blur-only Workday textarea saves when focus is unavailable or redirected, without duplicate commits", async () => {
  try {
    for (const mode of ["normal", "unavailable", "redirected"]) {
      let value = "",
        commits = 0;
      const notes = [];
      w.JobsDiagnostics = { note: (type) => notes.push(type) };
      function Form() {
        const [stored, set] = React.useState("");
        value = stored;
        return React.createElement(
          React.Fragment,
          null,
          React.createElement("textarea", {
            id: "address",
            defaultValue: stored,
            onBlur: ({ target }) => {
              commits++;
              if (target.value !== stored) set(target.value);
            },
          }),
          React.createElement("button", { id: "other" }, "Other field"),
        );
      }
      const root = createRoot(w.document.getElementById("root"));
      await React.act(() => root.render(React.createElement(Form)));
      const node = w.document.getElementById("address"),
        other = w.document.getElementById("other");
      if (mode === "unavailable") node.focus = () => {};
      if (mode === "redirected")
        node.addEventListener("focus", () => other.focus());
      await React.act(async () => {
        await w.JobsControlFields.writeText(node, "Fixture address");
      });
      assert.equal(node.value, "Fixture address");
      assert.equal(
        value,
        "Fixture address",
        mode + ": visible text alone is not a saved answer",
      );
      assert.equal(
        commits,
        mode === "redirected" ? 2 : 1,
        mode +
          ": no second commit when native blur already fired after the write",
      );
      assert.equal(
        notes.filter((type) => type === "auto_text_commit_fallback").length,
        mode === "normal" ? 0 : 1,
      );
      await React.act(() => root.unmount());
    }
  } finally {
    dom.window.close();
  }
});

test("retained-focus searches and cancelled or detached writes never emit fallback commit", async () => {
  for (const mode of ["search", "cancelled", "detached"]) {
    const dom = new JSDOM("<textarea></textarea>", {
        runScripts: "outside-only",
      }),
      w = dom.window;
    w.eval(
      await readWithDependencies(
        new URL("../src/custom/control-fields.js", import.meta.url),
        "utf8",
      ),
    );
    const node = w.document.querySelector("textarea");
    let commits = 0,
      proceed = true;
    node.focus = () => {};
    node.addEventListener("focusout", () => commits++);
    node.addEventListener("input", () => {
      if (mode === "cancelled") proceed = false;
      if (mode === "detached") node.remove();
    });
    try {
      await w.JobsControlFields.writeText(node, "Fixture", {
        blur: mode !== "search",
        canProceed: () => proceed,
      });
      assert.equal(commits, 0, mode);
    } finally {
      dom.window.close();
    }
  }
});
