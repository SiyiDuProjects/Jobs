import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tagFixture as fixture } from "./helpers/tag-fixtures.mjs";
const plain = (value) => JSON.parse(JSON.stringify(value));
const ultipro = await readModule(
  new URL("../source/content/adapters/ultipro.js", import.meta.url),
  "utf8",
);

test("a tag matching only by containment is a different skill", async () => {
  const f = fixture("seek", { initial: ["JavaScript"] });
  try {
    f.open();
    assert.equal(
      await chooseAnswer(f.editor, ["JavaScript", "Java"], { replace: true }),
      f.editor,
    );
    assert.deepEqual(plain(f.controls.value(f.editor)), ["JavaScript", "Java"]);
  } finally {
    f.close();
  }
});

test("tag reader exposes actual chips once while editing and preserves optional/unknown evidence", async () => {
  for (const kind of ["seek", "ultipro"]) {
    const f = fixture(kind);
    try {
      f.open();
      const first = f.reader.scan();
      assert.equal(first.length, 1, kind);
      assert.equal(first[0].public.type, "select-multiple");
      assert.equal(first[0].public.requiredKnown, false);
      f.editor.setAttribute("aria-required", "false");
      assert.equal(f.reader.state().ready, true);
      const options = await f.reader.readOptions(
        f.reader.scan()[0],
        () => true,
        { answers: ["Python", "C++"] },
      );
      assert.deepEqual(plain(options), [
        { value: "Python", label: "Python" },
        { value: "C++", label: "C++" },
      ]);
      await f.reader.apply(f.reader.scan()[0], ["Python", "C++"]);
      assert.deepEqual(plain(f.controls.value(f.editor)), ["Python", "C++"]);
      assert.equal(f.reader.state().ready, true);
      assert.equal(
        f.events.some((event) => event === "save"),
        false,
        "common component does not save the editor",
      );
    } finally {
      f.close();
    }
  }
});

test("tag queries without a list entry stay unconfirmed; failed add never reports success", async () => {
  for (const kind of ["seek", "ultipro"]) {
    const f = fixture(kind, { accept: false });
    try {
      f.open();
      f.input.value = "Human draft";
      const row = f.reader.scan()[0];
      assert.equal(row.public.commitState, "unconfirmed");
      assert.equal(row.public.filled, false);
      assert.equal(await chooseAnswer(f.editor, ["Python"]), null);
      assert.equal(
        await chooseAnswer(f.editor, ["Python"], {
          replace: true,
          timeout: 20,
        }),
        null,
      );
      assert.deepEqual(plain(f.controls.value(f.editor)), []);
    } finally {
      f.close();
    }
  }
});

test("strict tag add waits for actual chips and honors cancellation or node replacement", async () => {
  for (const change of ["none", "cancel", "replace"]) {
    const f = fixture("seek", { delay: 25 });
    let proceed = true;
    try {
      f.open();
      const pending = chooseAnswer(f.editor, ["Python"], {
        timeout: 70,
        canProceed: () => proceed,
      });
      await new Promise((resolve) => f.window.setTimeout(resolve, 5));
      if (change === "cancel") proceed = false;
      if (change === "replace") f.input.replaceWith(f.input.cloneNode());
      const result = await pending;
      assert.equal(!!result, change === "none");
    } finally {
      f.close();
    }
  }
});

test("our unsuccessful Add remains unconfirmed and is not retried until an actual chip appears", async () => {
  for (const kind of ["seek", "ultipro"]) {
    const f = fixture(kind, { accept: false });
    try {
      f.open();
      assert.equal(
        await chooseAnswer(f.editor, ["Python"], { timeout: 20 }),
        null,
      );
      assert.equal(f.controls.describe(f.editor).commitState, "unconfirmed");
      assert.equal(
        f.window.JobsControlFields.needsAnswer(f.reader.scan()[0].public),
        false,
      );
      const before = f.events.length;
      assert.equal(
        await chooseAnswer(f.editor, ["Python"], { timeout: 20 }),
        null,
      );
      assert.equal(f.events.length, before);
      const chip = f.doc.createElement("li");
      chip.textContent = "Python";
      f.list.append(chip);
      assert.equal(f.controls.describe(f.editor).commitState, undefined);
      assert.deepEqual(plain(f.controls.value(f.editor)), ["Python"]);
    } finally {
      f.close();
    }
  }
});

test("closed lists remain readable; common writer never opens or removes tags", async () => {
  for (const kind of ["seek", "ultipro"]) {
    const f = fixture(kind, { initial: ["Python"] });
    try {
      const row = f.reader.scan()[0];
      assert.equal(row.public.filled, true);
      assert.equal(row.public.supported, false);
      assert.equal(await chooseAnswer(row.node, ["Python", "C++"]), null);
      assert.deepEqual(f.events, []);
      f.open();
      assert.equal(
        await chooseAnswer(f.editor, ["C++"], { replace: true }),
        null,
      );
      assert.deepEqual(plain(f.controls.value(f.editor)), ["Python"]);
    } finally {
      f.close();
    }
  }
});

test("UltiPro Canada host: the adapter opens the editor and adds skills through the tag component", async () => {
  const f = fixture("ultipro", { host: "recruiting.ultipro.ca" });
  try {
    f.window.eval(ultipro);
    await f.window.ultiproFillSkills(["Python"]);
    assert.deepEqual(plain(f.controls.value(f.controls.find(f.doc)[0])), [
      "Python",
    ]);
    f.open();
    const row = f.reader.scan()[0];
    assert.equal(row.public.supported, true);
    await f.reader.apply(row, ["Python", "C++"], () => true, { replace: true });
    assert.deepEqual(plain(f.controls.value(f.editor)), ["Python", "C++"]);
  } finally {
    f.close();
  }
});
