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
for (const source of ["top", "frame", "nested"])
  for (const missingTop of source !== "top" ? [false, true] : [false])
    test(`${source} review reaches side panel; missing top receiver=${missingTop}; one top-page surface`, async () => {
      const w = new JSDOM("<iframe></iframe><button>Submit</button>", {
        url: "https://example.test/job",
        runScripts: "outside-only",
      }).window;
      const frame = w.document.querySelector("iframe").contentWindow;
      frame.document.body.innerHTML = "<iframe></iframe>";
      const nested = frame.document.querySelector("iframe").contentWindow;
      const windows = { top: w, frame, nested };
      const listeners = { top: [], frame: [], nested: [] };
      let injections = 0;
      const h = panelWorker({
        send: async (tabId, message, target) => {
          assert.equal(tabId, 1);
          const name = target.documentId === "form-doc" ? source : "top";
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
        frameId: { top: 0, frame: 3, nested: 5 }[name],
        documentId:
          name === "top"
            ? "top-doc"
            : name === source
              ? "form-doc"
              : "other-doc",
      });
      for (const [name, win] of Object.entries(windows)) {
        win.chrome = {
          runtime: {
            id: "jobs",
            getURL: (path) => "chrome-extension://jobs/" + path,
            sendMessage: (message) => h.call(message, sender(name)),
            onMessage: { addListener: (fn) => listeners[name].push(fn) },
          },
        };
        win.eval(fields);
        if (name !== "top" || !missingTop) win.eval(presenter);
        if (name === source) win.eval(review);
      }
      try {
        const owner = windows[source];
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
          () => source === "top" || w.JobsReviewPresenter?.pending(),
        );
        assert.equal(injections, missingTop ? 1 : 0);
        for (const [name, win] of Object.entries(windows)) {
          assert.equal(
            win.document.querySelectorAll("[data-jobs-operator]").length,
            name === "top" ? 1 : 0,
            `${name} must not duplicate the tab's operator surface`,
          );
          win.JobsOperator.update({ mode: "page-tool", epoch: "agent" });
          win.JobsReviewPresenter.expand();
          assert.equal(
            win.document.querySelectorAll("[data-jobs-operator]").length,
            name === "top" ? 1 : 0,
            "claiming AI ownership or expanding review cannot mount child surfaces",
          );
        }
        assert(
          w.document
            .querySelector("[data-jobs-operator]")
            .shadowRoot.querySelector("#jobs-ai-review"),
          "the source review remains available on the top-page surface",
        );
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
        if (source !== "top")
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

test("a live application tab is kept from Memory Saver discard until the site confirms it", async () => {
  const h = panelWorker({ send: async () => ({ ok: true }) });
  const status = (phase) =>
    h.call(
      { type: "jobs:panel-status", id: "status", text: phase, phase },
      { ...h.page, tab: h.tabs.get(1) },
    );
  await status("in-progress");
  await status("ai-review");
  await status("confirmed");
  await status("confirmed");
  assert.deepEqual(h.updates, [
    [1, { autoDiscardable: false }],
    [1, { autoDiscardable: true }],
  ]);
});

for (const mode of ["person", "agent", "page-tool", "unknown"])
  for (const surface of ["panel", "console"])
    test(`${surface} answers use the original writer and ${mode} learning semantics`, async (t) => {
      const w = new JSDOM(
        '<form><label>Decision<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label></form>',
        {
          url: "https://example.test/job",
          runScripts: "outside-only",
        },
      ).window;
      t.after(() => w.close());
      const listeners = [],
        memories = [],
        writes = [];
      const h = panelWorker({
        send: async (_id, message) =>
          dispatch(listeners, message, { id: "jobs" }),
      });
      w.chrome = {
        runtime: {
          id: "jobs",
          getURL: (path) => "chrome-extension://jobs/" + path,
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: (message) => h.call(message, h.page),
        },
      };
      w.eval(fields);
      w.eval(presenter);
      w.eval(review);
      w.JobsOperator.update({ mode, epoch: "fixture" });
      w.JobsAnswerMemory = {
        remember: (_question, _node, options) => memories.push(options),
      };
      const write = w.JobsFormPipeline.write;
      w.JobsFormPipeline = {
        ...w.JobsFormPipeline,
        write: async (...args) => {
          writes.push(args[2]);
          return write(...args);
        },
      };
      const root = w.document.querySelector("form");
      const reader = w.JobsControlFields.create(w.document, () => root, {
        write: true,
      });
      w.JobsAIReview.add(root, reader, reader.scan()[0], { needsInput: true });
      w.JobsAIReview.ready(async (_nodes, release) => release(), "fill");
      const from =
        surface === "console"
          ? {
              id: "jobs",
              frameId: 0,
              tab: { id: 9 },
              url: "chrome-extension://jobs/console.html",
            }
          : h.panel;
      const read = () => h.call({ type: "jobs:panel-read", tabId: 1 }, from);
      await settle(async () => (await read())?.review?.data.canConfirm);
      const state = (await read()).review;
      const action = {
        type: "jobs:review-action",
        tabId: 1,
        id: state.id,
        documentId: state.documentId,
        action: "answer",
        itemId: "0",
        payload: { value: "N", version: state.data.items[0].editor.version },
      };
      assert.equal((await h.call(action, from)).ok, true);
      assert.equal(root.querySelector("select").value, "N");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].decider, mode === "person" ? "user" : mode);
      assert.equal(memories.length, 1);
      assert.equal(memories[0].learn, mode === "person");
      assert.equal(memories[0].origin, mode);
      assert.equal(memories[0].requireReview, true);
      assert(
        (await h.call(action, from)).error,
        "the consumed version cannot write twice",
      );
      assert.equal(writes.length, 1);
    });

test("an old top document cannot publish its status under the new tab URL", async () => {
  const h = panelWorker();
  const reply = await h.call(
    {
      type: "jobs:panel-status",
      id: "old",
      text: "Website confirmed",
      phase: "confirmed",
      documentUrl: "https://example.test/old",
    },
    { ...h.page, url: "https://example.test/old" },
  );
  assert.match(reply.error, /location changed/);
  assert.equal(
    (await h.call({ type: "jobs:panel-read", tabId: 1 })).status,
    null,
  );
});
