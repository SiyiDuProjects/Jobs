import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { menuFixture } from "./helpers/menu-fixtures.mjs";

test("generic input containers on other platforms are not claimed as ADP menus", async () => {
  const dom = new JSDOM(
    '<div class="input-container"><input role="combobox" aria-controls="choices"></div>',
    {
      url: "https://example.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  try {
    dom.window.eval(
      await readModule(
        new URL("../src/custom/menu-controls.js", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(
      dom.window.JobsMenuControls.find(dom.window.document).length,
      0,
    );
  } finally {
    dom.window.close();
  }
});

test("public candidate reading rejects stale question rows before opening a menu", async () => {
  const h = menuFixture("bamboohr");
  try {
    const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
        write: true,
      }),
      row = reader.scan().find((row) => row.node === h.node);
    h.doc.querySelector("#target-field label").textContent =
      "Replacement question";
    assert.equal((await reader.readOptions(row)).length, 0);
    assert.equal(h.trace.length, 0);
    assert.equal(
      (
        await reader.readOptions(
          reader.scan().find((row) => row.node === h.node),
          () => false,
        )
      ).length,
      0,
    );
    assert.equal(h.trace.length, 0);
  } finally {
    h.close();
  }
});

test("manual input while a Bamboo menu opens cancels before any option is chosen rather than being ignored as our action", async () => {
  const h = menuFixture("bamboohr", { delay: 45 });
  try {
    const addListener = h.node.addEventListener.bind(h.node);
    let inputListener;
    h.node.addEventListener = (type, listener, ...args) => {
      if (type === "input") inputListener = listener;
      return addListener(type, listener, ...args);
    };
    const result = chooseAnswer(h.node, "Beta");
    await new Promise((resolve) => h.w.setTimeout(resolve, 20));
    assert.equal(typeof inputListener, "function");
    inputListener({ isTrusted: true });
    assert.equal(await result, null);
    assert(!h.trace.some((event) => event.includes(":option:click:")));
  } finally {
    h.close();
  }
});

test("menu candidate cache is bound to the page URL", async () => {
  const h = menuFixture("adp");
  try {
    assert.equal((await h.api.readOptions(h.node)).length, 2);
    assert.equal(h.api.cachedOptions(h.node).length, 2);
    h.w.history.replaceState({}, "", "/another-application");
    assert.equal(h.api.cachedOptions(h.node), undefined);
  } finally {
    h.close();
  }
});

test("selected Dayforce labels are not invalidated by an empty internal required search input", async () => {
  const h = menuFixture("dayforce", { nativeBacking: false });
  try {
    h.node.required = true;
    let rejectSelection = false;
    h.doc.addEventListener("click", (event) => {
      if (event.target.getAttribute?.("role") !== "option") return;
      h.node.value = "";
      if (rejectSelection) h.node.setAttribute("aria-invalid", "true");
    });
    const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
      write: true,
    });
    await reader.apply(
      reader.scan().find((row) => row.node === h.node),
      "Beta",
    );
    assert.equal(h.node.validity.valueMissing, true);
    assert.equal(h.api.value(h.node), "Beta");
    assert.equal(h.api.describe(h.node).invalid, false);
    assert.equal(
      reader.scan().find((row) => row.node === h.node).public.completion,
      "filled",
    );
    h.node
      .closest(".ant-select")
      .querySelector(".ant-select-selection-item")
      .remove();
    rejectSelection = true;
    await assert.rejects(
      reader.apply(
        reader.scan().find((row) => row.node === h.node),
        "Alpha",
        () => true,
        { replace: true },
      ),
      /still fails validation/,
    );
    assert.equal(h.api.describe(h.node).invalid, true);
  } finally {
    h.close();
  }
});

