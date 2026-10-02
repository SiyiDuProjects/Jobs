import { chooseAnswer } from "./helpers/choose-answer.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { icimsFixture } from "./helpers/icims-fixture.mjs";

test("strict selection rejects ambiguous and missing options and only reports committed selections", async () => {
  for (const settings of [
    { labels: ["California", "California"] },
    { labels: ["Alabama"], searchedLabels: ["Alabama"] },
    { labels: ["California"], commit: false },
  ]) {
    const h = icimsFixture(settings);
    try {
      assert.equal(await chooseAnswer(h.trigger, "California"), null);
      assert.equal(h.api.value(h.trigger), "");
      assert(!h.trace.includes("WRONG QUESTION"));
    } finally {
      h.close();
    }
  }
});

test("cancellation while waiting and replacement of the control prevent option clicks", async () => {
  for (const replace of [false, true]) {
    const h = icimsFixture({ labels: [], searchedLabels: null });
    let active = true;
    try {
      const pending = chooseAnswer(h.trigger, "California", {
        canProceed: () => active,
      });
      await new Promise((resolve) => h.w.setTimeout(resolve, 12));
      if (replace) h.input.replaceWith(h.input.cloneNode());
      else active = false;
      h.options(["California"]);
      assert.equal(await pending, null);
      assert(!h.trace.some((event) => event.startsWith("option:")));
    } finally {
      h.close();
    }
  }
});

test("read-only discovery groups internal nodes and distinguishes optional search text from a committed value", () => {
  const h = icimsFixture();
  try {
    h.input.value = "California";
    const found = h.api.find(h.doc),
      descriptor = h.api.describe(h.trigger);
    assert.equal(found.length, 2);
    assert.equal(h.trace.length, 0);
    assert.equal(descriptor.value, "");
    assert.equal(descriptor.required, false);
    assert.equal(descriptor.requiredKnown, true);
    assert(descriptor.group.includes(h.input));
    assert(descriptor.group.includes(h.select));
    assert(descriptor.group.includes(h.list));
    assert.equal(descriptor.question, "State/Province");
    assert.equal(descriptor.supported, true);
    const reader = h.w.JobsControlFields.create(h.doc),
      rows = reader.scan();
    const row = rows.find((row) => row.node === h.trigger);
    assert.equal(
      rows.filter((row) => row.public.question === "State/Province").length,
      1,
    );
    assert.equal(row.public.supported, true);
    assert.equal(row.public.filled, false);
    assert.equal(row.public.required, false);
    assert.equal(
      h.w.JobsControlFields.completion(row.public),
      "optional-empty",
    );
  } finally {
    h.close();
  }
});

test("common scanner reads candidates and applies the same strict writer, retaining required and invalid flags", async () => {
  const h = icimsFixture({ required: true });
  try {
    const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
      write: true,
    });
    let row = reader.scan().find((row) => row.node === h.trigger);
    assert.equal(row.public.required, true);
    assert.equal(row.public.filled, false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(await reader.readOptions(row))),
      [
        { label: "Alabama", value: "Alabama" },
        { label: "California", value: "California" },
      ],
    );
    assert.equal(h.api.value(h.trigger), "");
    await reader.apply(row, "California", () => true);
    row = reader.scan().find((row) => row.node === h.trigger);
    assert.equal(row.raw, "California");
    assert.equal(row.public.filled, true);
    h.select.setAttribute("aria-invalid", "true");
    assert.equal(
      reader.scan().find((row) => row.node === h.trigger).public.invalid,
      true,
    );
  } finally {
    h.close();
  }
});

test("candidate reads are cancelled without selecting or altering another question", async () => {
  const h = icimsFixture({ labels: [], searchedLabels: null });
  let active = true;
  try {
    const pending = h.api.readOptions(h.trigger, () => active, {
      answer: "California",
    });
    await new Promise((resolve) => h.w.setTimeout(resolve, 12));
    active = false;
    h.options(["California"]);
    assert.equal((await pending).length, 0);
    assert.equal(h.api.value(h.trigger), "");
    assert(
      !h.trace.some(
        (event) => event.startsWith("option:") || event === "WRONG QUESTION",
      ),
    );
  } finally {
    h.close();
  }
});

