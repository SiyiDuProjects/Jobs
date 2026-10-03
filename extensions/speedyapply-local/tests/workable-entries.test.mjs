import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { readModule } from "./helpers/module-source.mjs";
const sources = await Promise.all(
  ["dom-wait", "control-fields", "form-pipeline"].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const adapter = await readModule(
  new URL("../source/content/adapters/workable.js", import.meta.url),
  "utf8",
);

function page(t, { save = true, replace = false, reuse = false } = {}) {
  const w = new JSDOM(
    '<form data-ui="application-form"><section data-ui="experience"><button type="button" data-ui="add-section">Add</button></section></form>',
    {
      url: "https://apply.workable.com/fixture/j/SYNTHETIC/apply",
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  sources.forEach((s) => w.eval(s));
  const notes = [];
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, node, detail }),
    trace() {},
  };
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options) =>
    until(read, { ...options, timeout: 80 });
  w.jobsClick = (selector) =>
    w.JobsPageActions.click(w.document.querySelector(selector));
  w.eval(adapter);
  const root = w.document.querySelector("form"),
    section = root.firstElementChild;
  let adds = 0,
    saves = 0,
    editor;
  const values = [],
    titles = [];
  section.querySelector("button").onclick = () => {
    adds++;
    // Deliberately synthetic container: no runtime selector may depend on it.
    if (!reuse || !editor) {
      editor = w.document.createElement("div");
      editor.innerHTML =
        '<label>Title<input id="title" required></label><label>Company<input id="company"></label>';
    }
    editor.querySelectorAll("input").forEach((node) => {
      node.value = "";
    });
    section.append(editor);
    const title = editor.querySelector("#title");
    titles.push(title);
    if (replace)
      title.addEventListener(
        "input",
        () => {
          const fresh = title.cloneNode();
          fresh.value = title.value;
          title.replaceWith(fresh);
        },
        { once: true },
      );
    const button = w.document.createElement("button");
    button.type = "button";
    button.dataset.ui = "save-section";
    editor.append(button);
    button.onclick = () => {
      saves++;
      values.push([
        editor.querySelector("#title").value,
        editor.querySelector("#company").value,
      ]);
      if (save) {
        editor.remove();
        button.remove();
      }
    };
  };
  const book = w.JobsFormPipeline.ledger(root);
  const run = (
    entries = [
      { jobTitle: "First role", company: "Company One" },
      { jobTitle: "Second role", company: "Company Two" },
    ],
  ) =>
    w.JobsFormPipeline.within(
      { root, ledger: book, canProceed: () => true },
      () =>
        w.workableFillApplication({
          addressData: {},
          nameData: {},
          contactData: {},
          educationData: [],
          jobData: entries,
        }),
    );
  return {
    w,
    root,
    section,
    book,
    run,
    notes,
    values,
    titles,
    adds: () => adds,
    saves: () => saves,
  };
}

for (const replace of [false, true])
  test(`Workable two experiences have independent ledger records (same-entry replacement: ${replace})`, async (t) => {
    const h = page(t, { replace });
    await h.run();
    assert.deepEqual(h.values, [
      ["First role", "Company One"],
      ["Second role", "Company Two"],
    ]);
    assert.equal(
      h.notes.filter((n) => n.type === "auto_duplicate_decider").length,
      0,
    );
  });

test("Workable same-entry control replacement keeps its one decider", async (t) => {
  const h = page(t, { save: false, replace: true });
  await h.run([{ jobTitle: "First role", company: "Company One" }]);
  const title = h.section.querySelector("#title");
  assert.equal(h.book.peek(title)?.state, "decided");
  assert.notEqual(title, h.titles[0]);
  await assert.rejects(
    h.w.JobsFormPipeline.write(
      title,
      { value: "Wrong replacement" },
      {
        ledger: h.book,
        root: h.root,
        decider: "rule",
        replace: true,
      },
    ),
    /already has a decider/,
  );
  assert.equal(title.value, "First role");
});

