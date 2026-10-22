import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { functionBlock } from "./helpers/module-source.mjs";
const source = functionBlock(
  await readFile(
    new URL("../source/content/shell.js", import.meta.url),
    "utf8",
  ),
  "installLinkedInTracking",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("LinkedIn observes changed receipts once without rescanning unrelated page content", async (t) => {
  const dom = new JSDOM("<body><main></main><h2>Application</h2></body>", {
    url: "https://www.linkedin.com/jobs/view/123/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    sent = [];
  w.send = async (message) => sent.push(message);
  w.extractJob = () => ({ title: "Synthetic role" });
  w.eval(source);
  let invalidate;
  w.installLinkedInTracking({
    onInvalidated: (fn) => {
      invalidate = fn;
    },
  });
  w.document.querySelectorAll = () => {
    throw Error("Whole document scan");
  };
  for (let i = 0; i < 50; i++)
    w.document.querySelector("main").append(w.document.createElement("span"));
  await tick();
  assert.equal(sent.length, 0);
  w.document.querySelector("h2").firstChild.data = "Application submitted";
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jobLink, "https://www.linkedin.com/jobs/view/123/");
  w.document.querySelector("h2").textContent = "Your application was sent";
  await tick();
  assert.equal(sent.length, 1);
  invalidate();
});
