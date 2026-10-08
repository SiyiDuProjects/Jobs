import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  updateDraftJournal,
  approveDraftJournal,
} from "../src/custom/draft-journal.js";
import { createDraftChecklist } from "../src/custom/draft-checklist.js";
test("a persisted checklist retains earlier steps and invalidates approval when a draft changes", () => {
  let state = updateDraftJournal(null, [
    { key: "first", question: "Why?", answer: "A draft" },
  ]);
  state = approveDraftJournal(state, state.revision);
  const original = JSON.parse(JSON.stringify(state));
  state = updateDraftJournal(state, [
    { key: "second", question: "Preference?", answer: "Another draft" },
  ]);
  assert.equal(state.items.length, 2);
  assert.notEqual(state.approved, state.revision);
  assert.throws(
    () => approveDraftJournal(state, original.revision),
    /草稿已改变/,
  );
  state = approveDraftJournal(state, state.revision);
  state = updateDraftJournal(state, [
    { key: "first", question: "Why?", answer: "Revised draft" },
  ]);
  assert.equal(state.items[0].answer, "Revised draft");
  assert.equal(state.approved, -1);
});
test("checklist uses current retained values and flushes a user correction before approval", async () => {
  const dom = new JSDOM("<form><textarea>A draft</textarea></form>");
  const root = dom.window.document.querySelector("form"),
    node = root.querySelector("textarea");
  let state = updateDraftJournal(null, []);
  const row = { node, public: {} };
  const checklist = createDraftChecklist(
    root,
    { scan: () => [row], response: () => ({ response: node.value }) },
    async (action, data) => {
      if (action === "put") state = updateDraftJournal(state, data.items);
      if (action === "approve")
        state = approveDraftJournal(state, data.revision);
      return state;
    },
  );
  await checklist.add(
    {
      fieldId: "f",
      question: "Why?",
      type: "textarea",
      required: true,
      options: [],
    },
    row,
  );
  const before = await checklist.read();
  node.value = "User correction";
  node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await assert.rejects(checklist.approve(before.revision), /草稿已改变/);
  assert.equal((await checklist.read()).items[0].answer, "User correction");
  checklist.dispose();
  dom.window.close();
});

test("identical field ids on separate steps retain separate drafts and restored reads do not overwrite an earlier step", async () => {
  const dom = new JSDOM(
    '<form id="education"><textarea>Education draft</textarea></form><form id="experience"><textarea>Experience draft</textarea></form>',
  );
  let state = updateDraftJournal(null, []);
  const send = async (action, data) => {
    if (action === "put") state = updateDraftJournal(state, data.items);
    return state;
  };
  const field = {
    fieldId: "field-1",
    question: "Additional information",
    type: "textarea",
    required: true,
    options: [],
  };
  const lists = [...dom.window.document.querySelectorAll("form")].map(
    (root) => {
      const node = root.querySelector("textarea");
      const row = {
        node,
        public: {
          id: field.fieldId,
          question: field.question,
          type: field.type,
        },
      };
      return {
        row,
        list: createDraftChecklist(
          root,
          { scan: () => [row], response: () => ({ response: node.value }) },
          send,
        ),
      };
    },
  );
  try {
    for (const { list, row } of lists) await list.add(field, row);
    const result = await lists[1].list.read();
    assert.deepEqual(
      result.items.map((item) => item.answer),
      ["Education draft", "Experience draft"],
    );
    assert.notEqual(result.items[0].key, result.items[1].key);
  } finally {
    for (const { list } of lists) list.dispose();
    dom.window.close();
  }
});
