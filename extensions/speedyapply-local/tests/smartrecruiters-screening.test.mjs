import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { chooseAnswer } from "./helpers/choose-answer.mjs";

const scripts = await Promise.all(
  ["dom-wait", "control-fields", "shadow-controls", "form-pipeline"].map(
    (name) =>
      readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
  ),
);
function setup(t) {
  const w = new JSDOM(
    '<oc-screening-questions><sr-screening-questions-form></sr-screening-questions-form><oc-consent></oc-consent><oc-nav-screening-questions><spl-button type="secondary">Back</spl-button><spl-button type="primary">Submit</spl-button></oc-nav-screening-questions></oc-screening-questions>',
    {
      url: "https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/1234567",
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  const doc = w.document,
    root = doc.querySelector("oc-screening-questions"),
    host = doc.querySelector("sr-screening-questions-form");
  const questions = host.attachShadow({ mode: "open" });
  scripts.forEach((code) => w.eval(code));
  const reader = w.JobsControlFields.create(doc, () =>
    w.JobsPlatformConfig.root(doc, "smartrecruiters"),
  );
  function field(tag, label, required = true, scope = questions) {
    const node = doc.createElement(tag);
    if (required) node.setAttribute("required", "");
    node.innerHTML = `<span slot="label-content">${label}</span>`;
    scope.append(node);
    const shadow = node.attachShadow({ mode: "open" });
    shadow.innerHTML = "<spl-internal-form-field></spl-internal-form-field>";
    return { node, shadow, form: shadow.firstElementChild };
  }
  function input(label, scope = questions, tag = "spl-input") {
    const f = field(tag, label, true, scope);
    f.form.innerHTML = `<input type="${tag === "spl-checkbox" ? "checkbox" : "text"}" aria-required="true">`;
    return { ...f, input: f.shadow.querySelector("input") };
  }
  function choice(label, { multiple = false, commit = true } = {}) {
    const f = field(
      multiple ? "spl-multiselect-autocomplete" : "spl-autocomplete",
      label,
    );
    f.form.innerHTML = '<spl-dropdown></spl-dropdown><div slot="menu"></div>';
    let input;
    if (multiple) {
      const tags = doc.createElement("spl-tags-list");
      tags.attachShadow({ mode: "open" });
      tags.innerHTML = '<input role="combobox" aria-expanded="false">';
      f.form.append(tags);
      input = tags.querySelector("input");
    } else {
      const inner = doc.createElement("spl-input");
      f.form.append(inner);
      inner.attachShadow({ mode: "open" }).innerHTML =
        '<input role="combobox" aria-expanded="false">';
      input = inner.shadowRoot.querySelector("input");
    }
    input.onclick = () => input.setAttribute("aria-expanded", "true");
    const menu = f.shadow.querySelector('[slot="menu"]');
    let clicks = 0;
    for (const label of ["Alpha", "Beta"]) {
      const option = doc.createElement("spl-select-option");
      option.setAttribute("value", label);
      option.innerHTML = `<div class="c-spl-autocomplete-default-option"><spl-typography-body>${label}</spl-typography-body></div>`;
      // Actual SPL selected state lives another two shadow roots down.
      const item = doc.createElement("spl-dropdown-item");
      option.attachShadow({ mode: "open" }).append(item);
      item.attachShadow({ mode: "open" }).innerHTML =
        '<div aria-selected="false"></div>';
      option.onclick = () => {
        clicks++;
        if (!commit) return;
        if (!multiple)
          for (const o of menu.children)
            o.shadowRoot.firstElementChild.shadowRoot.firstElementChild.setAttribute(
              "aria-selected",
              "false",
            );
        item.shadowRoot.firstElementChild.setAttribute("aria-selected", "true");
        input.value = "";
        f.form.removeAttribute("errorstate");
      };
      menu.append(option);
    }
    return { ...f, input, menu, clicks: () => clicks };
  }
  function radio(label) {
    const f = field("spl-radio-group", label);
    for (const label of ["Yes", "No"]) {
      const option = doc.createElement("spl-radio");
      option.setAttribute("label", label);
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", "false");
      f.node.append(option);
      option.onclick = () => {
        for (const o of f.node.querySelectorAll("spl-radio"))
          o.setAttribute("aria-checked", String(o === option));
      };
    }
    return f;
  }
  return { w, doc, root, questions, reader, input, choice, radio };
}

test("screening shadow questions and outside consent belong to one complete step", async (t) => {
  const h = setup(t),
    text = h.input("Major coursework"),
    select = h.choice("Highest completed education"),
    radio = h.radio("Eligibility question"),
    consent = h.input(
      "I have read the privacy notice",
      h.doc.querySelector("oc-consent"),
      "spl-checkbox",
    );
  assert.deepEqual(
    Array.from(h.reader.scan(), (r) => r.public.question).sort(),
    [
      "Major coursework",
      "Highest completed education",
      "Eligibility question",
      "I have read the privacy notice",
    ].sort(),
  );
  assert.equal(h.reader.state().ready, false);
  const book = h.w.JobsFormPipeline.ledger(h.root);
  await h.w.JobsFormPipeline.within(
    { root: h.root, ledger: book, canProceed: () => true },
    () =>
      h.w.JobsFormPipeline.bind([
        { name: "major", find: () => text.node, answer: "Synthetic field" },
        { name: "education", find: () => select.node, answer: "Alpha" },
        { name: "eligibility", find: () => radio.node, answer: "No" },
        { name: "consent", find: () => consent.node, checked: true },
      ]),
  );
  assert.equal(text.input.value, "Synthetic field");
  assert.equal(h.w.JobsShadowControls.value(radio.node), "No");
  assert.equal(h.reader.state().ready, true);
  const submit = h.w.JobsPlatformConfig.navigation(
    h.doc,
    "smartrecruiters",
    "submit",
  );
  assert.equal(submit.textContent, "Submit");
  submit.setAttribute("disabled", "");
  assert.equal(
    h.w.JobsPlatformConfig.navigation(h.doc, "smartrecruiters", "submit"),
    null,
  );
});

test("screening multi-choice appends verified choices without toggling prior selection", async (t) => {
  const h = setup(t),
    multi = h.choice("Languages", { multiple: true });
  assert.equal(h.reader.scan()[0].public.type, "select-multiple");
  assert.equal(await chooseAnswer(multi.node, ["Alpha"]), multi.node);
  assert.equal(
    await h.w.JobsControlFields.chooseSpec(multi.node, {
      ...h.w.JobsControlFields.literalSpec(multi.node, ["Beta"]),
      append: true,
    }),
    multi.node,
  );
  assert.equal(await chooseAnswer(multi.node, ["Alpha", "Beta"]), multi.node);
  assert.equal(await chooseAnswer(multi.node, ["Alpha"]), null);
  assert.deepEqual(Array.from(h.w.JobsShadowControls.value(multi.node)), [
    "Alpha",
    "Beta",
  ]);
  assert.equal(multi.clicks(), 2);
});

test("screening multi-choice accepts a complete set through the shared option transaction", async (t) => {
  const h = setup(t),
    multi = h.choice("Languages", { multiple: true });
  assert.equal(await chooseAnswer(multi.node, ["Alpha", "Beta"]), multi.node);
  assert.deepEqual(Array.from(h.w.JobsShadowControls.value(multi.node)), [
    "Alpha",
    "Beta",
  ]);
  assert.equal(multi.clicks(), 2);
});

test("screening does not accept search text or unresolved validation as a committed answer", async (t) => {
  const h = setup(t),
    select = h.choice("Required selection", { commit: false });
  assert.equal(await chooseAnswer(select.node, "Alpha"), null);
  assert.equal(h.reader.state().ready, false);
  const text = h.input("Required text");
  text.input.value = "Synthetic";
  text.form.setAttribute("errorstate", "");
  assert.equal(
    h.reader.scan().find((r) => r.node === text.node).public.invalid,
    true,
  );
});

test("screening rescans conditional fields inside its declared shadow root", async (t) => {
  const h = setup(t);
  h.input("Initial question");
  assert.equal(h.reader.scan().length, 1);
  const next = h.input("Conditional question");
  assert.equal(h.reader.scan().length, 2);
  next.node.remove();
  assert.equal(h.reader.scan().length, 1);
});

test("screening discovers a shadow root attached after the initial scan", (t) => {
  const h = setup(t),
    host = h.doc.createElement("sr-screening-questions-form");
  h.doc.querySelector("sr-screening-questions-form").replaceWith(host);
  assert.equal(h.reader.scan().length, 0);
  const questions = host.attachShadow({ mode: "open" });
  h.input("Late question", questions);
  assert.equal(h.reader.scan()[0].public.question, "Late question");
});

test("screening reports an unsupported required control inside the shadow form", (t) => {
  const h = setup(t);
  h.questions.innerHTML =
    '<div><label>Unrecognized question *</label><div role="slider" aria-label="Unrecognized question" aria-required="true" tabindex="0"></div></div>';
  const state = h.reader.state();
  assert.equal(state.ready, false);
  assert.ok(
    h.reader
      .unrecognized()
      .some((field) => field.question.includes("Unrecognized question")),
  );
});

test("screening radio choices still honor cancellation and preserve an existing answer", async (t) => {
  const h = setup(t),
    radio = h.radio("Eligibility");
  assert.equal(
    await chooseAnswer(radio.node, "No", { canProceed: () => false }),
    null,
  );
  assert.equal(h.w.JobsShadowControls.value(radio.node), "");
  assert.equal(await chooseAnswer(radio.node, "No"), radio.node);
  assert.equal(await chooseAnswer(radio.node, "Yes"), null);
  assert.equal(h.w.JobsShadowControls.value(radio.node), "No");
});
