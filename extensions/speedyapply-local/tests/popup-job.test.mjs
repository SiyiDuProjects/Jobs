import test from "node:test";
import assert from "node:assert/strict";
import { popupPage, until } from "./helpers/popup-page.mjs";

test("HeroUI deletion requires a reason, shows pending until ack, then permits undo", async () => {
  let state = { state: "ready" };
  const sent = [];
  const h = popupPage(async (msg) => {
    sent.push(msg);
    if (msg.type === "jobs:popup-profile")
      return {
        data: { available: true, kind: "intern", choices: { intern: true } },
      };
    if (msg.action === "delete")
      state = {
        state: "pending",
        event_id: "remove-1",
        removal_detail: msg.detail,
      };
    if (msg.action === "restore") state = { state: "restored" };
    return structuredClone(state);
  });
  const button = () => h.w.document.getElementById("jobs-delete-job");
  try {
    await until(() => button());
    assert(button().disabled);
    button().click();
    assert(!sent.some((m) => m.action === "delete"));
    const reason = h.w.document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(
      h.w.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(reason, "  岗位方向不匹配  ");
    reason.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await until(() => !button().disabled);
    button().click();
    await until(() =>
      h.w.document
        .getElementById("jobs-delete-status")
        .textContent.includes("待同步"),
    );
    assert(button().disabled);
    const deletion = sent.find((m) => m.action === "delete");
    assert.equal(deletion.tabId, 12);
    assert.equal(deletion.detail, "岗位方向不匹配");
    assert.match(
      h.w.document.getElementById("jobs-removal-detail").textContent,
      /岗位方向不匹配/,
    );
    state = {
      state: "removed",
      event_id: "remove-1",
      removal_detail: deletion.detail,
      expires_at: Date.now() / 1000 + 86400,
    };
    h.changed.emit({ jobsSyncV1: {} }, "local");
    await until(() => button().textContent === "撤销删除");
    assert(!button().disabled);
    button().click();
    await until(() =>
      h.w.document
        .getElementById("jobs-delete-status")
        .textContent.includes("已恢复"),
    );
    assert.equal(sent.find((m) => m.action === "restore").eventId, "remove-1");
    assert.equal(sent.find((m) => m.action === "restore").detail, undefined);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
