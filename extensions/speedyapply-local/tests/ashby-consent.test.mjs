import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const runtime = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const prompt = "Choose whether to receive text updates from Example Company.";
const labels = [
  "Yes - I consent to receiving text messages",
  "No - I do not consent to receiving text messages",
];
async function fixture(t, { required = false, selected = false } = {}) {
  const dom = new JSDOM(
    `<form><div class="ashby-application-form-field-entry" data-field-path="phone">
      <label class="ashby-application-form-question-title _required_fixture" for="phone">Phone</label>
      <input id="phone" type="tel" required value="2025550123">
      <div class="ashby-application-form-texting-consent-description">
        <div><div contenteditable="false"><p>${prompt}</p><p><a href="https://example.invalid/privacy">Privacy Policy</a></p></div></div>
        <div>${labels.map((label, i) => `<label><input type="radio" name="communicationConsent" value="${i}" ${required ? "required" : ""} ${selected && i === 1 ? "checked" : ""}><div><div contenteditable="false"><p>${label}</p></div></div></label>`).join("")}</div>
      </div>
    </div></form>`,
    {
      url: "https://jobs.ashbyhq.com/example/application",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  dom.window.eval(runtime);
  const doc = dom.window.document;
  const reader = dom.window.JobsControlFields.create(doc);
  return { doc, reader, fields: dom.window.JobsControlFields };
}

test("Ashby optional texting consent is a separate readable question and does not block a filled phone", async (t) => {
  const { reader, fields } = await fixture(t);
  const rows = reader.scan();
  assert.equal(rows.length, 2);
  const phone = rows.find((row) => row.public.type === "tel");
  const consent = rows.find((row) => row.public.type === "radio");
  assert.equal(phone.public.required, true);
  assert.equal(consent.public.required, false);
  assert.equal(consent.public.question, prompt + "Privacy Policy");
  assert.deepEqual(
    Array.from(consent.public.options, (option) => option.label),
    labels,
  );
  assert.equal(consent.public.supported, true);
  assert.equal(consent.public.completion, "optional-empty");
  assert.equal(fields.needsAnswer(consent.public), false);
  assert.equal(reader.state().ready, true);
  assert.equal(reader.state().blockers.length, 0);
});

test("an empty required phone still blocks when its optional consent is unanswered", async (t) => {
  const { doc, reader } = await fixture(t);
  doc.querySelector("#phone").value = "";
  const state = reader.state();
  assert.equal(state.ready, false);
  assert.equal(state.blockers.length, 1);
  assert.equal(state.invalid[0].public.type, "tel");
});

test("explicit requiredness and actual validation on the consent group still block", async (t) => {
  const { doc, reader } = await fixture(t, { required: true });
  let consent = reader.scan().find((row) => row.public.type === "radio");
  assert.equal(consent.public.required, true);
  assert.equal(reader.state().ready, false);
  doc.querySelectorAll('input[type="radio"]')[1].checked = true;
  assert.equal(reader.state().ready, true);
  doc.querySelector('input[type="radio"]').setCustomValidity("Choose again");
  consent = reader.scan().find((row) => row.public.type === "radio");
  assert.equal(consent.public.invalid, true);
  assert.equal(reader.state().ready, false);
});

test("a selected consent remains readable and scanning does not change the person's choice", async (t) => {
  const { doc, reader } = await fixture(t, { selected: true });
  const radios = [...doc.querySelectorAll('input[type="radio"]')];
  const consent = reader.scan().find((row) => row.public.type === "radio");
  assert.equal(consent.public.completion, "filled");
  assert.equal(consent.raw, consent.public.options[1].value);
  assert.deepEqual(
    radios.map((node) => node.checked),
    [false, true],
  );
  assert.equal(reader.state().ready, true);
});

test("actual validation on an optional consent still blocks", async (t) => {
  const { doc, reader } = await fixture(t);
  doc.querySelector('input[type="radio"]').setAttribute("aria-invalid", "true");
  const state = reader.state();
  assert.equal(state.ready, false);
  assert.equal(state.blockers.length, 1);
  assert.equal(state.blockers[0].reason, "invalid");
});

test("static rich text labels are preserved while editable answer content is omitted", () => {
  const dom = new JSDOM(
    '<form><label for="choice"><div contenteditable="false">Keep static text <span contenteditable="true">private answer</span></div></label><input id="choice" type="checkbox"></form>',
    { url: "https://example.invalid", runScripts: "outside-only" },
  );
  try {
    dom.window.eval(runtime);
    const rows = dom.window.JobsControlFields.create(
      dom.window.document,
    ).scan();
    assert.equal(
      rows.find((row) => row.node.id === "choice").public.question,
      "Keep static text",
    );
  } finally {
    dom.window.close();
  }
});