test("disabled backing widgets are excluded; readonly search can still select a loaded exact option", async () => {
  const h = icimsFixture({ selected: "California" });
  try {
    h.select.disabled = true;
    let descriptor = h.api.describe(h.trigger);
    assert.equal(descriptor.disabled, true);
    assert.equal(descriptor.supported, false);
    assert.equal(descriptor.readable, true);
    assert.equal(
      await chooseAnswer(h.trigger, "Alabama", { replace: true }),
      null,
    );
    assert.equal(
      h.w.JobsControlFields.create(h.doc)
        .scan()
        .some((row) => row.node === h.trigger),
      false,
    );
    h.select.disabled = false;
    h.input.readOnly = true;
    descriptor = h.api.describe(h.trigger);
    assert.equal(descriptor.disabled, false);
    assert.equal(descriptor.supported, true);
    assert.equal(descriptor.readable, true);
    assert.equal(descriptor.value, "California");
    assert.equal(
      await chooseAnswer(h.trigger, "Alabama", { replace: true }),
      h.trigger,
    );
    assert.equal(h.api.value(h.trigger), "Alabama");
    h.options([]);
    assert.equal(h.api.describe(h.trigger).supported, false);
    assert.equal(
      await chooseAnswer(h.trigger, "California", { replace: true }),
      null,
    );
    h.select.remove();
    h.input.value = "Uncommitted search";
    descriptor = h.api.describe(h.trigger);
    assert.equal(descriptor.readable, false);
    assert.equal(descriptor.value, "");
  } finally {
    h.close();
  }
});

test("strict matching excludes hidden or inert stale candidates and opens a closed popup before rechecking", async () => {
  for (const attribute of ["hidden", "inert"]) {
    const h = icimsFixture({ labels: ["California"], searchedLabels: null });
    try {
      h.list.firstElementChild.setAttribute(attribute, "");
      assert.equal(await chooseAnswer(h.trigger, "California"), null);
      assert(!h.trace.some((event) => event.startsWith("option:")));
    } finally {
      h.close();
    }
  }
  const h = icimsFixture({ labels: ["California"] });
  try {
    h.input.readOnly = true;
    h.list.parentElement.hidden = true;
    h.trigger.addEventListener("click", () => {
      h.list.parentElement.hidden = false;
    });
    assert.equal(await chooseAnswer(h.trigger, "California"), h.trigger);
    assert.equal(h.api.value(h.trigger), "California");
    assert(!h.trace.some((event) => event.startsWith("input:")));
    assert(h.trace.includes("trigger:click"));
  } finally {
    h.close();
  }
});

test("reusing the same nodes for a different question cancels choose, common apply, and candidate reads", async () => {
  for (const operation of ["choose", "apply", "readOptions"]) {
    const h = icimsFixture({ labels: [], searchedLabels: null });
    try {
      const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
        write: true,
      });
      const row = reader.scan().find((row) => row.node === h.trigger);
      const pending =
        operation === "choose"
          ? chooseAnswer(h.trigger, "California")
          : operation === "readOptions"
            ? h.api.readOptions(h.trigger, () => true, { answer: "California" })
            : reader
                .apply(row, "California", () => true)
                .then(
                  () => "accepted",
                  (error) => error,
                );
      await new Promise((resolve) => h.w.setTimeout(resolve, 12));
      h.doc.querySelector('label[for="state"]').textContent =
        "Previous residence";
      const traceAtChange = h.trace.length;
      h.options(["California"]);
      const result = await pending;
      if (operation === "choose") assert.equal(result, null);
      else if (operation === "readOptions") assert.equal(result.length, 0);
      else assert.match(result.message, /not committed/);
      assert.equal(h.api.value(h.trigger), "");
      assert.equal(h.api.cachedOptions(h.trigger), undefined);
      assert.equal(
        h.trace.length,
        traceAtChange,
        "No option click or search cleanup may operate on the replacement question",
      );
    } finally {
      h.close();
    }
  }
});

test("a cleared required search input is not invalid after the backing select commits", () => {
  const h = icimsFixture({ selected: "California", required: true });
  try {
    h.input.required = true;
    h.input.value = "";
    assert.equal(h.api.describe(h.trigger).invalid, false);
    assert.equal(
      h.w.JobsControlFields.create(h.doc)
        .scan()
        .find((row) => row.node === h.trigger).public.invalid,
      false,
    );
    h.input.setAttribute("aria-invalid", "true");
    assert.equal(
      h.api.describe(h.trigger).invalid,
      true,
      "Explicit website validation errors still win",
    );
  } finally {
    h.close();
  }
});
