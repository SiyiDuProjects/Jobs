import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
// The architecture's promises as direct assertions (from the 2026-09-25 audit):
// a field keeps one decider across a re-render, a value the page dropped was
// not kept, and a cancelled run takes no page action.
const scripts = await Promise.all(
  ["dom-wait", "control-fields", "workday-controls"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const tiktok = await readModule(
  new URL("../source/content/adapters/tiktok.js", import.meta.url),
  "utf8",
);
function page(t, html) {
  const w = new JSDOM("<form>" + html + "</form>", {
    url: "https://fixture.myworkdayjobs.com/apply",
    runScripts: "outside-only",
  }).window;
  t.after(() => w.close());
  scripts.forEach((code) => w.eval(code));
  return { w, root: w.document.querySelector("form") };
}
const firstName =
  '<div data-automation-id="formField-legalName--firstName"><label for="first">First Name*</label><input id="first" data-automation-id="legalNameSection_firstName" required></div>';

test("a field the page replaces keeps its record: one decider, excluded from saved answers, a second automatic write refused", async (t) => {
  const { w, root } = page(t, firstName),
    old = w.document.getElementById("first"),
    book = w.JobsFormPipeline.ledger(root);
  // The site replaces the input when it commits (as Workday does).
  old.addEventListener(
    "input",
    () => {
      const fresh = old.cloneNode(false);
      fresh.value = old.value;
      old.replaceWith(fresh);
    },
    { once: true },
  );
  assert.equal(
    (
      await w.JobsFormPipeline.write(
        old,
        { value: "Ada" },
        { ledger: book, root, decider: "binding:first-name" },
      )
    ).ok,
    true,
  );
  const fresh = w.document.getElementById("first");
  assert.notEqual(fresh, old);
  assert.equal(fresh.value, "Ada");
  assert.equal(book.peek(fresh)?.decider, "binding:first-name");
  assert.equal(book.peek(fresh).state, "decided");
  assert(w.JobsFormPipeline.answered(root).has(fresh));
  assert.equal(
    w.JobsFormPipeline.unresolved(root, w.JobsFormPipeline.answered(root))
      .length,
    0,
    "the binding answer is not the person's own",
  );
  await assert.rejects(
    w.JobsFormPipeline.write(
      fresh,
      { value: "Bea" },
      { ledger: book, root, decider: "rule", replace: true },
    ),
    /already has a decider/,
  );
  assert.equal(fresh.value, "Ada");
});

test("a replaced field whose successor is ambiguous is not guessed", async (t) => {
  const { w, root } = page(
    t,
    firstName
      .replace('id="first"', 'id="a"')
      .replace('for="first"', 'for="a"') +
      '<div><label for="b">First Name*</label><input id="b" required></div>',
  );
  const book = w.JobsFormPipeline.ledger(root),
    a = w.document.getElementById("a");
  await w.JobsFormPipeline.write(
    a,
    { value: "Ada" },
    { ledger: book, root, decider: "binding:first" },
  );
  const fresh = a.cloneNode(false);
  fresh.value = "Ada";
  a.replaceWith(fresh);
  // Two rows now ask "First Name*": neither inherits the record.
  assert.equal(book.peek(fresh), null);
  assert.equal(book.peek(w.document.getElementById("b")), null);
});

test("an empty field was not kept, including a value the site drops before the check", async (t) => {
  const { w, root } = page(
    t,
    '<div data-automation-id="formField-age"><label for="age">Age*</label><button type="button" id="age" aria-haspopup="listbox">Select One</button></div>',
  );
  const node = w.document.getElementById("age");
  w.JobsWorkdayControls.listbox(node);
  assert.equal(await w.JobsFormPipeline.held(root, node), false);
  node.onclick = () => {
    node.setAttribute("aria-controls", "choices");
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<ul id="choices" role="listbox"><li role="option">Yes</li></ul>',
    );
    w.document.querySelector('[role="option"]').onclick = () => {
      node.textContent = "Yes";
    };
  };
  // The site resets the value when its list closes.
  node.onkeydown = (event) => {
    if (event.key === "Escape") {
      node.textContent = "Select One";
      w.document.getElementById("choices")?.remove();
    }
  };
  const book = w.JobsFormPipeline.ledger(root);
  const result = await w.JobsFormPipeline.write(
    node,
    { specs: [w.JobsProfileAnswers.literalSpec("known-answer", "Yes")] },
    { ledger: book, root, decider: "rule" },
  );
  assert.equal(result.ok, false);
  assert.equal(book.peek(node).state, "abstained");
  assert.equal(
    w.JobsControlFields.create(w.document, () => root).scan()[0].public.filled,
    false,
  );
});

for (const [name, queue, run] of [
  ["a cancelled run", true, false],
  ["a paused queue", false, true],
])
  test(`${name} takes no page action inside its fill (TikTok removes no entry)`, async (t) => {
    const { w, root } = page(
      t,
      '<button type="button" class="formOperate-remove">Remove entry</button>',
    );
    let removals = 0;
    w.document.querySelector("button").onclick = () => removals++;
    w.JobsQueuePage = { allowed: () => queue, guard: (check) => check };
    Object.assign(w, {
      jobsFormatFullName: () => "Ada",
      jobsFormatToday: () => "2026-09",
      jobsProfileWebsiteEntries: () => [],
      jobsFindXPath: (path) =>
        w.document.evaluate(path, w.document, null, 9, null).singleNodeValue,
    });
    w.eval(tiktok);
    await w.JobsFormPipeline.within(
      { root, ledger: w.JobsFormPipeline.ledger(root), canProceed: () => run },
      () =>
        w.tiktokFillApplication(
          {
            nameData: {},
            contactData: {},
            websiteData: {},
            employmentData: {},
          },
          () => run,
        ),
    );
    assert.equal(removals, 0);
  });

test("outside a fill, and inside a live one, page actions are allowed", async (t) => {
  const { w, root } = page(t, '<button type="button">Go</button>');
  let clicks = 0;
  const button = w.document.querySelector("button");
  button.onclick = () => clicks++;
  assert.equal(w.JobsPageActions.click(button), true);
  await w.JobsFormPipeline.within(
    { root, ledger: w.JobsFormPipeline.ledger(root), canProceed: () => true },
    () => w.JobsPageActions.click(button),
  );
  assert.equal(clicks, 2);
});

test("a field is decided once: reading its options for AI never asks the rules again", async (t) => {
  const { adapterPage } = await import("./helpers/adapter-run.mjs");
  const question = "Are you at least 18 years of age?";
  const p = await adapterPage(t, {
    url: "https://fixture.myworkdayjobs.com/apply",
    html: `<form><div data-automation-id="formField-age"><label for="age">${question}*</label><button type="button" id="age" aria-haspopup="listbox" aria-label="${question} Select One Required">Select One</button></div></form>`,
    ai: (field) => ({ state: "answer", value: "Yes", needsConfirmation: true }),
  });
  const node = p.doc.getElementById("age");
  p.w.JobsWorkdayControls.listbox(node);
  node.onclick = () => {
    node.setAttribute("aria-controls", "choices");
    p.doc.getElementById("choices")?.remove();
    p.doc.body.insertAdjacentHTML(
      "beforeend",
      '<ul id="choices" role="listbox"><li role="option">Yes</li><li role="option">No</li></ul>',
    );
    for (const option of p.doc.querySelectorAll('[role="option"]'))
      option.onclick = () => {
        node.textContent = option.textContent;
        p.doc.getElementById("choices").remove();
      };
  };
  node.onkeydown = (event) => {
    if (event.key === "Escape") p.doc.getElementById("choices")?.remove();
  };
  const rules = p.w.JobsProfileAnswers;
  let asked = 0;
  p.w.JobsProfileAnswers = {
    ...rules,
    resolve(text, ...rest) {
      if (String(text).startsWith(question)) asked++;
      return rules.resolve(text, ...rest);
    },
  };
  await p.fill(() => {});
  assert.equal(p.requests.length, 1, "the field reached AI with its options");
  assert.deepEqual(
    Array.from(p.requests[0].fields[0].options, (option) => option.label),
    ["Yes", "No"],
  );
  assert.equal(asked, 1, "the rules were asked once");
});

test("keeping a value on a quiet page reads the field twice, not on every tick", async (t) => {
  const { w, root } = page(
    t,
    '<div data-automation-id="formField-age"><label for="age">Age*</label><button type="button" id="age" aria-haspopup="listbox">Yes</button></div>',
  );
  const node = w.document.getElementById("age");
  w.JobsWorkdayControls.listbox(node);
  const before = w.JobsControlFields.scans();
  assert.equal(await w.JobsFormPipeline.held(root, node), true);
  assert(
    w.JobsControlFields.scans() - before <= 2,
    "scans: " + (w.JobsControlFields.scans() - before),
  );
});

for (const outcome of ["kept", "changed", "dropped", "open", "invalid"])
  test(`a pending dropdown commit is verified from its actual value: ${outcome}`, async (t) => {
    const { w, root } = page(
      t,
      '<div data-automation-id="formField-choice"><label for="choice">Decision*</label><button type="button" id="choice" aria-haspopup="listbox" aria-expanded="true">Yes</button></div>',
    );
    const node = w.document.getElementById("choice");
    w.JobsWorkdayControls.listbox(node);
    w.setTimeout(() => {
      if (outcome === "changed") node.textContent = "No";
      if (outcome === "dropped") node.textContent = "Select One";
      if (outcome === "invalid") node.setAttribute("aria-invalid", "true");
      if (outcome !== "open") node.removeAttribute("aria-expanded");
    }, 20);
    const result = await w.JobsFormPipeline.held(root, node, {
      quiet: 40,
      timeout: 150,
    });
    assert.equal(result, outcome === "kept");
  });
