import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";
import { confirmedDraft } from "./helpers/verified-answer.mjs";
import { createDraftReview } from "../src/custom/draft-review.js";
import { createDraftChecklist } from "../src/custom/draft-checklist.js";
import {
  updateDraftJournal,
  approveDraftJournal,
} from "../src/custom/draft-journal.js";

for (const edited of [false, true])
  test(`same-page final draft survives storage serialization; user edit=${edited}`, async (t) => {
    const h = await adapterPage(t, {
      html: '<form><label>Why Petra?<textarea required></textarea></label><button id="submit" type="button">Submit Application</button></form>',
    });
    let journal = updateDraftJournal(null, []),
      submitted = 0,
      presentation;
    const stored = (value) =>
      Array.isArray(value)
        ? value.map(stored)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, stored(value[key])]),
            )
          : value;
    const send = async (action, data = {}) => {
      if (action === "put")
        journal = updateDraftJournal(stored(journal), data.items);
      if (action === "approve")
        journal = approveDraftJournal(stored(journal), data.revision);
      return stored(journal);
    };
    h.w.JobsOperator.update({ mode: "person", epoch: "fixture", since: 1 });
    h.w.createDraftReview = (root, reader, surface, guard) =>
      createDraftReview(
        root,
        reader,
        surface,
        guard,
        createDraftChecklist(root, reader, send),
      );
    const transport = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = async (message) => {
      if (message.type === "jobs:review-present") presentation = message.data;
      if (message.type === "jobs:auto-answers")
        return {
          data: {
            answers: message.fields.map((field) => ({
              ...confirmedDraft(field, "A grounded preference draft."),
              questionZh: "为什么申请这份工作",
              answerZh: "基于真实经历的求职动机草稿。",
              reasonZh: "使用资料中的真实项目经历。",
            })),
          },
        };
      return transport(message);
    };
    h.doc.querySelector("#submit").onclick = () => submitted++;
    await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      action: "submit",
      selector: "#submit",
    });
    assert.equal(submitted, 0);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(presentation.items[0].question, "为什么申请这份工作");
    assert.equal(presentation.items[0].answer, "基于真实经历的求职动机草稿。");
    assert.equal(presentation.items[0].reason, "使用资料中的真实项目经历。");
    if (edited) {
      h.doc.querySelector("textarea").value = "A deliberate user correction.";
      h.doc
        .querySelector("textarea")
        .dispatchEvent(new h.w.Event("input", { bubbles: true }));
      assert.equal(await h.w.JobsAIReview.confirm(), false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(presentation.status, "草稿已改变，请核对更新后的清单");
      assert.equal(
        presentation.items[0].answer,
        "A deliberate user correction.",
      );
      assert.equal(submitted, 0);
    }
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(submitted, 1);
    assert.equal(journal.approved, journal.revision);
  });

// The real page run, writer, review surface and checklist; only provider and
// session transport are synthetic. No live application or model is exercised.
test("a person-mode draft continues an intermediate step and is reviewed once before final submission", async (t) => {
  const h = await adapterPage(t, {
    html: '<form id="questions"><label>Why this role?<textarea required></textarea></label><button id="next" type="button">Next</button></form>',
  });
  let journal = updateDraftJournal(null, []),
    next = 0,
    submitted = 0;
  h.w.JobsOperator.update({ mode: "person", epoch: "fixture", since: 1 });
  const send = async (action, data = {}) => {
    if (action === "put") journal = updateDraftJournal(journal, data.items);
    if (action === "approve")
      journal = approveDraftJournal(journal, data.revision);
    return journal;
  };
  h.w.createDraftReview = (root, reader, surface, assertCurrent) =>
    createDraftReview(
      root,
      reader,
      surface,
      assertCurrent,
      createDraftChecklist(root, reader, send),
    );
  const transport = h.w.chrome.runtime.sendMessage;
  h.w.chrome.runtime.sendMessage = async (message) =>
    message.type === "jobs:auto-answers"
      ? {
          data: {
            answers: message.fields.map((field) =>
              confirmedDraft(field, "A grounded preference draft."),
            ),
          },
        }
      : transport(message);
  h.doc.querySelector("#next").onclick = () => next++;
  assert.equal(
    await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      action: "next",
      selector: "#next",
    }),
    true,
  );
  assert.equal(next, 1);
  assert.equal(h.w.JobsAIReview.pending(), false);
  assert.equal(journal.items.length, 1);
  assert.equal(journal.approved, -1);
  h.doc.body.innerHTML =
    '<form id="review"><p>Review application</p><button id="submit" type="button">Submit</button></form>';
  h.doc.querySelector("#submit").onclick = () => submitted++;
  assert.equal(
    await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      action: "submit",
      review: true,
      selector: "#submit",
    }),
    false,
  );
  assert.equal(submitted, 0);
  assert.equal(h.w.JobsAIReview.pending(), true);
  assert.equal(await h.w.JobsAIReview.confirm(), true);
  assert.equal(journal.approved, journal.revision);
  assert.equal(submitted, 1);
});
