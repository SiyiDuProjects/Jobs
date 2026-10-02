import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const scripts = await Promise.all(
  ["dom-wait", "control-fields", "workday-controls"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);

// Models delayed input processing followed by a focusout model commit. The
// observed Priceline error clears on focus/Tab without changing company text.
for (const entrance of ["binding", "shared"])
  for (const focus of ["normal", "unavailable", "redirected"]) {
    test(`Company ${entrance} waits for acceptance with ${focus} focus`, async () => {
      const dom = new JSDOM(
          '<div data-automation-id="formField-companyName"><label for="company">Company*</label><input id="company" name="companyName" aria-required="true"></div><button>Other</button>',
          {
            url: "https://fixture.myworkdayjobs.com/apply",
            runScripts: "outside-only",
          },
        ),
        w = dom.window;
      w.DataTransfer = class {
        setData(_type, value) {
          this.value = value;
        }
        getData() {
          return this.value;
        }
      };
      w.ClipboardEvent = class extends w.Event {
        constructor(type, options) {
          super(type, options);
          this.clipboardData = options.clipboardData;
        }
      };
      scripts.forEach((source) => w.eval(source));
      const node = w.document.querySelector("input"),
        other = w.document.querySelector("button"),
        pastes = [];
      let draft = "",
        stored = "";
      node.addEventListener("input", () => {
        const value = node.value;
        w.setTimeout(() => {
          draft = value;
        }, 0);
      });
      node.addEventListener("focusout", () => {
        stored = draft;
        node.setAttribute("aria-invalid", stored ? "false" : "true");
      });
      node.addEventListener("paste", (event) =>
        pastes.push(event.clipboardData.getData("text/plain")),
      );
      if (focus === "unavailable") node.focus = () => {};
      if (focus === "redirected")
        node.addEventListener("focus", () => other.focus());
      try {
        if (entrance === "binding")
          await w.JobsFormPipeline.bind([
            {
              name: "company",
              find: "#company",
              answer: "Example Company",
              replace: true,
            },
          ]);
        else {
          const reader = w.JobsControlFields.create(
            w.document,
            () => w.document,
            { write: true },
          );
          await reader.apply(reader.scan()[0], "Example Company");
        }
        assert.equal(node.value, "Example Company");
        assert.equal(
          stored,
          "Example Company",
          "visible text must not outrun the form model",
        );
        assert.equal(node.getAttribute("aria-invalid"), "false");
        assert.deepEqual(pastes, ["Example Company"]);
      } finally {
        w.close();
      }
    });
  }
