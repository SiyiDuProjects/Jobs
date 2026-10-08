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