test("Workable confirmed new entries may reuse the same input nodes", async (t) => {
  const h = page(t, { reuse: true });
  await h.run();
  assert.equal(h.titles[0], h.titles[1]);
  assert.deepEqual(h.values, [
    ["First role", "Company One"],
    ["Second role", "Company Two"],
  ]);
  assert.equal(
    h.notes.filter((n) => n.type === "auto_duplicate_decider").length,
    0,
  );
});

test("Workable Save that leaves its editor open holds, without minting another identity", async (t) => {
  const h = page(t, { save: false });
  const result = await h.run();
  assert.match(result.hold, /not saved/);
  assert.equal(h.adds(), 1);
  assert.equal(h.saves(), 1);
  const title = h.section.querySelector("#title"),
    record = h.book.peek(title);
  const repeated = await h.run([
    { jobTitle: "Unrequested replacement", company: "Wrong company" },
  ]);
  assert.match(repeated.hold, /still being edited/);
  assert.equal(h.book.peek(title), record);
  assert.equal(title.value, "First role");
  assert.equal(h.adds(), 1);
  assert.equal(h.saves(), 1);
});

test("Workable existing editor is preserved and identical fields outside the entry are untouched", async (t) => {
  const h = page(t);
  h.root.insertAdjacentHTML(
    "afterbegin",
    '<label>Title<input id="external-title" value="Outside value"></label>',
  );
  await h.run();
  assert.deepEqual(h.values, [
    ["First role", "Company One"],
    ["Second role", "Company Two"],
  ]);
  assert.equal(h.root.querySelector("#external-title").value, "Outside value");
  h.section.querySelector("button").click();
  h.section.querySelector("#title").value = "Existing editor";
  const result = await h.run();
  assert.match(result.hold, /still being edited/);
  assert.equal(h.section.querySelector("#title").value, "Existing editor");
  assert.equal(h.adds(), 3);
});

test("Workable Add without an editor holds without assigning an entry scope", async (t) => {
  const h = page(t);
  h.section.querySelector("button").onclick = () => {};
  const result = await h.run();
  assert.match(result.hold, /did not open/);
  assert.equal(h.w.JobsControlFields.entryScope(h.section), null);
  assert.equal(h.saves(), 0);
});

test("Workable cancellation after Add cannot assign an entry scope or save", async (t) => {
  const h = page(t);
  let live = true;
  const add = h.section.querySelector("button"),
    open = add.onclick;
  add.onclick = () => {
    open();
    live = false;
  };
  const result = await h.w.JobsFormPipeline.within(
    { root: h.root, ledger: h.book, canProceed: () => live },
    () =>
      h.w.workableAddEntries(
        "experience",
        ["First"],
        (answer) => [{ name: "title", find: "#title", answer }],
        () => live,
      ),
  );
  assert.match(result.hold, /stopped/);
  assert.equal(h.w.JobsControlFields.entryScope(h.section), null);
  assert.equal(h.saves(), 0);
});

test("Workable education entries use the same confirmed-entry identity boundary", async (t) => {
  const h = page(t);
  h.section.dataset.ui = "education";
  const values = [];
  h.section.querySelector("button").onclick = () => {
    const editor = h.w.document.createElement("div");
    editor.innerHTML =
      '<label>School<input id="school"></label><label>Degree<input id="degree"></label><button type="button" data-ui="save-section">Save</button>';
    h.section.append(editor);
    editor.querySelector("button").onclick = () => {
      values.push([
        editor.querySelector("#school").value,
        editor.querySelector("#degree").value,
      ]);
      editor.remove();
    };
  };
  await h.w.JobsFormPipeline.within(
    { root: h.root, ledger: h.book, canProceed: () => true },
    () =>
      h.w.workableFillApplication({
        addressData: {},
        nameData: {},
        contactData: {},
        jobData: [],
        educationData: [
          { school: "First School", degree: "First Degree" },
          { school: "Second School", degree: "Second Degree" },
        ],
      }),
  );
  assert.deepEqual(values, [
    ["First School", "First Degree"],
    ["Second School", "Second Degree"],
  ]);
  assert.equal(
    h.notes.filter((n) => n.type === "auto_duplicate_decider").length,
    0,
  );
});
