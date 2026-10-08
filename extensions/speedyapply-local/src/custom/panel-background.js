import {
  isPanel,
  panelKey,
  readPanelRecord,
  storePanelRecord,
  notifyPanel,
} from "./panel-state.js";
import { readOperator } from "./operator-background.js";

void chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
async function clear(tabId) {
  await chrome.storage.session.remove([
    panelKey(tabId, "review"),
    panelKey(tabId, "status"),
  ]);
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await notifyPanel(tabId);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  void clear(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) void clear(tabId);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "jobs:panel-open") {
    if (sender.id !== chrome.runtime.id || !sender.tab?.windowId) return;
    // Preserve Chrome's user gesture: do not await anything before open().
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(
      () => reply({ ok: true }),
      () => reply({ error: "请点击工具栏 jobs 图标打开侧边栏" }),
    );
    return true;
  }
  if (
    ![
      "jobs:panel-status",
      "jobs:panel-read",
      "jobs:panel-status-action",
      "jobs:page-status-action",
    ].includes(message?.type)
  )
    return;
  const run = async () => {
    if (message.type === "jobs:panel-status") {
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab?.id ||
        !sender.documentId ||
        typeof message.id !== "string" ||
        typeof message.text !== "string" ||
        message.text.length > 4000
      )
        throw Error("Application document required");
      await storePanelRecord(sender.tab.id, "status", {
        id: message.id,
        documentId: sender.documentId,
        url: sender.tab.url,
        text: message.text,
        canFill: message.canFill === true,
        canRestore: message.canRestore === true,
        dismissible: message.dismissible === true,
      });
      // Top-page AI surface observes the same status as the side panel.
      await chrome.tabs
        .sendMessage(
          sender.tab.id,
          {
            type: "jobs:page-status",
            data: {
              id: message.id,
              text: message.text,
              canFill: message.canFill === true,
              documentId: sender.documentId,
            },
          },
          { frameId: 0 },
        )
        .catch(() => {});
      return { ok: true };
    }
    const pageAction = message.type === "jobs:page-status-action";
    if (pageAction) {
      if (
        sender.id !== chrome.runtime.id ||
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
    if ((!pageAction && !isPanel(sender)) || !Number.isInteger(message.tabId))
      throw Error("Side panel required");
    const tab = await chrome.tabs.get(message.tabId);
    const status = await readPanelRecord(tab.id, "status");
    if (message.type === "jobs:panel-status-action" || pageAction) {
      if (
        !status ||
        status.url !== tab.url ||
        status.id !== message.id ||
        !["restore", "dismiss", "draft", "refill"].includes(message.action) ||
        (pageAction &&
          (!["draft", "refill"].includes(message.action) ||
            status.documentId !== message.documentId))
      )
        throw Error("页面已变化，请检查当前岗位。");
      return chrome.tabs.sendMessage(
        tab.id,
        { type: "jobs:status-command", id: status.id, action: message.action },
        { documentId: status.documentId },
      );
    }
    const route = await readPanelRecord(tab.id, "review");
    let review = null;
    if (route?.url === tab.url) {
      try {
        const result = await chrome.tabs.sendMessage(
          tab.id,
          { type: "jobs:review-read", id: route.id },
          { documentId: route.documentId },
        );
        if (result?.data?.id === route.id)
          review = { ...route, data: result.data };
      } catch {}
    }
    return {
      status: status?.url === tab.url ? status : null,
      review,
      operator: await readOperator(tab.id),
    };
  };
  run().then(reply, (error) =>
    reply({ error: error.message || "无法读取投递状态" }),
  );
  return true;
});
