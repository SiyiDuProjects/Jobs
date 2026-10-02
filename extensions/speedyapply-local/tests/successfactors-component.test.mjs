import { chooseAnswer } from "./helpers/choose-answer.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { successfactorsFixture as fixture } from "./helpers/successfactors-fixture.mjs";

const fillers = (count = 100) =>
  Array.from({ length: count }, (_, index) => `Other ${index}`);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("the common writer requires a unique exact label across pages", async () => {
  const f = fixture({
    pages: [["Northern California", "California", "No Selection"]],
  });
  try {
    const row = f.reader.scan()[0];
    assert.equal(row.public.component, "successfactors-paged");
    assert.equal(row.public.type, "combobox");
    assert.deepEqual(plain(await f.reader.readOptions(row)), [
      { value: "Northern California", label: "Northern California" },
      { value: "California", label: "California" },
    ]);
    await f.reader.apply(row, "California");
    assert.equal(f.input.value, "California");
    assert.equal(f.reader.scan()[0].public.filled, true);
    assert.deepEqual(
      f.events.filter((event) => event.startsWith("option:click")),
      ["option:click:California"],
    );
  } finally {
    f.close();
  }
  const ambiguous = fixture({
    pages: [["California", ...fillers(99)], ["California"]],
  });
  try {
    assert.equal(await chooseAnswer(ambiguous.input, "California"), null);
    assert.equal(ambiguous.input.value, "");
    assert.equal(
      ambiguous.events.some((event) => event.startsWith("option:click")),
      false,
    );
  } finally {
    ambiguous.close();
  }
});

test("pages continue only after exactly 100 options and stop after five pages", async () => {
  for (const pages of [
    [fillers(99), ["Target"]],
    [fillers(), fillers(), fillers(), fillers(), fillers(), ["Target"]],
  ]) {
    const f = fixture({ pages });
    try {
      assert.equal(await chooseAnswer(f.input, "Target"), null);
      assert.equal(
        f.events.filter((event) => event.startsWith("scroll:")).length,
        pages.length === 2 ? 1 : 5,
      );
    } finally {
      f.close();
    }
  }
  const capped = fixture({
    pages: Array.from({ length: 5 }, (_, page) =>
      fillers().map((label) => page + label),
    ),
  });
  try {
    assert.deepEqual(
      plain(await capped.controls.readOptions(capped.input)),
      [],
    );
  } finally {
    capped.close();
  }
});

test("readonly or explicit selected values are readable without opening; typed queries remain empty", () => {
  for (const readonly of [true, false]) {
    const f = fixture({
      initial: "California",
      readonly,
      selected: readonly ? "" : "California",
    });
    try {
      if (!readonly) f.open();
      const row = f.reader.scan()[0];
      assert.equal(row.public.filled, true);
      assert.equal(f.controls.value(f.input), "California");
      assert.deepEqual(f.events, []);
    } finally {
      f.close();
    }
  }
  const f = fixture({ initial: "California" });
  try {
    assert.equal(f.reader.scan()[0].public.filled, false);
    assert.equal(f.controls.value(f.input), "");
    assert.deepEqual(f.events, []);
  } finally {
    f.close();
  }
});

test("common scan groups internals once and keeps optional versus unknown requiredness distinct", async () => {
  for (const required of [true, false, undefined]) {
    const f = fixture({ required });
    try {
      const rows = f.reader.scan();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].public.supported, true);
      assert.equal(rows[0].public.required, required === true);
      assert.equal(rows[0].public.requiredKnown, required !== undefined);
      assert.equal(f.reader.state().ready, required === false);
      if (required === undefined)
        assert.equal(
          f.reader.state().blockers[0].reason,
          "unknown-requiredness",
        );
      assert.deepEqual(f.events, []);
    } finally {
      f.close();
    }
  }
});

