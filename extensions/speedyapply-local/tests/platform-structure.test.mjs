import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
const code = await readModule(
  new URL("../src/custom/platform-config.js", import.meta.url),
  "utf8",
);
function setup(html) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://jobs.example.com/apply",
  });
  dom.window.eval(code);
  return {
    dom,
    doc: dom.window.document,
    config: dom.window.JobsPlatformConfig,
  };
}
test("all 30 adapters have centrally declared form structure", () => {
  const { dom, config } = setup("");
  assert.equal(Object.keys(config.structure).length, 30);
  for (const [name, row] of Object.entries(config.structure))
    assert.ok(row.root || row.rootXPath, name);
  dom.window.close();
});
test("dynamic, disabled, ambiguous and unrelated navigation buttons fail closed", () => {
  const { dom, doc, config } = setup(
    '<form id="application-form"><button id="btn-submit" disabled>Submit</button></form><form><button>Other form</button></form>',
  );
  const button = doc.querySelector("#btn-submit");
  assert.equal(config.navigation(doc, "lever", "submit"), null);
  button.disabled = false;
  assert.equal(config.navigation(doc, "lever", "submit"), button);
  button.setAttribute("aria-disabled", "true");
  assert.equal(config.navigation(doc, "lever", "submit"), null);
  button.removeAttribute("aria-disabled");
  button.replaceWith(button.cloneNode(true));
  const current = doc.querySelector("#btn-submit");
  assert.equal(config.navigation(doc, "lever", "submit"), current);
  current.parentElement.append(current.cloneNode(true));
  assert.equal(config.navigation(doc, "lever", "submit"), null);
  doc.querySelector("#application-form").replaceChildren();
  doc.querySelectorAll("form")[1].append(current);
  assert.equal(config.navigation(doc, "lever", "submit"), null);
  dom.window.close();
});
test("nested Greenhouse roots select the form; two forms are never first-match", () => {
  const { dom, doc, config } = setup(
    '<div id="application"><form id="application_form"><button id="submit_app">Submit</button></form></div>',
  );
  assert.equal(config.root(doc, "greenhouse").id, "application_form");
  assert.equal(config.navigation(doc, "greenhouse", "submit").id, "submit_app");
  doc.body.innerHTML = "<form></form><form></form>";
  assert.equal(config.root(doc, "unknown"), null);
  doc.body.innerHTML = '<form id="newsletter"></form>';
  assert.equal(config.root(doc, "greenhouse"), null);
  dom.window.close();
});
test("Workday review cannot acquire generic footer navigation authority", () => {
  const { dom, doc, config } = setup(
    '<div data-automation-id="ApplyFlowPage"><section id="step"></section><button data-automation-id="bottom-navigation-next-button">Next</button></div>',
  );
  const next = doc.querySelector("button");
  assert.equal(config.navigation(doc, "workday", "next"), next);
  assert.equal(config.navigation(doc, "workday", "submit"), null);
  doc
    .querySelector("#step")
    .setAttribute("data-automation-id", "reviewJobApplicationPage");
  assert.equal(config.navigation(doc, "workday", "next"), null);
  assert.equal(config.navigation(doc, "workday", "submit"), null);
  dom.window.close();
});
