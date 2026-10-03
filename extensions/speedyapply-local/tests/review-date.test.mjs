import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const codes = await Promise.all(
  ["control-fields", "review-presenter", "ai-review"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function setup() {
  const dom = new JSDOM(
    `<form><div data-automation-id="formField-date"><fieldset><legend>Available date *</legend><div data-automation-id="dateInputWrapper">${["Month", "Day", "Year"].map((part) => `<input data-automation-id="dateSection${part}-input">`).join("")}</div></fieldset></div></form>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    listeners = [],
    writes = [];
  w.chrome = {
    runtime: {
      id: "fixture",
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(
    w.HTMLInputElement.prototype,
    "value",
  );
  Object.defineProperty(w.HTMLInputElement.prototype, "value", {
    ...descriptor,
    set(value) {
      if (this.type === "date") writes.push(value);
      descriptor.set.call(this, value);
    },
  });
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("form"),
    reader = w.JobsControlFields.create(w.document, () => root, {
      write: true,
    });
  w.JobsAIReview.add(root, reader, reader.scan()[0], { needsInput: true });
  w.JobsAIReview.ready(async () => {}, "fill");
  const shadow = () => w.document.querySelector("#jobs-ai-review").shadowRoot;
  return {
    w,
    reader,
    listeners,
    writes,
    shadow,
    editor: () => shadow().querySelector("input"),
    async setParts(values) {
      [...root.querySelectorAll("input")].forEach((node, index) => {
        node.value = values[index];
      });
      root
        .querySelector("input")
        .dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close: () => w.close(),
  };
}

test("Workday partial date typing never sends masked or invalid dates into the review date input", async () => {
  const h = setup();
  try {
    for (const parts of [
      ["1", "", ""],
      ["12", "", ""],
      ["12", "2", ""],
      ["12", "23", "1"],
      ["12", "23", ""],
      ["12", "23", "2"],
      ["12", "23", "20"],
      ["12", "23", "202"],
      ["2", "30", "2027"],
    ]) {
      await h.setParts(parts);
      assert.equal(h.editor().value, "");
      assert.deepEqual(
        [...h.w.document.querySelectorAll("form input")].map(
          (node) => node.value,
        ),
        parts,
        "review must not change the page while typing",
      );
      assert.equal(h.reader.scan()[0].public.invalid, true);
    }
    assert(
      h.writes.every((value) => value === ""),
      "invalid source values must never reach the native setter",
    );
    await h.setParts(["12", "23", "2027"]);
    assert.equal(h.editor().value, "2027-12-23");
    assert.equal(h.reader.scan()[0].public.invalid, false);
    await h.setParts(["", "", ""]);
    assert.equal(
      h.editor().value,
      "",
      "cleared source must clear the mirrored date",
    );
  } finally {
    h.close();
  }
});

test("review normalizes complete dates from relayed rows and rejects incomplete or impossible ones", () => {
  const h = setup();
  try {
    h.w.JobsAIReview.release(h.w.document.querySelector("form"));
    h.writes.length = 0;
    for (const [value, expected] of [
      ["12/23/2027", "2027-12-23"],
      ["2028-02-29", "2028-02-29"],
      ["2027-02-29", ""],
      ["12/23/20", ""],
      ["0000-01-01", ""],
      [null, ""],
    ]) {
      for (const listener of h.listeners)
        listener(
          {
            type: "jobs:review-view",
            id: "date",
            sourceDocumentId: "frame",
            data: {
              id: "date",
              items: [
                {
                  id: "0",
                  question: "Available date",
                  editor: {
                    kind: "text",
                    inputType: "date",
                    value,
                    version: 1,
                  },
                },
              ],
            },
          },
          { id: "fixture" },
          () => {},
        );
      assert.equal(h.editor().value, expected);
    }
    assert.deepEqual(h.writes, ["2027-12-23", "2028-02-29", "", "", "", ""]);
  } finally {
    h.close();
  }
});

test("a review date draft survives source typing and cannot overwrite a newer source date", async () => {
  const h = setup();
  try {
    h.editor().value = "2028-01-05";
    h.editor().oninput();
    await h.setParts(["12", "23", "20"]);
    assert.equal(h.editor().value, "2028-01-05");
    await h.setParts(["12", "23", "2027"]);
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(
      h.shadow().querySelector(".error").textContent,
      /页面选项已变化/,
    );
    assert.equal(h.reader.scan()[0].raw, "2027-12-23");
  } finally {
    h.close();
  }
});

async function failedDraft(h, value = "2030-05-09") {
  let writes = 0;
  h.w.JobsFormPipeline = {
    ...h.w.JobsFormPipeline,
    write: async () => {
      writes++;
      return { ok: false, reason: "Synthetic date did not commit" };
    },
  };
  h.editor().value = value;
  h.editor().oninput();
  await h.shadow().querySelector(".review-row").flush();
  return () => writes;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a failed date draft completed manually retires without rewriting and still confirms normally", async () => {
  const h = setup();
  let confirmed = 0,
    validated = 0;
  try {
    h.w.JobsAIReview.ready(
      async () => {
        confirmed++;
      },
      "fill",
      {
        validate: async () => {
          validated++;
        },
      },
    );
    const writes = await failedDraft(h);
    await h.setParts(["5", "9", "2030"]);
    assert.equal(h.reader.scan()[0].public.invalid, false);
    h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
    await settle();
    assert.equal(confirmed, 1);
    assert.equal(writes(), 1, "manual correction must not be rewritten");
    assert.equal(validated, 2, "retiring a draft retains context validation");
    assert.equal(h.editor().draftVersion, null);
    assert.equal(h.shadow().querySelector(".error").textContent, "");
    h.w.JobsAIReview.remoteState(h.w.document.querySelector("form"));
    h.w.JobsReviewPresenter.expand();
    assert.equal(h.shadow().querySelector(".error").textContent, "");
  } finally {
    h.close();
  }
});

test("a different manual date requires explicitly keeping the page value and never rewrites the draft", async () => {
  const h = setup();
  let confirmed = 0;
  try {
    h.w.JobsAIReview.ready(async () => {
      confirmed++;
    }, "fill");
    const writes = await failedDraft(h);
    await h.setParts(["6", "10", "2030"]);
    h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
    await settle();
    assert.equal(confirmed, 0);
    assert.equal(h.editor().value, "2030-05-09");
    assert.equal(h.reader.scan()[0].raw, "2030-06-10");
    const usePage = [...h.shadow().querySelectorAll("button")].find(
      (node) => node.textContent === "使用网页当前值",
    );
    assert(usePage);
    usePage.onclick({ isTrusted: true });
    await settle();
    assert.equal(h.editor().value, "2030-06-10");
    assert.equal(h.editor().draftVersion, null);
    assert.equal(h.shadow().querySelector(".error").textContent, "");
    h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
    await settle();
    assert.equal(confirmed, 1);
    assert.equal(writes(), 1);
  } finally {
    h.close();
  }
});

for (const submitted of [false, true])
  test(`a new unsaved date draft is retained even when the page matches (earlier failed input: ${submitted})`, async () => {
    const h = setup();
    let confirmed = 0;
    try {
      h.w.JobsAIReview.ready(async () => {
        confirmed++;
      }, "fill");
      if (submitted) await failedDraft(h);
      h.editor().value = "2030-06-10";
      h.editor().oninput();
      await h.setParts(["6", "10", "2030"]);
      h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
      await settle();
      assert.equal(confirmed, 0);
      assert.equal(h.editor().value, "2030-06-10");
      assert.notEqual(h.editor().draftVersion, null);
    } finally {
      h.close();
    }
  });

for (const parts of [
  ["", "", ""],
  ["5", "", "2030"],
  ["2", "30", "2030"],
])
  test(`an incomplete or invalid page date cannot retire a failed draft: ${parts.join("/")}`, async () => {
    const h = setup();
    let confirmed = 0;
    try {
      h.w.JobsAIReview.ready(async () => {
        confirmed++;
      }, "fill");
      const writes = await failedDraft(h);
      await h.setParts(parts);
      h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
      await settle();
      assert.equal(confirmed, 0);
      assert.notEqual(h.editor().draftVersion, null);
      assert.equal(h.editor().value, "2030-05-09");
      assert.equal(writes(), parts.every((part) => !part) ? 2 : 1);
    } finally {
      h.close();
    }
  });

for (const missing of ["schemaVersion", "valid"])
  test(`legacy review rows without ${missing} never auto-retire a draft`, async () => {
    const h = setup();
    let confirmed = 0;
    const presenter = h.w.JobsReviewPresenter;
    h.w.JobsReviewPresenter = {
      ...presenter,
      show(data, act) {
        for (const row of data?.items || []) delete row.editor?.[missing];
        presenter.show(data, act);
      },
    };
    try {
      h.w.JobsAIReview.ready(async () => {
        confirmed++;
      }, "fill");
      const writes = await failedDraft(h);
      await h.setParts(["5", "9", "2030"]);
      h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
      await settle();
      assert.equal(confirmed, 0);
      assert.notEqual(h.editor().draftVersion, null);
      assert.equal(writes(), 1);
    } finally {
      h.close();
    }
  });

test("accepting a page correction still rejects stale remote versions and expired context", async () => {
  const h = setup();
  try {
    const writes = await failedDraft(h),
      root = h.w.document.querySelector("form");
    const before = h.w.JobsAIReview.remoteState(root);
    await h.setParts(["5", "9", "2030"]);
    const current = h.w.JobsAIReview.remoteState(root);
    for (const [version, allowed] of [
      [before.items[0].version, true],
      [current.items[0].version, false],
    ]) {
      const result = await h.w.JobsAIReview.remoteAnswer(
        root,
        current.id,
        "0",
        {
          version,
          value: "2030-05-09",
          acceptCurrent: true,
        },
        () => allowed,
      );
      assert(result.error);
    }
    assert.equal(writes(), 1);
    assert.notEqual(h.editor().draftVersion, null);
    assert.equal(h.reader.scan()[0].raw, "2030-05-09");
  } finally {
    h.close();
  }
});

for (const ok of [true, false])
  test(`a late card answer receipt preserves a newer draft (success: ${ok})`, async () => {
    const h = setup(),
      receipt = Promise.withResolvers();
    let confirmed = 0,
      answers = 0;
    try {
      h.w.JobsAIReview.release(h.w.document.querySelector("form"));
      const act = async (action) => {
        if (action === "confirm") {
          confirmed++;
          return { ok: true };
        }
        answers++;
        return receipt.promise;
      };
      const render = (version, value) =>
        h.w.JobsReviewPresenter.show(
          {
            id: "late-receipt",
            canConfirm: true,
            items: [
              {
                id: "0",
                question: "Available date",
                editor: {
                  kind: "text",
                  inputType: "date",
                  schemaVersion: 1,
                  valid: true,
                  version,
                  value,
                },
              },
            ],
          },
          act,
        );
      render(1, "2030-01-01");
      h.editor().value = "2030-05-09";
      h.editor().oninput();
      h.shadow().querySelector("#confirm").onclick({ isTrusted: true });
      await settle();
      assert.equal(answers, 1);
      // A relayed source refresh can precede the answer reply and re-enable the
      // top-frame editor, allowing a real newer edit while that reply is pending.
      render(2, "2030-05-09");
      assert.equal(h.editor().disabled, false);
      h.editor().value = "2030-06-10";
      h.editor().oninput();
      receipt.resolve(ok ? { ok: true } : { error: "Synthetic delayed error" });
      await settle();
      assert.equal(h.editor().value, "2030-06-10");
      assert.equal(h.editor().draftVersion, 2);
      assert.equal(h.editor().failedDraft, false);
      assert.equal(confirmed, 0);
    } finally {
      receipt.resolve({ ok: true });
      h.close();
    }
  });
