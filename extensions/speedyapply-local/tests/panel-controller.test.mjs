import test from "node:test";
import assert from "node:assert/strict";
import { createPanelController } from "../src/custom/panel-controller.js";
import { event } from "./helpers/panel-worker.mjs";
import { popupPage, until } from "./helpers/popup-page.mjs";
const tick = () => new Promise((r) => setImmediate(r));
test("panel follows its window, discards late snapshots and refuses actions captured before switching tabs", async () => {
  let tab = { id: 1, windowId: 7 },
    pending;
  const views = [],
    sent = [];
  const api = {
    runtime: {
      id: "jobs",
      onMessage: event(),
      sendMessage: async (message) => {
        sent.push(message);
        if (pending) return pending.promise;
        return {
          status: { text: "Page " + tab.id },
          review: {
            id: "review-" + tab.id,
            documentId: "doc-" + tab.id,
            data: { items: [] },
          },
        };
      },
    },
    tabs: {
      query: async () => [tab],
      onActivated: event(),
      onUpdated: event(),
    },
  };
  const controller = createPanelController(api, (view) => views.push(view));
  await controller.start();
  const old = views.at(-1);
  api.tabs.onActivated.emit({ tabId: 5, windowId: 9 });
  await tick();
  assert.equal(views.at(-1), old);
  pending = Promise.withResolvers();
  api.runtime.onMessage.emit(
    { type: "jobs:panel-changed", tabId: 1 },
    { id: "jobs" },
  );
  const delayed = pending;
  pending = null;
  tab = { id: 2, windowId: 7 };
  api.tabs.onActivated.emit({ tabId: 2, windowId: 7 });
  await tick();
  delayed.resolve({ status: { text: "OLD" } });
  await tick();
  assert.equal(views.at(-1).text, "Page 2");
  assert((await old.act("confirm")).error);
  await views.at(-1).act("answer", "0", { version: 3, value: "X" });
  assert.equal(sent.at(-1).tabId, 2);
  assert.equal(sent.at(-1).documentId, "doc-2");
  controller.dispose();
});

test("HeroUI side panel places status and review together and clears the previous job on activation", async () => {
  const h = popupPage(async (message) => {
    if (message.type === "jobs:panel-read")
      return message.tabId === 12
        ? {
            status: { text: "正在填写回答" },
            review: {
              id: "fixture-review",
              documentId: "fixture-doc",
              data: {
                id: "fixture-review",
                title: "需要你补充",
                canConfirm: true,
                items: [
                  {
                    id: "0",
                    question: "Synthetic question",
                    answer: "待补充",
                    editor: { kind: "text", value: "", version: 1 },
                  },
                ],
              },
            },
          }
        : {};
    if (message.type === "jobs:popup-profile")
      return { data: { available: false } };
    return { error: "无匹配岗位" };
  });
  try {
    await until(
      () =>
        h.w.document.querySelector("#jobs-ai-review") &&
        h.w.document.querySelector("#jobs-panel-status")?.textContent ===
          "正在填写回答",
    );
    assert.equal(
      h.w.document.querySelector("#jobs-panel-status").textContent,
      "正在填写回答",
    );
    const host = h.w.document.querySelector("#jobs-ai-review");
    assert(host.closest("#jobs-panel-review"));
    assert.equal(host.style.position, "");
    assert(host.shadowRoot.querySelector(".button--primary"));
    assert(host.shadowRoot.querySelector('link[href="custom/popup.css"]'));
    h.activate({
      id: 13,
      title: "Another role",
      url: "https://example.test/second",
    });
    await until(() => !h.w.document.querySelector("#jobs-ai-review"));
    await until(() => !h.w.document.body.textContent.includes("正在填写回答"));
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
