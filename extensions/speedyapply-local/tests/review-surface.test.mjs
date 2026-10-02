import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
const load = (name) =>
  readWithDependencies(
    new URL("../src/custom/" + name + ".js", import.meta.url),
    "utf8",
  );
const [presenter, review, fields, background] = await Promise.all(
  ["review-presenter", "ai-review", "control-fields", "review-background"].map(
    load,
  ),
);
test("iframe review is shown once in the top status surface; actions target the same document and stale/foreign commands fail", async () => {
  const dom = new JSDOM("<iframe></iframe><button>Submit</button>", {
      url: "https://example.test/job",
      runScripts: "outside-only",
    }),
    top = dom.window,
    frame = top.document.querySelector("iframe").contentWindow;
  const listeners = { top: [], frame: [] };
  let relay;
  const dispatch = (list, message, sender) =>
    new Promise((resolve) => {
      for (const fn of list) {
        let answered = false;
        const result = fn(message, sender, (value) => {
          answered = true;
          resolve(value);
        });
        if (answered || result === true) return;
      }
      resolve(undefined);
    });
  const sender = (where) => ({
    id: "jobs",
    tab: { id: 1 },
    frameId: where === "top" ? 0 : 3,
    documentId: where === "top" ? "top-doc" : "form-doc",
  });
  const call = (message, from) => dispatch([relay], message, from);
  const chrome = {
    runtime: { id: "jobs", onMessage: { addListener: (fn) => (relay = fn) } },
    tabs: {
      sendMessage: async (tab, message, options) => {
        assert.equal(tab, 1);
        if (options.frameId === 0)
          return dispatch(listeners.top, message, { id: "jobs" });
        if (options.documentId !== "form-doc")
          throw Error("Document no longer exists");
        return dispatch(listeners.frame, message, { id: "jobs" });
      },
    },
  };
  vm.runInNewContext(background, { chrome });
  for (const [name, w] of [
    ["top", top],
    ["frame", frame],
  ]) {
    w.chrome = {
      runtime: {
        id: "jobs",
        sendMessage: (message) => call(message, sender(name)),
        onMessage: { addListener: (fn) => listeners[name].push(fn) },
      },
    };
    w.eval(fields);
    w.eval(presenter);
    w.eval(review);
  }
  try {
    const host = top.document.createElement("speedyapply-autofill"),
      container = host.attachShadow({ mode: "open" }),
      original = top.document.createElement("div");
    top.document.body.append(host);
    container.append(original);
    top.JobsReviewPresenter.attach(host, container, () => host.remove());
    frame.document.body.innerHTML =
      '<form><label>Major<input value="Physics"></label><label>Decision<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label><button>Submit</button></form>';
    const root = frame.document.querySelector("form"),
      reader = frame.JobsControlFields.create(frame.document, () => root, {
        write: true,
      }),
      row = reader.scan()[0];
    frame.JobsAIReview.add(root, reader, row, {
      source: "profile",
      needsConfirmation: false,
      reason: "教育档案中的专业",
    });
    frame.JobsAIReview.add(root, reader, reader.scan()[1], {
      needsInput: true,
    });
    let confirmed = 0;
    frame.JobsAIReview.ready(async (_nodes, release) => {
      confirmed++;
      release();
    }, "fill");
    for (
      let i = 0;
      i < 20 &&
      !container
        .querySelector("#jobs-ai-review")
        ?.shadowRoot.querySelector("#confirm:not([disabled])");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const card = container.querySelector("#jobs-ai-review");
    assert(card);
    assert.equal(frame.document.querySelector("#jobs-ai-review"), null);
    assert.equal(original.style.display, "none");
    assert.match(
      card.shadowRoot.querySelector(".source").textContent,
      /依据档案/,
    );
    card.shadowRoot.querySelector(".item").click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(frame.document.activeElement, row.node);
    const id = await new Promise((resolve) => {
      listeners.frame.unshift((msg) => {
        if (msg.type === "jobs:review-command") resolve(msg.id);
      });
      card.shadowRoot.querySelector(".item").click();
    });
    assert(
      (
        await call(
          {
            type: "jobs:review-action",
            id,
            documentId: "form-doc",
            action: "confirm",
          },
          sender("frame"),
        )
      ).error,
    );
    assert(
      (
        await call(
          {
            type: "jobs:review-action",
            id: "stale",
            documentId: "form-doc",
            action: "confirm",
          },
          sender("top"),
        )
      ).error,
    );
    assert.equal(confirmed, 0);
    const choiceRow = card.shadowRoot.querySelectorAll(".review-row")[1],
      version = choiceRow.reviewRow.editor.version;
    assert(
      (
        await call(
          {
            type: "jobs:review-action",
            id,
            documentId: "form-doc",
            action: "answer",
            itemId: "1",
            payload: { version, value: "N" },
          },
          sender("frame"),
        )
      ).error,
    );
    assert(
      (
        await call(
          {
            type: "jobs:review-action",
            id,
            documentId: "form-doc",
            action: "answer",
            itemId: "1",
            payload: { version: version - 1, value: "N" },
          },
          sender("top"),
        )
      ).error,
    );
    choiceRow.querySelectorAll(".choice")[1].onclick({ isTrusted: true });
    for (
      let i = 0;
      i < 30 && frame.document.querySelector("select").value !== "N";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(frame.document.querySelector("select").value, "N");
    assert.equal(confirmed, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      (
        await call(
          {
            type: "jobs:review-action",
            id,
            documentId: "form-doc",
            action: "confirm",
          },
          sender("top"),
        )
      ).ok,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(confirmed, 1);
    assert.equal(container.querySelector("#jobs-ai-review"), null);
    assert.equal(original.style.display, "");
    assert(
      (
        await call(
          { type: "jobs:review-present", id, data: null },
          { ...sender("frame"), id: "foreign" },
        )
      ).error,
    );
  } finally {
    dom.window.close();
  }
});
