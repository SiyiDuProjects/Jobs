import { chooseAnswer } from "./helpers/choose-answer.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, kinds } from "./helpers/ats-choice-fixtures.mjs";

for (const kind of kinds)
  test(`${kind}: shared scanner and writer read committed value without duplicate search fields`, async () => {
    const h = await fixture(kind);
    try {
      let rows = h.reader.scan();
      assert.equal(rows.length, kind === "tiktok-month" ? 2 : 1);
      const row = rows.find((row) => row.node === h.control);
      assert(row, JSON.stringify(rows.map((row) => row.public)));
      assert.equal(row.public.filled, false);
      assert.equal(h.reader.state().ready, false);
      const answer = kind === "tiktok-month" ? "2027-05" : "Daytime";
      if (kind !== "tiktok-month") {
        const options = await h.reader.readOptions(row);
        assert.equal(options.length, 2);
        assert(options.some((option) => option.value === answer));
      }
      await h.reader.apply(row, answer);
      rows = h.reader.scan();
      assert.equal(rows.length, kind === "tiktok-month" ? 2 : 1);
      const committed = rows.find((row) => row.node === h.control);
      assert.equal(committed.raw, answer);
      assert.equal(committed.public.completion, "filled");
      assert.equal(h.reader.response(committed).response, answer);
      assert.equal(h.reader.state().ready, true);
      assert.doesNotThrow(() => JSON.stringify(committed.public));
    } finally {
      h.close();
    }
  });

test("Paylocity never falls back to the first option", async () => {
  const h = await fixture("paylocity-search");
  try {
    assert.equal(
      await chooseAnswer(h.control, "Unlisted", { timeout: 25 }),
      null,
    );
    assert.equal(h.api.value(h.control), "");
    assert(!h.doc.querySelector('[aria-selected="true"]'));
  } finally {
    h.close();
  }
});

test("remembered editable selection is invalidated when the same input is reused for another question", async () => {
  const h = await fixture("eightfold-combobox");
  try {
    h.control.readOnly = false;
    assert.equal(await chooseAnswer(h.control, "Daytime"), h.control);
    assert.equal(h.api.value(h.control), "Daytime");
    h.control.setAttribute("aria-label", "New question*");
    assert.equal(h.control.value, "Daytime");
    assert.equal(h.api.value(h.control), "");
    assert.equal(
      h.reader.scan().find((row) => row.node === h.control).public.filled,
      false,
    );
  } finally {
    h.close();
  }
});

test("an uncommitted click is not a committed answer", async () => {
  for (const kind of [
    "paylocity-dropdown",
    "eightfold-question",
    "eightfold-combobox",
    "tiktok-dropdown",
  ]) {
    const h = await fixture(kind, { uncommitted: true });
    try {
      assert.equal(
        await chooseAnswer(h.control, "Daytime", { timeout: 25 }),
        null,
      );
      assert.equal(h.api.value(h.control), "");
    } finally {
      h.close();
    }
  }
});

test("a changed Eightfold input cancels a pending option load before selecting", async () => {
  const h = await fixture("eightfold-combobox");
  try {
    const list = h.doc.querySelector("ul");
    list.replaceChildren();
    const pending = chooseAnswer(h.control, "Daytime", { timeout: 30 });
    h.control.value = "Manual edit";
    h.control.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    const option = h.doc.createElement("li");
    option.innerHTML = '<button type="button" role="option">Daytime</button>';
    list.append(option);
    let clicked = false;
    option.querySelector("button").onclick = () => (clicked = true);
    assert.equal(await pending, null);
    assert.equal(clicked, false);
    assert.equal(h.control.value, "Manual edit");
  } finally {
    h.close();
  }
});

test("partial virtual TikTok options remain unknown instead of choosing the first rendered item", async () => {
  const h = await fixture("tiktok-disclosure", { virtualComplete: false });
  try {
    assert.deepEqual(Array.from(await h.api.readOptions(h.control)), []);
    assert.equal(
      await chooseAnswer(h.control, "Daytime", { timeout: 25 }),
      null,
    );
    assert.equal(h.api.value(h.control), "");
  } finally {
    h.close();
  }
});

test("requiredness is independent of support and cancellation prevents clicks", async () => {
  const h = await fixture("paylocity-dropdown");
  try {
    h.control.removeAttribute("aria-required");
    h.control.setAttribute("aria-label", "Preferred schedule");
    assert.equal(h.reader.scan()[0].public.completion, "unknown-requiredness");
    h.control.setAttribute("aria-required", "false");
    assert.equal(h.reader.scan()[0].public.completion, "optional-empty");
    assert.equal(h.reader.state().ready, true);
    const before = h.trace.length;
    assert.equal(
      await chooseAnswer(h.control, "Daytime", { canProceed: () => false }),
      null,
    );
    assert.equal(h.trace.length, before);
    h.control.setAttribute("aria-disabled", "true");
    assert.equal(h.api.describe(h.control).supported, false);
  } finally {
    h.close();
  }
});

test("Eightfold multiple checkbox values are one field and exact answers preserve each chosen input", async () => {
  const h = await fixture("eightfold-choice", { multi: true });
  try {
    const rows = h.reader.scan();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public.type, "select-multiple");
    await h.reader.apply(rows[0], ["Daytime", "Nighttime"]);
    assert.deepEqual(Array.from(h.reader.scan()[0].raw), [
      "Daytime",
      "Nighttime",
    ]);
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("TikTok month accepts only real month precision and preserves independent start/end controls", async () => {
  const h = await fixture("tiktok-month");
  try {
    for (const answer of ["2027", "2027-13", "Spring 2027", "2027-05-01"])
      assert.equal(await chooseAnswer(h.control, answer), null);
    assert.equal(h.trace.length, 0);
    assert.equal(h.api.monthValue("May 2027"), "2027-05");
    assert.equal(h.api.monthValue("05/2027"), "2027-05");
    h.control.textContent = "Spring 2027";
    const row = h.reader.scan().find((row) => row.node === h.control);
    assert.equal(row.public.completion, "unreadable");
    assert.equal(h.reader.scan().length, 2);
  } finally {
    h.close();
  }
});
