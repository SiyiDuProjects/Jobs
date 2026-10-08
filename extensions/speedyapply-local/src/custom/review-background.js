import { readOperator } from "./operator-background.js";
import { isPanel, readPanelRecord, storePanelRecord } from "./panel-state.js";
// Relay the review within one browser tab. Never submit or choose an answer here.
async function presentReview(tabId, message) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, message, {
      frameId: 0,
    });
    if (result?.ok || result?.error) return result;
  } catch (error) {
    if (!/Receiving end does not exist/i.test(error.message)) throw error;
  }
  if (!message.data) return { ok: true };
  // Embedded ATS forms may run on a host with no content script. Install only
  // the review surface: loading the application runtime could start a new run.
  const frames = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["custom/review-surface.js"],
  });
  const documentId = frames.find((frame) => frame.frameId === 0)?.documentId;
  if (!documentId) throw Error("Review document unavailable");
  return chrome.tabs.sendMessage(tabId, message, { documentId });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    ![
      "jobs:review-present",
      "jobs:review-action",
      "jobs:review-page-action",
    ].includes(message?.type)
  )
    return;
  const run = async () => {
    if (sender.id !== chrome.runtime.id || typeof message.id !== "string")
      throw Error("Application tab required");
    if (message.type === "jobs:review-present") {
      if (!sender.tab?.id || !sender.documentId)
        throw Error("Application document required");
      if (
        message.data &&
        (message.data.id !== message.id ||
          !Array.isArray(message.data.items) ||
          message.data.items.length > 90 ||
          JSON.stringify(message.data).length > 250000)
      )
        throw Error("Invalid review");
      const previous = await readPanelRecord(sender.tab.id, "review");
      if (
        !message.data &&
        (previous?.id !== message.id ||
          previous?.documentId !== sender.documentId)
      )
        return { ok: true };
      await storePanelRecord(
        sender.tab.id,
        "review",
        message.data
          ? {
              id: message.id,
              documentId: sender.documentId,
              url: sender.tab.url,
            }
          : null,
      );
      await chrome.action.setBadgeText({
        tabId: sender.tab.id,
        text: message.data ? "!" : "",
      });
      if (sender.frameId === 0) return { ok: true };
      return presentReview(sender.tab.id, {
        type: "jobs:review-view",
        id: message.id,
        data: message.data,
        sourceDocumentId: sender.documentId,
      });
    }
    const pageAction = message.type === "jobs:review-page-action";
    if (pageAction) {
      if (
        !sender.tab?.id ||
        sender.frameId !== 0 ||
        !sender.documentId ||
        !["agent", "page-tool"].includes(
          (await readOperator(sender.tab.id)).mode,
        )
      )
        throw Error("AI page operator required");
      message = { ...message, tabId: sender.tab.id };
    }
    if (
      (!pageAction && !isPanel(sender)) ||
      !Number.isInteger(message.tabId) ||
      !["confirm", "locate", "answer"].includes(message.action) ||
      typeof message.documentId !== "string"
    )
      throw Error("Side panel required");
    if (
      message.action === "answer" &&
      (!message.payload ||
        !Number.isInteger(message.payload.version) ||
        JSON.stringify(message.payload).length > 50000)
    )
      throw Error("Invalid answer");
    const route = await readPanelRecord(message.tabId, "review");
    const tab = await chrome.tabs.get(message.tabId);
    if (
      !route ||
      route.id !== message.id ||
      route.documentId !== message.documentId ||
      route.url !== tab.url
    )
      throw Error("这份补答已过期，请检查当前页面。");
    return chrome.tabs.sendMessage(
      message.tabId,
      {
        type: "jobs:review-command",
        id: message.id,
        action: message.action,
        itemId: message.itemId,
        payload: message.payload,
      },
      { documentId: message.documentId },
    );
  };
  run().then(reply, (error) =>
    reply({ error: error.message || "申请页面已变化，请检查。" }),
  );
  return true;
});
