import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
function fixture(t, html, url = "https://fixture.myworkdayjobs.com/apply") {
  const w = new JSDOM(`<form>${html}</form>`, {
    url,
    runScripts: "outside-only",
  }).window;
  t.after(() => w.close());
  w.eval(source);
  const root = w.document.querySelector("form");
  const reader = w.JobsControlFields.create(w.document, () => root);
  return { w, root, reader };
}

test("one question description serves scanners and first-pass collectors without reading other answers", (t) => {
  const h = fixture(
    t,
    `<div data-automation-id="formField-agreement">
    <h3>Terms and Conditions</h3><p>We process this application and contact you about it.</p>
    <fieldset><legend>Terms and Conditions</legend><label><input type="checkbox" id="terms" required>Yes, I have read the above mentioned Terms and Conditions and consent to all of them.</label></fieldset>
    <p hidden>Hidden stale terms</p><p style="display:none">Hidden via CSS</p><script>secretScript</script>
  </div><div data-automation-id="formField-other"><p>Other question instructions</p><label>Name<input value="PRIVATE"></label><textarea>PRIVATE ANSWER</textarea></div>`,
  );
  let events = 0;
  for (const type of ["focus", "click", "input", "change"])
    h.root.addEventListener(type, () => events++);
  const row = h.reader.scan().find((row) => row.node.id === "terms");
  assert.equal(
    row.description,
    "Terms and Conditions We process this application and contact you about it.",
  );
  const [question] = h.w.JobsControlFields.describeQuestions(
    [{ node: row.node, question: row.public.question }],
    { root: h.root },
  );
  assert.equal(question.description, row.description);
  assert.equal(events, 0);
  assert.equal(row.node.checked, false);
});

test("group help and explicit hidden ARIA descriptions survive, without duplicate text or input values", (t) => {
  const h = fixture(
    t,
    `<fieldset aria-describedby="help"><legend>Application consent</legend>
    <p id="help">Only for this application.</p><p id="screenreader" hidden>Includes recruitment contact.</p>
    <label><input type="checkbox" id="terms" aria-describedby="help screenreader">I agree</label>
  </fieldset>`,
  );
  const [row] = h.reader.scan();
  assert.equal(
    row.description,
    "Only for this application.\nIncludes recruitment contact.",
  );
  h.w.document.getElementById("help").firstChild.data =
    "Now includes other purposes.";
  assert.match(h.reader.scan()[0].description, /Now includes other purposes/);
});

test("a multi-question fieldset is not a description for each question", (t) => {
  const h = fixture(
    t,
    `<fieldset><legend>Application</legend><p>Unrelated section prose</p>
    <label>Name<input value="PRIVATE"></label><label>I agree<input type="checkbox" id="terms" aria-describedby="terms-help"></label>
  </fieldset><p id="terms-help">Explicit terms still apply.</p>`,
  );
  const row = h.reader.scan().find((row) => row.node.id === "terms");
  assert.equal(row.description, "Explicit terms still apply.");
});

test("explicit description references stay in their own shadow tree", (t) => {
  const h = fixture(
    t,
    '<p id="help">Wrong document description</p><div id="host"></div>',
  );
  const shadow = h.w.document
    .getElementById("host")
    .attachShadow({ mode: "open" });
  shadow.innerHTML =
    '<p id="help">Shadow description</p><label>I agree<input type="checkbox" aria-describedby="help"></label>';
  const reader = h.w.JobsControlFields.create(h.w.document, () => shadow);
  assert.equal(reader.scan()[0].description, "Shadow description");
});

test("transient validation messages are not instructions or answer identity", (t) => {
  const h = fixture(
    t,
    `<fieldset><legend>Terms</legend><p>Application processing only.</p>
    <label><input type="checkbox" id="terms" aria-describedby="error" aria-errormessage="error">I agree</label>
    <p data-automation-id="inputAlert">Required</p><p id="error">Please select this box.</p>
    <p role="alert">Validation pending</p></fieldset>`,
  );
  assert.equal(h.reader.scan()[0].description, "Application processing only.");
  h.root.querySelector('[data-automation-id="inputAlert"]').remove();
  h.w.document.getElementById("error").textContent = "Accepted";
  assert.equal(h.reader.scan()[0].description, "Application processing only.");
});

test("a reader scoped to one question includes that question's own instructions", (t) => {
  const h = fixture(
    t,
    '<fieldset><legend>Consent</legend><p>Only this application.</p><label>I agree<input type="checkbox"></label></fieldset>',
  );
  const reader = h.w.JobsControlFields.create(h.w.document, () =>
    h.root.querySelector("fieldset"),
  );
  assert.equal(reader.scan()[0].description, "Only this application.");
});
