import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureFormDocument } from "../src/custom/form-context.js";
import { initializePlatformConfig } from "../src/custom/platform-config.js";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
initializePlatformConfig();
function fixture(t, html, url = "https://fixture.icims.com/forms") {
  const w = new JSDOM(
    `<nav>Outside navigation</nav><form>${html}</form><footer>Outside footer</footer>`,
    {
      url,
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  const root = w.document.querySelector("form");
  const reader = w.JobsControlFields.create(w.document, () => root);
  return { w, root, reader };
}

test("clean form context retains shared instructions and independent radio/signature fields", (t) => {
  const f = fixture(
    t,
    `<h1>Voluntary survey</h1><p>These instructions apply to both fields.</p>
    <table><tr><td>Please choose one</td></tr><tr><td><p>
      <span class="customFieldContainer iCIMS_Forms_RadioGroup"><input type="radio" name="survey" value="yes"></span> Yes, currently or previously<br>
      <span class="customFieldContainer iCIMS_Forms_RadioGroup"><input type="radio" name="survey" value="no"></span> No, never<br>
      <span class="customFieldContainer iCIMS_Forms_RadioGroup"><input type="radio" name="survey" value="skip"></span> I do not want to answer
    </p></td></tr></table>
    <table><tr><td><span class="customFieldContainer"><input id="signature" type="checkbox"></span> Signature<br>
      (checking the checkbox above is equivalent to a handwritten signature)</td></tr></table>
    <label>Comment<textarea>Existing page answer</textarea></label>
    <input type="hidden" value="HIDDEN_TOKEN"><input type="password" value="PASSWORD">
    <input autocomplete="one-time-code" value="CODE"><input type="file">
    <script>SECRET_SCRIPT</script><p hidden>HIDDEN_COPY</p><p style="display:none">HIDDEN_CSS</p>
    <div data-jobs-operator>EXTENSION_REVIEW</div><nav>INNER_NAV</nav><button>Submit</button>`,
  );
  let events = 0;
  for (const name of ["focus", "click", "change", "input", "submit"])
    f.root.addEventListener(name, () => events++);
  const context = captureFormDocument(f.root, f.reader);
  const radio = context.fields.find((field) => field.type === "radio");
  const signature = context.fields.find((field) => field.type === "checkbox");
  assert.equal(radio.options.length, 3);
  assert.notEqual(radio.fieldId, signature.fieldId);
  assert.equal(signature.options.length, 0);
  assert.match(signature.description, /equivalent to a handwritten signature/);
  assert.match(context.text, /These instructions apply to both fields/);
  assert.match(context.text, /equivalent to a handwritten signature/);
  assert.ok(context.text.includes(`[field:${radio.fieldId}]`));
  assert.ok(context.text.includes(`[field:${signature.fieldId}]`));
  assert.equal(context.text.split(`[field:${radio.fieldId}]`).length, 2);
  assert.equal(
    context.fields.find((field) => field.question === "Comment").answer,
    "Existing page answer",
  );
  assert.doesNotMatch(context.text, /Existing page answer/);
  assert.doesNotMatch(
    JSON.stringify(context),
    /HIDDEN_|PASSWORD|CODE|SECRET_SCRIPT|EXTENSION_REVIEW|INNER_NAV|Outside navigation|Outside footer|Submit/,
  );
  assert.equal(context.truncated, false);
  assert.equal(events, 0);
});

test("bounded context explicitly reports incomplete text and tracks changing shared instructions", (t) => {
  const f = fixture(
    t,
    `<h2>Survey</h2><p id="help">Application use only.</p><label>Signature<input type="checkbox"></label>`,
  );
  const first = captureFormDocument(f.root, f.reader);
  f.root.querySelector("#help").textContent = "Changed shared declaration.";
  assert.notEqual(captureFormDocument(f.root, f.reader).text, first.text);
  f.root.querySelector("#help").textContent = "long prose ".repeat(7000);
  const context = captureFormDocument(f.root, f.reader);
  assert.equal(context.truncated, true);
  assert.ok(context.text.length <= 60000);
  assert.equal(context.fields.length, 1);
});

test("form footer declarations and slotted instructions survive shadow form roots", (t) => {
  const f = fixture(
    t,
    '<div id="host"><p>Slotted shared instructions.</p></div>',
  );
  const shadow = f.root.querySelector("#host").attachShadow({ mode: "open" });
  shadow.innerHTML =
    '<slot></slot><label>Signature<input type="checkbox"></label><footer>Signing applies to this application.</footer>';
  const reader = f.w.JobsControlFields.create(f.w.document, () => shadow);
  const context = captureFormDocument(shadow, reader);
  assert.match(context.text, /Slotted shared instructions/);
  assert.match(context.text, /Signing applies to this application/);
  assert.equal(context.fields.length, 1);
});

test("clearing field validation does not invalidate stable form instructions", (t) => {
  const f = fixture(
    t,
    '<h1>Application</h1><p id="help">Shared instruction.</p><div data-automation-id="formField-name"><label>Name<input></label><p data-automation-id="inputAlert">Required</p><p role="alert">Validation feedback</p></div>',
    "https://fixture.myworkdayjobs.com/apply",
  );
  const before = captureFormDocument(f.root, f.reader).text;
  assert.doesNotMatch(before, /Required|Validation feedback/);
  f.root.querySelector("input").value = "Synthetic answer";
  f.root.querySelector('[data-automation-id="inputAlert"]').remove();
  f.root.querySelector('[role="alert"]').remove();
  assert.equal(captureFormDocument(f.root, f.reader).text, before);
  f.root.querySelector("#help").textContent = "A new condition.";
  assert.notEqual(captureFormDocument(f.root, f.reader).text, before);
});
