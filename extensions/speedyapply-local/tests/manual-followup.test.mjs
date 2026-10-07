import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const modules = await Promise.all(
  ["control-fields", "answer-memory", "manual-answer"].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const ui = await readModule(
  new URL("../source/content/shared/answer-ui.js", import.meta.url),
  "utf8",
);
const parentQuestion = "Which access category applies to you?";
const prompt =
  'If you selected "A protected Individual" OR "Other" to the above question, please explain further.';
const item = (label, control) =>
  `<li class="application-question custom-question"><div><div class="application-label"><div class="text">${label}</div></div><div class="application-field">${control}</div></div></li>`;
const radios = (options) =>
  options
    .map(
      (value, index) =>
        `<label><input type="radio" name="access" value="${index}" required><span>${value}</span></label>`,
    )
    .join("");

async function fixture(
  t,
  {
    question = prompt,
    options = ["Another category", "A protected individual", "Other"],
    separateCard = false,
    greenhouse = false,
  } = {},
) {
  const parent = item(parentQuestion, radios(options));
  const child = item(question, '<textarea name="explanation"></textarea>');
  const form = greenhouse
    ? '<label for="question_parent">Which category?</label><select id="question_parent"><option value="">Select...</option><option>Other</option><option>Standard</option></select><label for="question_explain">If other, please explain</label><textarea id="question_explain"></textarea>'
    : `<section data-qa="additional-cards"><ul>${parent}${separateCard ? '</ul></section><section data-qa="additional-cards"><ul>' : ""}${child}</ul></section>`;
  const dom = new JSDOM(
    `<form>${form}<label>Private unrelated field<input type="password" value="unrelated-secret"></label><label>Contact email<input type="email" value="unrelated@example.test"></label></form>`,
    {
      url: greenhouse
        ? "https://job-boards.greenhouse.io/fixture/jobs/1"
        : "https://jobs.lever.co/fixture/role/apply",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = w.document,
    ports = [],
    saved = [],
    traces = [];
  const node = doc.querySelector("textarea");
  const actualPrompt = greenhouse ? "If other, please explain" : question;
  w.JobsDiagnostics = { note() {}, trace: (node, trace) => traces.push(trace) };
  w.chrome = {
    runtime: {
      connect() {
        const port = {
          onMessage: {
            addListener: (fn) => {
              port.receive = fn;
            },
          },
          onDisconnect: {
            addListener: (fn) => {
              port.lost = fn;
            },
          },
          postMessage: (message) => {
            port.request = message;
          },
          disconnect: () => {
            port.disconnected = true;
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  modules.forEach((code) => w.eval(code));
  w.JobsAnswerMemory.start(doc, true, (rows) => saved.push(...rows));
  w.jobsFindAllXPath = () => [node];
  w.jobsFindXPath = () => ({ textContent: actualPrompt });
  w.eval(ui);
  let invalidate;
  await w.jobsMountManualAnswerControls(
    {
      onInvalidated: (fn) => {
        invalidate = fn;
      },
    },
    [["textarea", "label"]],
  );
  const button = doc.querySelector("button"),
    status = doc.querySelector('[role="status"]');
  const select = (label, event = true) => {
    let target;
    if (greenhouse) {
      target = doc.querySelector("select");
      target.value = label;
    } else {
      const inputs = [...doc.querySelectorAll('[name="access"]')];
      inputs.forEach((input) => {
        input.checked = options[Number(input.value)] === label;
      });
      target = inputs.find((input) => input.checked) || inputs[0];
    }
    if (event) target.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  return {
    w,
    doc,
    node,
    ports,
    saved,
    traces,
    button,
    status,
    select,
    invalidate,
  };
}

test("manual generation sends the current parent label and selected option, without unrelated fields", async (t) => {
  for (const selection of ["Other", "A protected individual"]) {
    const h = await fixture(t);
    h.select(selection);
    h.button.click();
    const request = h.ports[0].request;
    const context = JSON.parse(request.additionalContext);
    assert.equal(context.formDependency.parentQuestion, parentQuestion);
    assert.equal(context.formDependency.parentAnswer, selection);
    assert.equal(context.formDependency.active, true);
    assert.equal(context.contextKind, "untrusted_form_state");
    assert(request.prompt.includes(parentQuestion));
    assert(request.prompt.endsWith(prompt));
    assert(!JSON.stringify(request).includes("unrelated"));
    await h.ports[0].receive({
      type: "STREAM_UPDATE",
      text: "A fixture explanation supported by the selected Profile.",
    });
    await h.ports[0].receive({ type: "STREAM_END", source: "profile" });
    assert.match(h.node.value, /fixture explanation/);
    assert.equal(h.saved.length, 0);
    assert(
      h.traces.some(
        (trace) => trace.decider === "user" && trace.result === "decided",
      ),
    );
    assert.match(h.status.textContent, /已生成/);
  }
});

test("inapplicable or unanswered parents do not request a fabricated follow-up or erase existing text", async (t) => {
  for (const selection of ["Another category", ""]) {
    const h = await fixture(t);
    h.node.value = "Prior user text";
    h.select(selection);
    h.button.click();
    assert.equal(h.ports.length, 0);
    assert.equal(h.node.value, "Prior user text");
    assert.match(
      h.status.textContent,
      selection ? /无需生成/ : /先完成关联问题/,
    );
    assert.equal(h.button.textContent, "生成回答");
  }
});

test("a follow-up cannot borrow a radio answer from another Lever card", async (t) => {
  const h = await fixture(t, { separateCard: true });
  h.select("Other");
  h.button.click();
  assert.equal(h.ports.length, 0);
  assert.match(h.status.textContent, /先完成关联问题/);
});

test("quoted and Yes/No alternatives use committed values, while unmatched option wording stays unresolved", async (t) => {
  for (const [question, options, selected, requests] of [
    ["If yes, please explain.", ["Yes", "No"], "Yes", 1],
    ["If no, please explain.", ["Yes", "No"], "Yes", 0],
    [
      'If "Conference" or "Other," please provide details:',
      ["Conference", "Other"],
      "Conference",
      1,
    ],
    [
      'If "Conference" or "Other", please provide details:',
      ["Conference", "Other"],
      "Other",
      1,
    ],
    [
      "If you selected “Other” please share details.",
      ["Standard", "Other"],
      "Other",
      1,
    ],
    ["If yes, please explain.", ["Standard", "Other"], "Other", 0],
  ]) {
    const h = await fixture(t, { question, options });
    h.select(selected);
    h.button.click();
    assert.equal(h.ports.length, requests, question);
  }
});

test("the shared manual path also uses existing Greenhouse dependency descriptions", async (t) => {
  const h = await fixture(t, { greenhouse: true });
  h.select("Other");
  h.button.click();
  assert.equal(
    JSON.parse(h.ports[0].request.additionalContext).formDependency
      .parentAnswer,
    "Other",
  );
  h.select("Standard");
  await h.ports[0].receive({ type: "STREAM_UPDATE", text: "Stale answer" });
  assert.equal(h.node.value, "");
  assert(h.ports[0].disconnected);
});

test("parent edits cancel partial answers immediately and late responses cannot restore them", async (t) => {
  for (const event of [true, false]) {
    const h = await fixture(t);
    h.node.value = "Original";
    h.select("Other");
    h.button.click();
    const port = h.ports[0];
    await port.receive({ type: "STREAM_UPDATE", text: "Partial old answer" });
    h.select("A protected individual", event);
    await port.receive({ type: "STREAM_END", source: "suggestion" });
    await port.receive({ type: "STREAM_UPDATE", text: "Late answer" });
    assert.equal(h.node.value, "Original");
    assert.equal(h.saved.length, 0);
    assert.match(h.status.textContent, /关联答案已变化/);
    assert(port.disconnected);
  }
});

test("a parent change after completion withdraws only generated text and permits fresh generation", async (t) => {
  const h = await fixture(t);
  h.select("Other");
  h.button.click();
  const port = h.ports[0];
  await port.receive({
    type: "STREAM_UPDATE",
    text: "Old completed explanation",
  });
  await port.receive({ type: "STREAM_END", source: "profile" });
  h.select("A protected individual");
  assert.equal(h.node.value, "");
  assert.equal(h.node.hasAttribute("data-jobs-answer-source"), false);
  assert.equal(
    h.w.JobsFormPipeline.ledgerFor(h.node.form).peek(h.node).state,
    "abstained",
  );
  assert.match(h.status.textContent, /关联答案已变化/);
  h.button.click();
  assert.equal(h.ports.length, 2);
  assert.equal(
    JSON.parse(h.ports[1].request.additionalContext).formDependency
      .parentAnswer,
    "A protected individual",
  );
});

test("user corrections survive a parent change, whether generation is pending or complete", async (t) => {
  for (const finished of [false, true]) {
    const h = await fixture(t);
    h.select("Other");
    h.button.click();
    const port = h.ports[0];
    await port.receive({ type: "STREAM_UPDATE", text: "Generated draft" });
    if (finished) await port.receive({ type: "STREAM_END", source: "profile" });
    h.node.value = "My edited explanation";
    h.node.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    h.select("Another category");
    await port.receive({ type: "STREAM_END", source: "suggestion" });
    assert.equal(h.node.value, "My edited explanation");
  }
});

test("dependency changes during final blur cannot complete or learn the obsolete answer", async (t) => {
  const h = await fixture(t);
  h.select("Other");
  h.button.click();
  const port = h.ports[0];
  await port.receive({ type: "STREAM_UPDATE", text: "Old draft" });
  h.node.addEventListener("blur", () => h.select("Another category"), {
    once: true,
  });
  await port.receive({ type: "STREAM_END", source: "suggestion" });
  assert.equal(h.node.value, "");
  assert.equal(h.saved.length, 0);
  assert.match(h.status.textContent, /关联答案已变化/);
});

test("removing or invalidating a completed form releases its dependency watcher", async (t) => {
  const h = await fixture(t);
  h.select("Other");
  h.button.click();
  await h.ports[0].receive({ type: "STREAM_UPDATE", text: "Finished" });
  await h.ports[0].receive({ type: "STREAM_END", source: "profile" });
  h.invalidate();
  h.select("Another category");
  assert.equal(h.node.value, "Finished");
});

test("ordinary and hypothetical essays do not collect unrelated choices", async (t) => {
  for (const question of [
    "Why this team?",
    "If you could build anything, what would it be?",
  ]) {
    const h = await fixture(t, { question });
    h.select("Other");
    h.button.click();
    assert.equal(h.ports[0].request.additionalContext, "");
    assert.equal(h.ports[0].request.prompt, question);
  }
});

test("parent re-render invalidates stale output but unrelated edits do not", async (t) => {
  const h = await fixture(t);
  h.select("Other");
  h.button.click();
  const port = h.ports[0];
  const unrelated = h.doc.querySelector('[type="email"]');
  unrelated.value = "changed@example.test";
  unrelated.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  assert.equal(port.disconnected, undefined);
  await port.receive({ type: "STREAM_UPDATE", text: "Partial" });
  const parent = h.doc.querySelector("li.application-question");
  parent.replaceWith(parent.cloneNode(true));
  h.select("Another category", false);
  await new Promise((resolve) => h.w.setTimeout(resolve, 0));
  assert.equal(h.node.value, "");
  assert(port.disconnected);
  assert.match(h.status.textContent, /关联答案已变化/);
});