test("strict writer rejects disabled, partial and uncommitted choices", async () => {
  for (const answer of ["Cal", "Disabled"]) {
    const f = fixture({
      pages: [["California", { label: "Disabled", disabled: true }]],
    });
    try {
      await assert.rejects(
        f.reader.apply(f.reader.scan()[0], answer),
        /not committed/,
      );
      assert.equal(f.input.value, "");
      assert.equal(
        f.events.some((event) => event.startsWith("option:click")),
        false,
      );
    } finally {
      f.close();
    }
  }
  for (const initial of ["", "California"]) {
    const f = fixture({ commitValue: false, initial });
    try {
      assert.equal(
        await chooseAnswer(f.input, "California", { timeout: 25 }),
        null,
      );
      assert.equal(f.controls.value(f.input), "");
      assert.equal(f.reader.scan()[0].public.filled, false);
    } finally {
      f.close();
    }
  }
});

test("later-page cancellation, replacement, question drift and concurrent editing never select", async () => {
  for (const change of ["cancel", "replace", "question", "edit"]) {
    const f = fixture({ pages: [fillers(), ["California"]], delay: 35 });
    let proceed = true;
    try {
      const pending = chooseAnswer(f.input, "California", {
        canProceed: () => proceed,
        timeout: 100,
      });
      await new Promise((resolve) => f.window.setTimeout(resolve, 5));
      if (change === "cancel") proceed = false;
      if (change === "replace") f.input.replaceWith(f.input.cloneNode());
      if (change === "question")
        f.doc.querySelector("label").textContent = "Other question";
      if (change === "edit") {
        f.input.value = "Human search";
        f.input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
      }
      assert.equal(await pending, null);
      assert.equal(
        f.events.some((event) => event.startsWith("option:click")),
        false,
      );
      if (change === "edit") assert.equal(f.input.value, "Human search");
    } finally {
      f.close();
    }
  }
});

test("strict preservation prevents overwriting existing selection without explicit replace", async () => {
  const f = fixture({ readonly: true, initial: "Alaska" });
  try {
    assert.equal(await chooseAnswer(f.input, "California"), null);
    assert.equal(
      await chooseAnswer(f.input, "Alaska", { canProceed: () => false }),
      null,
    );
    assert.deepEqual(f.events, []);
    await f.reader.apply(f.reader.scan()[0], "California", () => true, {
      replace: true,
    });
    assert.equal(f.controls.value(f.input), "California");
  } finally {
    f.close();
  }
});

test("recognition requires numeric SuccessFactors selectContainer linkage", () => {
  const f = fixture();
  try {
    const generic = f.doc.createElement("input");
    generic.id = "city";
    generic.setAttribute("role", "combobox");
    f.doc.body.append(generic);
    assert.equal(f.controls.isControl(generic), false);
    assert.equal(f.controls.find(f.doc).length, 1);
    f.input.id = "generic-input";
    assert.equal(f.controls.isControl(f.input), false);
  } finally {
    f.close();
  }
});

test("two canonical dropdowns in one outer container do not swallow each other", () => {
  const f = fixture();
  try {
    const other = f.input.cloneNode();
    other.id = "120:_input";
    other.setAttribute("aria-label", "State");
    f.input.parentElement.append(other);
    assert.equal(f.controls.find(f.doc).length, 2);
    assert.equal(f.controls.describe(f.input).group.includes(other), false);
    assert.equal(f.controls.describe(other).group.includes(f.input), false);
    assert.equal(f.reader.scan().length, 2);
  } finally {
    f.close();
  }
});

test("shared operation keeps click diagnostics and adds page counts without changing selection events", async () => {
  const f = fixture({ pages: [fillers(), ["California"]] }),
    actions = [],
    pages = [];
  try {
    f.window.JobsDiagnostics = {
      perform(name, target, run) {
        actions.push([name, target().tagName]);
        return run();
      },
      note(name, target, detail) {
        if (name === "auto_options_page") pages.push(JSON.parse(detail));
      },
    };
    await chooseAnswer(f.input, "California");
    assert.deepEqual(actions, [
      ["click", "INPUT"],
      ["click", "LI"],
    ]);
    assert.deepEqual(
      pages.map((page) => [page.page, page.count]),
      [
        [0, 100],
        [1, 1],
      ],
    );
  } finally {
    f.close();
  }
});
