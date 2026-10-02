import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const read = (name) =>
  readWithDependencies(
    new URL("../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const sources = await Promise.all(
  ["dom-wait", "option-match", "control-fields", "aria-controls"].map(read),
);
const fieldsSource = await readModule(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);

// A standard ARIA 1.2 select-only combobox or an editable search combobox,
// driven by page script exactly like an unknown site's own widget.
function setup(
  body,
  {
    url = "https://careers.example.test/apply",
    commit = true,
    search = false,
  } = {},
) {
  const dom = new JSDOM("<!doctype html><form>" + body + "</form>", {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  const notes = [],
    traces = [];
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace: (node, entry) => traces.push(entry),
  };
  for (const source of sources) w.eval(source);
  const box = doc.querySelector('[role="combobox"]'),
    list = doc.getElementById(box.getAttribute("aria-controls"));
  const input = box.matches("input") ? box : null;
  const open = () => {
    list.hidden = false;
    box.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    list.hidden = true;
    box.setAttribute("aria-expanded", "false");
  };
  box.addEventListener("click", () => (list.hidden ? open() : close()));
  box.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") open();
    if (event.key === "Escape") close();
  });
  if (search)
    input.addEventListener("input", () => {
      const query = input.value.toLowerCase();
      list.innerHTML = query
        ? ["Physics", "Physical Therapy", "Philosophy"]
            .filter((item) => item.toLowerCase().startsWith(query.slice(0, 4)))
            .map((item) => `<li role="option">${item}</li>`)
            .join("")
        : "";
    });
  list.addEventListener("click", (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option || !commit) return;
    if (input) input.value = option.textContent;
    else box.textContent = option.textContent;
    close();
  });
  const reader = w.JobsControlFields.create(
    doc,
    () => doc.querySelector("form"),
    { write: true },
  );
  return {
    w,
    doc,
    box,
    list,
    notes,
    traces,
    reader,
    row: () => reader.scan().find((row) => row.node === box),
    close: () => w.close(),
  };
}
const select = (
  extra = "",
) => `<label id="pronouns-label">Preferred pronouns</label>
  <div role="combobox" tabindex="0" aria-labelledby="pronouns-label" aria-controls="pronouns-list" aria-expanded="false" ${extra}>Select...</div>
  <ul role="listbox" id="pronouns-list" hidden><li role="option">She/her</li><li role="option">He/him</li><li role="option">They/them</li></ul>`;

test("an unowned standard combobox is a supported field read from its visible selection", () => {
  const h = setup(select('aria-required="true"'));
  try {
    const row = h.row();
    assert.equal(row.public.component, "aria-combobox");
    assert.equal(row.public.type, "combobox");
    assert.equal(row.public.question, "Preferred pronouns");
    assert.equal(row.public.supported, true);
    assert.equal(row.public.required, true);
    assert.equal(row.public.filled, false);
    assert.equal(row.public.completion, "required-empty");
    // Options inside the linked listbox are not separate questions.
    assert.equal(h.reader.scan().length, 1);
  } finally {
    h.close();
  }
});

test("the ARIA fallback lists options without leaving a selection and writes one exact option", async () => {
  const h = setup(select());
  try {
    const options = await h.reader.readOptions(h.row());
    assert.deepEqual(
      JSON.parse(JSON.stringify(options.map((option) => option.label))),
      ["She/her", "He/him", "They/them"],
    );
    assert.equal(h.list.hidden, true);
    assert.equal(h.row().public.filled, false);
    await h.reader.apply(h.row(), "They/them", () => true, {
      source: "rule:test",
    });
    assert.equal(h.box.textContent, "They/them");
    const row = h.row();
    assert.equal(row.public.filled, true);
    assert.equal(h.reader.response(row).response, "They/them");
    assert.equal(
      h.traces.length,
      1,
      "Only the common entrance records the final answer",
    );
    assert(
      h.traces.some(
        (entry) =>
          entry.source === "rule:test" &&
          entry.result === "committed" &&
          entry.chosen === "They/them",
      ),
    );
  } finally {
    h.close();
  }
});

