import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { panelWorker, dispatch } from "./helpers/panel-worker.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const [presenter, review, fields] = await Promise.all(
  ["review-presenter", "ai-review", "control-fields"].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
const settle = async (check) => {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Review did not reach side panel");
};
for (const source of ["top", "frame"])
  for (const missingTop of source === "frame" ? [false, true] : [false])
    test(`${source} review reaches side panel; missing top receiver=${missingTop}; no page overlays`, async () => {
      const w = new JSDOM("<iframe></iframe><button>Submit</button>", {
        url: "https://example.test/job",
        runScripts: "outside-only",
      }).window;
      const frame = w.document.querySelector("iframe").contentWindow;
      const listeners = { top: [], frame: [] };
      let injections = 0;
      const h = panelWorker({
        send: async (tabId, message, target) => {
          assert.equal(tabId, 1);
          const name = target.documentId === "form-doc" ? "frame" : "top";
          if (!listeners[name].length)
            throw Error("Receiving end does not exist");
          return dispatch(listeners[name], message, { id: "jobs" });
        },
        inject: async ({ files }) => {
          assert.deepEqual(Array.from(files), ["custom/review-surface.js"]);
          injections++;
          w.eval(presenter);
          return [{ frameId: 0, documentId: "top-doc" }];
        },
      });
      const sender = (name) => ({
        ...h.page,
        frameId: name === "top" ? 0 : 3,
        documentId: name === "top" ? "top-doc" : "form-doc",
      });
      for (const [name, win] of [
        ["top", w],
        ["frame", frame],
      ]) {
        win.chrome = {
          runtime: {
            id: "jobs",
            sendMessage: (message) => h.call(message, sender(name)),
            onMessage: { addListener: (fn) => listeners[name].push(fn) },
          },
        };
        win.eval(fields);
        if (name !== "top" || !missingTop) win.eval(presenter);
        if (name === source) win.eval(review);
      }
      try {
        const owner = source === "top" ? w : frame;
        const root = owner.document.createElement("form");
        root.innerHTML =
          '<label>Decision<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label>';
        owner.document.body.append(root);
        const reader = owner.JobsControlFields.create(
          owner.document,
          () => root,
          { write: true },
        );
        owner.JobsAIReview.add(root, reader, reader.scan()[0], {
          needsInput: true,
        });
        let confirmed = 0;
        owner.JobsAIReview.ready(async (_nodes, release) => {
          confirmed++;
          release();
        }, "fill");
        const read = () => h.call({ type: "jobs:panel-read", tabId: 1 });
        await settle(async () => (await read())?.review?.data.canConfirm);
        await settle(
          () => source !== "frame" || w.JobsReviewPresenter?.pending(),
        );
        assert.equal(injections, missingTop ? 1 : 0);
        assert.equal(w.document.querySelector("#jobs-ai-review"), null);
        assert.equal(frame.document.querySelector("#jobs-ai-review"), null);
        const state = (await read()).review;
        assert.equal(
          state.documentId,
          source === "top" ? "top-doc" : "form-doc",
        );
        assert.equal(
          JSON.stringify(h.storage).includes('"items"'),
          false,
          "answer copies are not retained in session storage",
        );
        h.restart();
        assert.equal(
          (await read()).review.id,
          state.id,
          "worker restart recovers live source",
        );
        const action = (extra, from = h.panel) =>
          h.call(
            {
              type: "jobs:review-action",
              tabId: 1,
              id: state.id,
              documentId: state.documentId,
              action: "confirm",
              ...extra,
            },
            from,
          );
        assert(
          (await action({}, sender(source))).error,
          "page scripts cannot impersonate panel",
        );
        assert((await action({ id: "stale" })).error);
        assert((await action({ documentId: "other-document" })).error);
        assert(
          (
            await action({
              action: "answer",
              itemId: "0",
              payload: { version: -1, value: "N" },
            })
          ).error,
        );
        assert.equal(confirmed, 0);
        assert(
          (
            await action({
              action: "answer",
              itemId: "0",
              payload: {
                version: state.data.items[0].editor.version,
                value: "N",
              },
            })
          ).ok,
        );
        assert.equal(root.querySelector("select").value, "N");
        assert.equal(confirmed, 0);
        assert((await action({})).ok);
        await settle(async () => !(await read()).review);
        assert.equal(confirmed, 1);
        if (source === "frame")
          await settle(() => !w.JobsReviewPresenter.pending());
        assert(
          (
            await h.call(
              { type: "jobs:review-present", id: state.id, data: null },
              { ...sender(source), id: "foreign" },
            )
          ).error,
        );
      } finally {
        w.close();
      }
    });

test("navigation clears status/review and old review actions cannot target a new document", async () => {
  let commands = 0;
  const h = panelWorker({
    send: async (_tab, message) => {
      if (message.type !== "jobs:page-status") commands++;
      return { ok: true };
    },
  });
  await h.call(
    { type: "jobs:panel-status", id: "status", text: "等待审核" },
    h.page,
  );
  await h.call(
    {
      type: "jobs:review-present",
      id: "review",
      data: { id: "review", items: [] },
    },
    h.page,
  );
  h.chrome.tabs.onUpdated.emit(1, { status: "loading" });
  await settle(() => Object.keys(h.storage).length === 0);
  assert(
    (
      await h.call({
        type: "jobs:review-action",
        tabId: 1,
        id: "review",
        documentId: "top-doc",
        action: "confirm",
      })
    ).error,
  );
  assert.equal(commands, 0);
  assert.equal(
    (await h.call({ type: "jobs:panel-read", tabId: 1 })).status,
    null,
  );
});

test("AI page actions share document routing and reject person mode, other frames and stale routes", async () => {
  const sent = [];
  const h = panelWorker({
    send: async (tab, message, target) => {
      sent.push({ tab, message, target });
      return { ok: true };
    },
  });
  const review = { id: "review", items: [] };
  await h.call(
    { type: "jobs:review-present", id: review.id, data: review },
    { ...h.page, frameId: 2, documentId: "form-doc" },
  );
  const message = {
    type: "jobs:review-page-action",
    id: "review",
    documentId: "form-doc",
    action: "confirm",
  };
  assert((await h.call(message, h.page)).error);
  h.local["jobsOperator:1"] = { mode: "page-tool", epoch: "ai", since: 1 };
  assert((await h.call(message, { ...h.page, frameId: 2 })).error);
  assert((await h.call({ ...message, documentId: "old-doc" }, h.page)).error);
  assert.equal((await h.call(message, h.page)).ok, true);
  assert.equal(sent.at(-1).target.documentId, "form-doc");
  assert.equal(sent.at(-1).message.type, "jobs:review-command");
  await h.call(
    { type: "jobs:panel-status", id: "status", text: "Ready", canFill: true },
    { ...h.page, frameId: 2, documentId: "form-doc" },
  );
  assert.equal(
    (
      await h.call(
        {
          type: "jobs:page-status-action",
          id: "status",
          documentId: "form-doc",
          action: "draft",
        },
        h.page,
      )
    ).ok,
    true,
  );
  assert.equal(sent.at(-1).target.documentId, "form-doc");
  assert.equal(sent.at(-1).message.action, "draft");
  h.local["jobsOperator:1"] = { mode: "person", epoch: "back", since: 2 };
  assert((await h.call(message, h.page)).error);
});
