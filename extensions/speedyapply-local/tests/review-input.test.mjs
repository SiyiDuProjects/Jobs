import { confirmedAnswer } from "./helpers/verified-answer.mjs";
import { mountReviewPanel } from "./helpers/review-panel.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const codes = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read) {
  for (let i = 0; i < 250; i++) {
    if (read()) return;
    await delay(10);
  }
  assert.fail("Review did not update");
}
function setup(html, url = "https://fixture.myworkdayjobs.com/apply") {
  const dom = new JSDOM(
      `<form>${html}</form><button id="next">Save and Continue</button>`,
      { url, runScripts: "outside-only" },
    ),
    w = dom.window;
  let clicks = 0,
    requests = 0,
    profile = { profileName: "Fixture" },
    bound = profile;
  const messages = [],
    storage = new Set();
  w.chrome = {
    storage: {
      onChanged: {
        addListener: (fn) => storage.add(fn),
        removeListener: (fn) => storage.delete(fn),
      },
    },
    runtime: {
      id: "fixture",
      onMessage: { addListener: (fn) => messages.push(fn) },
      sendMessage: async (msg) => {
        if (msg.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile: bound, tabId: 1 } };
        requests++;
        return {
          data: {
            answers: msg.fields.map((field) =>
              confirmedAnswer(field, {
                fieldId: field.fieldId,
                state: "needs_input",
                value: null,
                source: "unknown",
                questionZh: "请你选择",
                answerZh: "待补充",
              }),
            ),
          },
        };
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  w.JobsOperator.update({ mode: "person", epoch: "fixture" });
  mountReviewPanel(w);
  w.document.querySelector("#next").onclick = () => clicks++;
  return {
    w,
    messages,
    requests: () => requests,
    clicks: () => clicks,
    changeProfile: () => {
      bound = { profileName: "Other" };
      for (const fn of storage)
        fn(
          { profile_1: { newValue: { id: "fixture", profile: bound } } },
          "session",
        );
    },
    run: (options = {}) =>
      w.JobsAutomatic.advance({
        root: w.document.querySelector("form"),
        profile,
        action: "next",
        selector: "#next",
        ...options,
      }),
    shadow: () => w.document.querySelector("#jobs-ai-review").shadowRoot,
    close: () => w.close(),
  };
}
test("review Yes/No buttons write the original select and only confirmation continues", async () => {
  const h = setup(
    '<label>Do you agree?*<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label>',
  );
  try {
    assert.equal(await h.run(), false);
    const choices = [...h.shadow().querySelectorAll(".choice")];
    assert.deepEqual(
      choices.map((node) => node.textContent),
      ["是", "否"],
    );
    choices[1].click();
    await delay(10);
    assert.equal(
      h.w.document.querySelector("select").value,
      "",
      "synthetic page events cannot answer",
    );
    choices[1].onclick({ isTrusted: true });
    await until(
      () => h.shadow().querySelector(".source").textContent === "你的回答",
    );
    assert.equal(h.w.document.querySelector("select").value, "N");
    assert.equal(h.clicks(), 0);
    assert.equal(h.requests(), 1);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("remote card selection uses review validation and an expired confirmation cannot continue", async () => {
  const h = setup(
    '<label>Location*<select required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>',
  );
  try {
    await h.run();
    const root = h.w.document.querySelector("form"),
      state = h.w.JobsAIReview.remoteState(root),
      item = state.items[0];
    const result = await h.w.JobsAIReview.remoteAnswer(
      root,
      state.id,
      item.itemId,
      { version: item.version, value: "yes" },
      () => true,
    );
    assert(result.ok);
    assert.equal(h.w.document.querySelector("select").value, "yes");
    assert.equal(h.clicks(), 0);
    assert.equal(
      await h.w.JobsAIReview.remoteConfirm(root, state.id, () => false),
      false,
    );
    assert.equal(h.clicks(), 0);
    assert(h.w.JobsAIReview.pending());
    assert.equal(
      await h.w.JobsAIReview.remoteConfirm(root, state.id, () => true),
      true,
    );
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("remote review addressed by the page root reaches the review of the run inside it, never an unrelated root", async () => {
  const h = setup(
    '<label>Location*<select required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>',
  );
  try {
    await h.run();
    const form = h.w.document.querySelector("form"),
      page = h.w.document.body,
      state = h.w.JobsAIReview.remoteState(page),
      item = state.items[0];
    assert.equal(
      state.id,
      h.w.JobsAIReview.remoteState(form).id,
      "one review, whether named by its form or the page around it",
    );
    assert.equal(
      h.w.JobsAIReview.remoteState(h.w.document.createElement("form")),
      null,
    );
    assert(h.w.JobsAIReview.matches(page, state.id));
    assert(
      (
        await h.w.JobsAIReview.remoteAnswer(
          page,
          state.id,
          item.itemId,
          { version: item.version, value: "no" },
          () => true,
        )
      ).ok,
    );
    assert.equal(h.w.document.querySelector("select").value, "no");
    assert.equal(
      await h.w.JobsAIReview.remoteConfirm(page, state.id, () => true),
      true,
    );
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("remote confirmation expiring during the readiness wait never clicks Continue", async () => {
  const h = setup("<label>Details*<input required></label>");
  try {
    await h.run();
    const root = h.w.document.querySelector("form"),
      state = h.w.JobsAIReview.remoteState(root),
      item = state.items[0];
    assert(
      (
        await h.w.JobsAIReview.remoteAnswer(
          root,
          state.id,
          item.itemId,
          { version: item.version, value: "Answer" },
          () => true,
        )
      ).ok,
    );
    let valid = true;
    setTimeout(() => (valid = false), 40);
    await h.w.JobsAIReview.remoteConfirm(root, state.id, () => valid);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});
test("review dropdown, radio and text editors write through the shared form operations", async () => {
  const h = setup(
    '<label>Choice*<select required><option value="">Choose</option>' +
      ["A", "B", "C", "D", "E"]
        .map((s) => `<option value="${s}">${s}</option>`)
        .join("") +
      '</select></label><fieldset><legend>Decision*</legend><label>Yes<input type="radio" name="decision" value="yes" required></label><label>No<input type="radio" name="decision" value="no"></label></fieldset><label>Details*<textarea required></textarea></label>',
  );
  try {
    await h.run();
    const rows = h.shadow().querySelectorAll(".review-row");
    const select = rows[0].querySelector("select");
    select.value = "C";
    select.onchange({ isTrusted: true });
    await until(
      () => rows[0].querySelector(".source").textContent === "你的回答",
    );
    rows[1].querySelectorAll(".choice")[1].onclick({ isTrusted: true });
    await until(
      () => rows[1].querySelector(".source").textContent === "你的回答",
    );
    const text = rows[2].querySelector("textarea");
    text.value = "My own experience";
    text.oninput();
    text.onchange({ isTrusted: true });
    await until(
      () => rows[2].querySelector(".source").textContent === "你的回答",
    );
    assert.equal(h.w.document.querySelector("select").value, "C");
    assert.equal(h.w.document.querySelector("input:checked").value, "no");
    assert.equal(
      h.w.document.querySelector("textarea").value,
      "My own experience",
    );
    assert.equal(h.clicks(), 0);
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("confirming writes an answer typed in the card before continuing; a rejected draft stops confirmation", async () => {
  // RTX Workday: the owner typed the answer in the card and pressed Confirm
  // before it was written; the draft was dropped and the page field stayed empty.
  const h = setup(
    '<label>Details*<textarea required></textarea></label><label>Code*<input required pattern="[0-9]+"></label>',
  );
  try {
    await h.run();
    const rows = h.shadow().querySelectorAll(".review-row"),
      confirm = h.shadow().querySelector("#confirm");
    const text = rows[0].querySelector("textarea");
    text.value = "Typed in the card";
    text.oninput();
    const code = rows[1].querySelector("input");
    code.value = "12";
    code.oninput();
    confirm.onclick({ isTrusted: true });
    await until(() => h.clicks() === 1);
    assert.equal(
      h.w.document.querySelector("textarea").value,
      "Typed in the card",
    );
    assert.equal(h.w.document.querySelector("input").value, "12");
    assert.equal(rows[0].querySelector(".source").textContent, "你的回答");
  } finally {
    h.close();
  }
  const rejected = setup(
    "<label>Details*<textarea required></textarea></label>",
  );
  try {
    await rejected.run();
    const row = rejected.shadow().querySelector(".review-row"),
      confirm = rejected.shadow().querySelector("#confirm");
    const text = row.querySelector("textarea");
    text.value = "Draft";
    text.oninput();
    // The page field changed after the draft was typed: the stale draft is
    // refused with its own error and nothing continues.
    const page = rejected.w.document.querySelector("textarea");
    page.value = "Changed on the page";
    page.dispatchEvent(new rejected.w.Event("input", { bubbles: true }));
    await until(
      () => row.querySelector(".answer").textContent === "Changed on the page",
    );
    confirm.onclick({ isTrusted: true });
    await until(() => row.querySelector(".error").textContent !== "");
    await delay(50);
    assert.equal(rejected.clicks(), 0);
    assert(rejected.w.JobsAIReview.pending());
  } finally {
    rejected.close();
  }
});

test("Enter in a single-line card answer writes it to the page", async () => {
  const h = setup("<label>Code*<input required></label>");
  try {
    await h.run();
    const row = h.shadow().querySelector(".review-row"),
      input = row.querySelector("input");
    input.value = "A1";
    input.oninput();
    const event = { isTrusted: true, key: "Enter", preventDefault() {} };
    input.onkeydown(event);
    await until(() => row.querySelector(".source").textContent === "你的回答");
    assert.equal(h.w.document.querySelector("input").value, "A1");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("review puts missing and uncertain answers together above collapsed confirmed answers", async () => {
  const h = setup(
    "<label>County*<input required></label><label>Project*<input required></label><label>Code*<input required></label>",
  );
  const send = h.w.chrome.runtime.sendMessage;
  h.w.chrome.runtime.sendMessage = (message) =>
    message.fields
      ? Promise.resolve({
          data: {
            answers: message.fields.map((field, index) =>
              confirmedAnswer(field, {
                fieldId: field.fieldId,
                state: index === 2 ? "needs_input" : "answer",
                value: index === 2 ? null : "Example answer",
                source: index === 0 ? "profile" : "suggestion",
                needsConfirmation: index !== 0,
              }),
            ),
          },
        })
      : send(message);
  try {
    await h.run({ autoConfirm: false });
    const shadow = h.shadow(),
      pending = shadow.querySelector('[data-group="pending"]'),
      ready = shadow.querySelector('[data-group="ready"]');
    assert.equal(pending.querySelector("h3").textContent, "需要你处理 · 2 项");
    assert.equal(ready.querySelector("summary").textContent, "已确定 · 1 项");
    assert.equal(ready.open, false);
    assert.deepEqual(
      [...shadow.querySelectorAll(".review-row")].map((row) => row.title),
      ["Project*", "Code*", "County*"],
    );
    assert.equal(
      h.w.JobsAIReview.canAutoConfirm(h.w.document.querySelector("form")),
      false,
    );
    assert.equal(h.clicks(), 0);

    // Opening completed answers stays open across updates; drafts never move
    // into the collapsed section when a different page value arrives.
    ready.open = true;
    const code = [...pending.querySelectorAll(".review-row")].find(
        (row) => row.title === "Code*",
      ),
      input = code.querySelector("input");
    input.value = "Unsaved draft";
    input.oninput();
    const pageInputs = h.w.document.querySelectorAll("form input");
    pageInputs[2].value = "Changed on page";
    pageInputs[2].dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await delay(0);
    assert.equal(code.closest("[data-group]"), pending);
    assert.equal(input.value, "Unsaved draft");
    assert.equal(ready.open, true);

    // A previously certain answer that fails validation must become actionable.
    pageInputs[0].setAttribute("aria-invalid", "true");
    pageInputs[0].dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await until(() => pending.querySelectorAll(".review-row").length === 3);
    assert.equal(ready.hidden, true);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("manual changes to another radio member and removal of a reviewed control refresh the card", async () => {
  const h = setup(
    '<fieldset><legend>Decision*</legend><label>Yes<input type="radio" name="decision" value="yes" required></label><label>No<input type="radio" name="decision" value="no"></label></fieldset><label>Details*<textarea required></textarea>',
  );
  try {
    await h.run();
    const radio = h.w.document.querySelector('input[value="no"]');
    radio.checked = true;
    radio.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await until(() => h.shadow().querySelector(".answer").textContent === "否");
    h.w.document.querySelector("textarea").remove();
    await until(() => h.shadow().textContent.includes("控件已变化"));
  } finally {
    h.close();
  }
});
test("review refuses replaced controls and changed Profiles without modifying a different field", async () => {
  for (const change of ["node", "profile"]) {
    const h = setup(
      '<label>Decision*<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label>',
    );
    try {
      await h.run();
      const button = h.shadow().querySelector(".choice");
      if (change === "node") {
        const node = h.w.document.querySelector("select");
        node.replaceWith(node.cloneNode(true));
      } else h.changeProfile();
      button.onclick({ isTrusted: true });
      await until(() => h.shadow().querySelector(".error").textContent);
      assert.equal(h.w.document.querySelector("select").value, "");
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  }
});
test("a populated replacement keeps its review and ledger, rejects the old revision and confirms once", async () => {
  const h = setup("<label>County*<input required></label>");
  try {
    await h.run();
    const root = h.w.document.querySelector("form"),
      before = h.w.JobsAIReview.remoteState(root),
      item = before.items[0];
    assert(
      (
        await h.w.JobsAIReview.remoteAnswer(
          root,
          before.id,
          item.itemId,
          { version: item.version, value: "Example County" },
          () => true,
        )
      ).ok,
    );
    const old = root.querySelector("input"),
      book = h.w.JobsFormPipeline.ledgerFor(root),
      record = book.peek(old),
      revision = h.w.JobsAIReview.remoteState(root).items[0].version,
      fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    await delay(0);
    const state = h.w.JobsAIReview.remoteState(root);
    assert(
      state.items[0].fieldId,
      "review must refer to the populated successor",
    );
    assert.notEqual(state.items[0].fieldId, item.fieldId);
    assert(
      state.items[0].version > revision,
      "replacement invalidates old drafts even with the same value",
    );
    assert.equal(
      h.shadow().querySelector(".answer").textContent,
      "Example County",
    );
    assert.equal(h.shadow().querySelector("input").value, "Example County");
    assert.equal(book.peek(fresh), record, "one field keeps one ledger record");
    assert.equal(book.carded().length, 1);
    assert.equal(record.decider, "user");
    assert(
      (
        await h.w.JobsAIReview.remoteAnswer(
          root,
          state.id,
          item.itemId,
          { version: revision, value: "Stale County" },
          () => true,
        )
      ).error,
    );
    assert.equal(fresh.value, "Example County");
    assert.equal(h.clicks(), 0);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.clicks(), 1);
    assert.equal(await h.w.JobsAIReview.confirm(), false);
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("replacement preserves review order and a Profile answer remains eligible for automatic acknowledgment", async () => {
  const h = setup(
    "<label>County*<input required></label><label>Code*<input required></label>",
  );
  const send = h.w.chrome.runtime.sendMessage;
  h.w.chrome.runtime.sendMessage = (message) =>
    message.fields
      ? Promise.resolve({
          data: {
            answers: message.fields.map((field) =>
              confirmedAnswer(field, {
                fieldId: field.fieldId,
                state: "answer",
                value: "Example answer",
                source: "profile",
                needsConfirmation: false,
              }),
            ),
          },
        })
      : send(message);
  try {
    await h.run({ autoConfirm: false });
    const root = h.w.document.querySelector("form"),
      before = h.w.JobsAIReview.remoteState(root),
      old = root.querySelector("input"),
      fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    await delay(0);
    const state = h.w.JobsAIReview.remoteState(root);
    assert.deepEqual(
      Array.from(state.items, (item) => item.itemId),
      Array.from(before.items, (item) => item.itemId),
    );
    assert.equal(h.shadow().querySelector(".review-row").title, "County*");
    assert.equal(h.shadow().querySelector(".source").textContent, "依据档案");
    assert.equal(h.w.JobsAIReview.canAutoConfirm(root), true);
    assert.equal(h.clicks(), 0);
    const changed = fresh.cloneNode(true);
    changed.value = "Changed by the page";
    fresh.replaceWith(changed);
    await delay(0);
    assert.equal(
      h.w.JobsAIReview.canAutoConfirm(root),
      false,
      "a changed replacement value must be reviewed again",
    );
    assert.equal(h.clicks(), 0);
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("an empty replacement is editable with a fresh revision and remains blocked until answered", async () => {
  const h = setup("<label>County*<input required></label>");
  try {
    await h.run();
    const root = h.w.document.querySelector("form"),
      old = root.querySelector("input"),
      fresh = old.cloneNode(true);
    old.replaceWith(fresh);
    await delay(0);
    const state = h.w.JobsAIReview.remoteState(root),
      item = state.items[0];
    assert(item.fieldId);
    assert.equal(h.w.JobsAIReview.canAutoConfirm(root), false);
    assert.equal(h.clicks(), 0);
    assert(
      (
        await h.w.JobsAIReview.remoteAnswer(
          root,
          state.id,
          item.itemId,
          { version: item.version, value: "Example County" },
          () => true,
        )
      ).ok,
    );
    assert.equal(fresh.value, "Example County");
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("a draft predating replacement cannot overwrite its current answer; a new edit can", async () => {
  const h = setup("<label>County*<input required></label>");
  try {
    await h.run();
    const card = h.shadow().querySelector(".review-row"),
      editor = card.querySelector("input"),
      old = h.w.document.querySelector("form input"),
      fresh = old.cloneNode(true);
    editor.value = "Old draft";
    editor.oninput();
    fresh.value = "Current County";
    old.replaceWith(fresh);
    await delay(0);
    assert.equal(
      editor.value,
      "Old draft",
      "retain the person's unsaved draft",
    );
    await card.flush();
    assert(card.querySelector(".error").textContent);
    assert.equal(fresh.value, "Current County");
    assert.equal(h.clicks(), 0);
    editor.value = "New answer";
    editor.oninput();
    assert((await card.flush()).ok);
    assert.equal(fresh.value, "New answer");
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

for (const change of ["ambiguous", "question", "type", "entry", "options"])
  test(`review does not follow a replacement with changed ${change}`, async () => {
    const choice = change === "options",
      h = setup(
        choice
          ? '<label>County*<select required><option value="">Choose</option><option value="A">A</option></select></label>'
          : "<label>County*<input required></label>",
      );
    try {
      await h.run();
      const root = h.w.document.querySelector("form"),
        old = root.querySelector("input,select"),
        fresh = old.cloneNode(true);
      if (change === "entry")
        h.w.JobsControlFields.beginEntry(old.parentElement);
      if (change === "question")
        old.parentElement.firstChild.textContent = "Region*";
      if (change === "type") fresh.type = "number";
      if (choice) fresh.options[1].textContent = "Different option";
      old.replaceWith(fresh);
      if (change === "ambiguous")
        root.append(
          old.parentElement || root.firstElementChild.cloneNode(true),
        );
      await delay(0);
      const state = h.w.JobsAIReview.remoteState(root);
      assert.equal(state.items[0].fieldId, "");
      assert(h.shadow().textContent.includes("控件已变化"));
      assert.equal(h.w.JobsAIReview.canAutoConfirm(root), false);
      await h.w.JobsAIReview.confirm();
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  });

test("a populated but invalid replacement never continues, and a changed Profile cannot edit it", async () => {
  for (const change of ["invalid", "profile"]) {
    const h = setup("<label>County*<input required></label>");
    try {
      await h.run();
      const root = h.w.document.querySelector("form"),
        old = root.querySelector("input"),
        fresh = old.cloneNode(true);
      fresh.value = "Example County";
      if (change === "invalid") fresh.setAttribute("aria-invalid", "true");
      old.replaceWith(fresh);
      await delay(0);
      const state = h.w.JobsAIReview.remoteState(root),
        item = state.items[0];
      assert(item.fieldId);
      if (change === "profile") {
        h.changeProfile();
        assert(
          (
            await h.w.JobsAIReview.remoteAnswer(
              root,
              state.id,
              item.itemId,
              { version: item.version, value: "Other County" },
              () => true,
            )
          ).error,
        );
        assert.equal(fresh.value, "Example County");
      }
      await h.w.JobsAIReview.confirm();
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  }
});
test("a text draft survives review refresh and stale drafts cannot overwrite a newer page value", async () => {
  const h = setup("<label>Details*<textarea required></textarea></label>");
  try {
    await h.run();
    const field = h.w.document.querySelector("textarea"),
      editor = h.shadow().querySelector("textarea");
    editor.value = "Unsaved draft";
    editor.oninput();
    field.value = "New page value";
    field.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await delay(0);
    assert.equal(editor.value, "Unsaved draft");
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await until(() => h.shadow().querySelector(".error").textContent);
    assert.equal(field.value, "New page value");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("review ignores unrelated input and coalesces related input/change bursts", async () => {
  const h = setup(
    '<label>Details*<textarea required></textarea></label><label>Existing answer<input value="Keep"></label>',
  );
  let renders = 0;
  const presenter = h.w.JobsReviewPresenter;
  h.w.JobsReviewPresenter = {
    ...presenter,
    show: (...args) => {
      renders++;
      return presenter.show(...args);
    },
  };
  try {
    await h.run();
    renders = 0;
    const other = h.w.document.querySelector("form input"),
      field = h.w.document.querySelector("textarea");
    for (let i = 0; i < 20; i++)
      for (const type of ["input", "change"])
        other.dispatchEvent(new h.w.Event(type, { bubbles: true }));
    await delay(0);
    assert.equal(renders, 0);
    field.value = "Updated";
    for (let i = 0; i < 20; i++)
      for (const type of ["input", "change"])
        field.dispatchEvent(new h.w.Event(type, { bubbles: true }));
    await delay(0);
    assert.equal(renders, 1);
    assert.equal(h.shadow().querySelector(".answer").textContent, "Updated");
  } finally {
    h.close();
  }
});

for (const delayedCollapse of [false, true])
  test(`review writes a Workday button dropdown and verifies the choice (delayed collapse: ${delayedCollapse})`, async () => {
    const h = setup(
      '<div data-automation-id="formField-choice"><label id="question">Decision *</label><button type="button" aria-labelledby="question" aria-haspopup="listbox">Select One</button></div>',
    );
    const button = h.w.document.querySelector("form button");
    const close = () => {
      h.w.document.getElementById("options")?.remove();
      button.removeAttribute("aria-controls");
      if (delayedCollapse && button.textContent !== "Select One")
        h.w.setTimeout(() => button.removeAttribute("aria-expanded"), 60);
      else button.removeAttribute("aria-expanded");
    };
    button.onkeydown = (event) => {
      if (event.key === "Escape") close();
    };
    button.onclick = () => {
      close();
      button.setAttribute("aria-controls", "options");
      button.setAttribute("aria-expanded", "true");
      h.w.document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
      );
      for (const option of h.w.document.querySelectorAll('[role="option"]'))
        option.onclick = () => {
          button.textContent = option.textContent;
          close();
        };
    };
    try {
      await h.run();
      h.shadow().querySelectorAll(".choice")[1].onclick({ isTrusted: true });
      await until(
        () => h.shadow().querySelector(".source").textContent === "你的回答",
      );
      assert.equal(button.textContent, "No");
      assert.equal(h.w.document.querySelector('[role="listbox"]'), null);
      assert.equal(h.clicks(), 0);
      await h.w.JobsAIReview.confirm();
      assert.equal(h.clicks(), 1);
    } finally {
      h.close();
    }
  });

test("review multi-select choices are readable, committed and verified before continuing", async () => {
  const h = setup(
    '<label>Tools*<select multiple required><option value="a">A</option><option value="b">B</option><option value="c">C</option></select></label>',
  );
  try {
    await h.run();
    const editor = h.shadow().querySelector("select");
    editor.options[0].selected = true;
    editor.options[2].selected = true;
    editor.oninput();
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await until(
      () => h.shadow().querySelector(".source").textContent === "你的回答",
    );
    assert.equal(h.shadow().querySelector(".answer").textContent, "A; C");
    assert.deepEqual(
      [...h.w.document.querySelector("select").selectedOptions].map(
        (o) => o.value,
      ),
      ["a", "c"],
    );
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("Ashby checkbox group reaches AI and review as one question and writes all selected options", async () => {
  const h = setup(
    '<fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title">Tools*</label><label>A<input type="checkbox"></label><label>B<input type="checkbox"></label><label>C<input type="checkbox"></label></fieldset>',
    "https://jobs.ashbyhq.com/fixture/application",
  );
  try {
    await h.run();
    assert.equal(h.requests(), 1);
    assert.equal(h.shadow().querySelectorAll(".review-row").length, 1);
    const editor = h.shadow().querySelector("select");
    assert.equal(editor.multiple, true);
    assert.equal(editor.options.length, 3);
    editor.options[0].selected = true;
    editor.options[2].selected = true;
    editor.oninput();
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await until(
      () => h.shadow().querySelector(".source").textContent === "你的回答",
    );
    assert.equal(h.shadow().querySelector(".answer").textContent, "A; C");
    assert.deepEqual(
      [...h.w.document.querySelectorAll("form input")].map((o) => o.checked),
      [true, false, true],
    );
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("review reports failed site validation inline and does not continue", async () => {
  const h = setup('<label>Details*<input required pattern="[0-9]+"></label>');
  try {
    await h.run();
    const editor = h.shadow().querySelector("input");
    editor.value = "Invalid";
    editor.oninput();
    h.shadow().querySelector(".answer-input").onchange({ isTrusted: true });
    await until(() => h.shadow().querySelector(".error").textContent);
    assert.equal(h.clicks(), 0);
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("an Ashby search dropdown with no loaded options stays visible as an unresolved question", async () => {
  const h = setup(
    '<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Which country do you intend to work from?*</label><div><input role="combobox" placeholder="Start typing..."><button type="button">Open</button></div></div>',
    "https://jobs.ashbyhq.com/fixture/application",
  );
  h.w.JobsAshbyControls = {
    isControl: (node) => node.matches('input[role="combobox"]'),
    readOptions: async () => [],
  };
  try {
    assert.equal(await h.run(), false);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(h.shadow().querySelectorAll(".review-row").length, 1);
    assert.match(
      h.shadow().textContent,
      /Which country do you intend to work from/,
    );
    assert.match(h.shadow().textContent, /待补充/);
    assert.equal(h.requests(), 0);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});