test("a page that ignores the option click leaves the field unconfirmed instead of claiming success", async () => {
  const h = setup(select(), { commit: false });
  try {
    await h.reader.readOptions(h.row());
    await assert.rejects(
      () => h.reader.apply(h.row(), "He/him"),
      /not committed/,
    );
    assert.equal(h.row().public.filled, false);
    assert(
      h.traces.some(
        (entry) =>
          entry.component === "aria-combobox" &&
          entry.result === "not-committed",
      ),
    );
  } finally {
    h.close();
  }
});

test("a search combobox types only a query, then commits the exact listed option", async () => {
  const body = `<label for="major">Major</label><input id="major" role="combobox" aria-controls="major-list" aria-expanded="false" aria-autocomplete="list">
    <ul role="listbox" id="major-list" hidden></ul>`;
  const h = setup(body, { search: true });
  try {
    assert.equal(h.row().public.supported, true);
    const node = await h.w.JobsControlFields.chooseSpec(h.box, "Physics", {
      source: "adapter:test",
    });
    assert.equal(node, h.box);
    assert.equal(h.box.value, "Physics");
    const trace = h.traces.find((entry) => entry.source === "adapter:test");
    assert.equal(trace.result, "committed");
    assert.deepEqual(JSON.parse(JSON.stringify(trace.options)), [
      "Physics",
      "Physical Therapy",
    ]);
  } finally {
    h.close();
  }
  const miss = setup(body, { search: true });
  try {
    assert.equal(
      await miss.w.JobsControlFields.chooseSpec(miss.box, "Astronomy", {
        source: "adapter:test",
      }),
      null,
    );
    // A failed search leaves no typed text that would read as an answer.
    assert.equal(miss.box.value, "");
    assert.equal(miss.row().public.filled, false);
  } finally {
    miss.close();
  }
});

test("unlabelled and multi-select comboboxes stay unsupported", () => {
  const bare = setup(
    `<div role="combobox" aria-controls="x-list">Select...</div><ul role="listbox" id="x-list" hidden><li role="option">A</li></ul>`,
  );
  try {
    assert.equal(bare.row().public.supported, false);
  } finally {
    bare.close();
  }
  const multi = setup(
    select().replace(
      'role="listbox"',
      'role="listbox" aria-multiselectable="true"',
    ),
  );
  try {
    assert.equal(multi.row().public.supported, false);
  } finally {
    multi.close();
  }
});

test("two site components claiming one control keep the first owner and leave one conflict record", () => {
  const h = setup(select());
  try {
    const claim = (name) => ({
      isControl: (node) => node === h.box,
      describe: () => null,
      name,
    });
    h.w.JobsTagControls = claim("tags");
    h.w.JobsMenuControls = claim("menu");
    assert.equal(h.w.JobsControlFields.component(h.box).name, "tags");
    h.w.JobsControlFields.component(h.box);
    const conflicts = h.notes.filter(
      (note) => note.type === "component_conflict",
    );
    assert.equal(conflicts.length, 1);
    assert.deepEqual(JSON.parse(conflicts[0].detail), {
      owner: "tags",
      also: ["menu"],
    });
    // The ARIA fallback never counts as a conflict with a site component.
    delete h.w.JobsMenuControls;
    assert.equal(h.w.JobsControlFields.component(h.box).name, "tags");
  } finally {
    h.close();
  }
});

test("the common scanner holds no site structure; platforms declare it", () => {
  const scanner = functionBlock(fieldsSource, "create");
  assert(
    !/isWorkday|isIcims|isGreenhouse|platform\.id|ashby-application|iCIMS|questionnaire-section|tds-form|data-automation-id|select__|greenhouse|lever|breezy|jazzhr|tesla/i.test(
      scanner,
    ),
  );
});
