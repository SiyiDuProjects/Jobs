import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const codes = await Promise.all(
  ["control-fields", "review-presenter", "ai-review"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function setup() {
  const dom = new JSDOM(
    `<form><div data-automation-id="formField-date"><fieldset><legend>Available date *</legend><div data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<input data-automation-id="dateSection${part}-input">`).join("")}</div></fieldset></div></form>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    listeners = [],
    writes = [];
  w.chrome = {
    runtime: {
      id: "fixture",
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    w.HTMLInputElement.prototype,
    "value",
  );
  Object.defineProperty(w.HTMLInputElement.prototype, "value", {
    ...descriptor,
    set(value) {
      if (this.type === "date") writes.push(value);
      descriptor.set.call(this, value);
    },
  });
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("form"),
    reader = w.JobsControlFields.create(w.document, () => root, {
      write: true,
    });
  w.JobsAIReview.add(root, reader, reader.scan()[0], { needsInput: true });
  w.JobsAIReview.ready(async () => {}, "fill");
  const shadow = () => w.document.querySelector("#jobs-ai-review").shadowRoot;
  return {
    w,
    reader,
    listeners,
    writes,
    shadow,
    editor: () => shadow().querySelector("input"),
    async setParts(values) {
      [...root.querySelectorAll("input")].forEach((node, index) => {
        node.value = values[index];
      });
      root
        .querySelector("input")
        .dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close: () => w.close(),
  };
}

test("Workday partial date typing never sends masked or invalid dates into the review date input", async () => {
  const h = setup();
  try {
    for (const parts of [
      ["1", "", ""],
      ["12", "", ""],
      ["12", "2", ""],
      ["12", "23", "1"],
      ["12", "23", ""],
      ["12", "23", "2"],
      ["12", "23", "20"],
      ["12", "23", "202"],
      ["2", "30", "2027"],
    ]) {
      await h.setParts(parts);
      assert.equal(h.editor().value, "");
      assert.deepEqual(
        [...h.w.document.querySelectorAll("form input")].map(
          (node) => node.value,
        ),
        parts,
        "review must not change the page while typing",
      );
      assert.equal(h.reader.scan()[0].public.invalid, true);
    }
    assert(
      h.writes.every((value) => value === ""),
      "invalid source values must never reach the native setter",
    );
    await h.setParts(["12", "23", "2027"]);
    assert.equal(h.editor().value, "2027-12-23");
    assert.equal(h.reader.scan()[0].public.invalid, false);
    await h.setParts(["", "", ""]);
    assert.equal(
      h.editor().value,
      "",
      "cleared source must clear the mirrored date",
    );
  } finally {
    h.close();
  }
});

test("review normalizes complete dates from relayed rows and rejects incomplete or impossible ones", () => {
  const h = setup();
  try {
    h.w.JobsAIReview.release(h.w.document.querySelector("form"));
    h.writes.length = 0;
    for (const [value, expected] of [
      ["12/23/2027", "2027-12-23"],
      ["2028-02-29", "2028-02-29"],
      ["2027-02-29", ""],
      ["12/23/20", ""],
      ["0000-01-01", ""],
      [null, ""],
    ]) {
      for (const listener of h.listeners)
        listener(
          {
            type: "jobs:review-view",
            id: "date",
            sourceDocumentId: "frame",
            data: {
              id: "date",
              items: [
                {
                  id: "0",
                  question: "Available date",
                  editor: {
                    kind: "text",
                    inputType: "date",
                    value,
                    version: 1,
                  },
                },
              ],
            },
          },
          { id: "fixture" },
          () => {},
        );
      assert.equal(h.editor().value, expected);
    }
    assert.deepEqual(h.writes, ["2027-12-23", "2028-02-29", "", "", "", ""]);
  } finally {
    h.close();
  }
});

test("a review date draft survives source typing and cannot overwrite a newer source date", async () => {
  const h = setup();
  try {
    h.editor().value = "2028-01-05";
    h.editor().oninput();
    await h.setParts(["12", "23", "20"]);
    assert.equal(h.editor().value, "2028-01-05");
    await h.setParts(["12", "23", "2027"]);
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(
      h.shadow().querySelector(".error").textContent,
      /页面选项已变化/,
    );
    assert.equal(h.reader.scan()[0].raw, "2027-12-23");
  } finally {
    h.close();
  }
});