for (const type of ["adp", "bamboohr", "dayforce"]) {
  test(`${type}: strict component chooses a unique exact option through the public scanner`, async () => {
    const h = menuFixture(type, { required: true });
    try {
      const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
        write: true,
      });
      let row = reader.scan().find((row) => row.node === h.node);
      assert(row);
      assert.equal(row.public.supported, true);
      assert.equal(row.public.required, true);
      assert.equal(
        reader.scan().filter((row) => row.public.question === "Question*")
          .length,
        1,
      );
      const choices = await reader.readOptions(row);
      assert.deepEqual(JSON.parse(JSON.stringify(choices)), [
        { value: "Alpha", label: "Alpha" },
        { value: "Beta", label: "Beta" },
      ]);
      await reader.apply(row, "Beta");
      row = reader.scan().find((row) => row.node === h.node);
      assert.equal(row.raw, "Beta");
      assert.equal(row.public.filled, true);
      assert(!h.trace.some((value) => value.startsWith("other:")));
    } finally {
      h.close();
    }
  });
  test(`${type}: ambiguous options fail and an unconfirmed click is not a committed answer`, async () => {
    const ambiguous = menuFixture(type, { labels: ["Beta", "Beta"] }),
      noCommit = menuFixture(type, { commit: false, nativeBacking: false });
    try {
      assert.equal(await chooseAnswer(ambiguous.node, "Beta"), null);
      assert(
        !ambiguous.trace.some((value) => value.includes(":option:click:")),
      );
      assert.equal(await chooseAnswer(noCommit.node, "Beta"), null);
      assert(
        noCommit.trace.some((value) => value.includes(":option:click:Beta")),
      );
      assert.equal(noCommit.api.value(noCommit.node), "");
      assert.equal(
        noCommit.api.describe(noCommit.node).commitState,
        "unconfirmed",
      );
      assert.equal(
        noCommit.w.JobsControlFields.completion(
          noCommit.w.JobsControlFields.create(noCommit.doc)
            .scan()
            .find((row) => row.node === noCommit.node).public,
        ),
        "unconfirmed",
      );
    } finally {
      ambiguous.close();
      noCommit.close();
    }
  });
  test(`${type}: optionality, unavailable readback, and cancellation stay separate`, async () => {
    const optional = menuFixture(type, {
        labelledOptional: true,
        nativeBacking: false,
      }),
      unknown = menuFixture(type, { nativeBacking: false });
    try {
      assert.equal(optional.api.describe(optional.node).requiredKnown, true);
      assert.equal(optional.api.describe(optional.node).required, false);
      assert.equal(unknown.api.describe(unknown.node).requiredKnown, false);
      assert.equal(
        await chooseAnswer(optional.node, "Beta", { canProceed: () => false }),
        null,
      );
      assert.equal(optional.trace.length, 0);
      if (type !== "dayforce")
        assert.equal(unknown.api.describe(unknown.node).readable, false);
    } finally {
      optional.close();
      unknown.close();
    }
  });
}

test("strict ADP cannot use an unrelated already open popup when its own popup is delayed", async () => {
  const h = menuFixture("adp", { delay: 25 });
  try {
    h.popup("other", ["Beta"]);
    const pending = chooseAnswer(h.node, "Beta");
    await new Promise((resolve) => h.w.setTimeout(resolve, 10));
    assert(!h.trace.some((value) => value.includes(":option:click:")));
    assert.equal(await pending, h.node);
    assert(!h.trace.some((value) => value.startsWith("other:option:")));
  } finally {
    h.close();
  }
});

test("same-node question changes cancel waiting menus without clicking or cleaning up the replacement field", async () => {
  for (const type of ["adp", "bamboohr", "dayforce"]) {
    const h = menuFixture(type, { delay: 45 });
    try {
      const pending = chooseAnswer(h.node, "Beta");
      await new Promise((resolve) => h.w.setTimeout(resolve, 10));
      h.doc.querySelector("#target-field label").textContent = "New question";
      assert.equal(await pending, null);
      assert(!h.trace.some((value) => value.includes(":option:click:")));
    } finally {
      h.close();
    }
  }
});

test("a rule answer is searched and committed in one menu transaction: Dayforce types its term once", async () => {
  const h = menuFixture("dayforce", { labels: ["Alpha", "Beta"] });
  try {
    const typed = [];
    h.node.addEventListener("input", () => typed.push(h.node.value));
    assert(
      await h.w.JobsControlFields.chooseSpec(
        h.node,
        h.w.JobsProfileAnswers.literalSpec("known-answer", "Alpha"),
      ),
    );
    assert.equal(
      typed.filter((value) => value === "Alpha").length,
      1,
      JSON.stringify(typed),
    );
    assert.equal(h.api.value(h.node), "Alpha");
  } finally {
    h.close();
  }
});
