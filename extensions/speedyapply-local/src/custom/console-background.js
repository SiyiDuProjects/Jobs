import {
  consoleUrl,
  isConsole,
  isPanel,
  panelKey,
  readPanelRecord,
} from "./panel-state.js";
import { readOperator } from "./operator-background.js";
import { JobsBrand } from "./brand.js";
import { JobsTabProfiles } from "./tab-profiles.js";

// The answer console reads every open application tab through the same
// per-tab status and review records as the side panel. Answers stay in their
// source documents; this module only routes, focuses and opens.
const pickStatus = (status) =>
  status && {
    id: status.id,
    text: status.text,
    phase: status.phase || "",
    canFill: status.canFill === true,
    canRestore: status.canRestore === true,
    dismissible: status.dismissible === true,
  };

export async function consoleSnapshot({
  reviews = true,
  tabIds = undefined,
} = {}) {
  const tabs = (await chrome.tabs.query({})).filter(
    (tab) =>
      /^https?:/.test(tab.url || "") && (!tabIds || tabIds.includes(tab.id)),
  );
  const keys = tabs.flatMap((tab) => [
    panelKey(tab.id, "review"),
    panelKey(tab.id, "status"),
    "job_" + tab.id,
  ]);
  const stored = /** @type {Record<string, any>} */ (
    keys.length ? await chrome.storage.session.get(keys) : {}
  );
  const rows = [];
  let cursor = 0;
  // At most four documents are read concurrently. A suspended/unresponsive
  // page cannot hold the entire console hostage.
  async function readTab(tab) {
    const route = stored[panelKey(tab.id, "review")],
      status = stored[panelKey(tab.id, "status")];
    const liveRoute = route?.url === tab.url ? route : null,
      liveStatus = status?.url === tab.url ? status : null;
    if (!liveRoute && !liveStatus) return null;
    let review = null;
    if (liveRoute && reviews)
      try {
        const request = chrome.tabs.sendMessage(
          tab.id,
          { type: "jobs:review-read", id: liveRoute.id },
          { documentId: liveRoute.documentId },
        );
        let timer;
        const result = await Promise.race([
          request,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), 2000);
          }),
        ]).finally(() => clearTimeout(timer));
        if (result?.data?.id === liveRoute.id)
          review = {
            id: liveRoute.id,
            documentId: liveRoute.documentId,
            data: result.data,
          };
      } catch {}
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active === true,
      title: String(tab.title || "").slice(0, 300),
      url: tab.url,
      favIconUrl: /^https:/.test(tab.favIconUrl || "") ? tab.favIconUrl : "",
      jobTitle: String(stored["job_" + tab.id]?.title || "").slice(0, 300),
      status: pickStatus(liveStatus),
      review,
      reviewPending: !!liveRoute,
      operator: (await readOperator(tab.id)).mode,
      // Which Profile fills this page, so a wrong kind binding is visible.
      profileName: String(
        (await JobsTabProfiles?.selected?.(tab.id).catch(() => null))
          ?.profileName || "",
      ).slice(0, 120),
    };
  }
  await Promise.all(
    Array.from({ length: Math.min(4, tabs.length) }, async () => {
      while (cursor < tabs.length) {
        const tab = tabs[cursor++];
        rows.push(await readTab(tab));
      }
    }),
  );
  return rows.filter(Boolean);
}

// Bring an open application to the front without reloading it; optionally
// scroll its review field into view through the page's own locate command.
export async function focusApplication(message) {
  const tab = await chrome.tabs.get(message.tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof message.itemId !== "string") return { ok: true };
  const route = await readPanelRecord(tab.id, "review");
  if (
    !route ||
    route.id !== message.reviewId ||
    route.documentId !== message.documentId ||
    route.url !== tab.url
  )
    return {
      ok: true,
      located: false,
      error: "网页已打开，但这份题目已变化，请查看当前网页。",
    };
  const result = await chrome.tabs
    .sendMessage(
      tab.id,
      {
        type: "jobs:review-command",
        id: route.id,
        action: "locate",
        itemId: message.itemId,
      },
      { documentId: route.documentId },
    )
    .catch(() => {});
  return {
    ok: true,
    located: result?.ok === true,
    ...(result?.ok === true
      ? {}
      : { error: "网页已打开，但题目暂时无法定位，请在网页中查看。" }),
  };
}

let opening;
export function openConsole(windowId) {
  if (!opening)
    opening = findOrCreateConsole(windowId).finally(() => {
      opening = undefined;
    });
  return opening;
}
async function findOrCreateConsole(windowId) {
  const url = consoleUrl();
  const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url);
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return { ok: true, tabId: existing.id };
  }
  const created = await chrome.tabs.create({
    url,
    ...(Number.isInteger(windowId) ? { windowId } : {}),
  });
  return { ok: true, tabId: created.id };
}

const fromWebsite = (sender) => {
  try {
    return (
      sender.id === chrome.runtime.id &&
      sender.frameId === 0 &&
      new URL(sender.url).origin === JobsBrand.origin
    );
  } catch {
    return false;
  }
};

let initialized = false;
export function initializeConsoleBackground() {
  if (initialized) return;
  initialized = true;
  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command === "open-console") void openConsole(tab?.windowId);
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      ![
        "jobs:console-read",
        "jobs:console-focus",
        "jobs:console-open",
      ].includes(message?.type)
    )
      return;
    const run = async () => {
      if (message.type === "jobs:console-open") {
        if (!isPanel(sender) && !fromWebsite(sender))
          throw Error("Extension page required");
        return openConsole(sender.tab?.windowId);
      }
      if (message.type === "jobs:console-read") {
        if (!isPanel(sender)) throw Error("Extension page required");
        if (
          message.tabIds !== undefined &&
          (!Array.isArray(message.tabIds) ||
            message.tabIds.length > 100 ||
            !message.tabIds.every(Number.isInteger))
        )
          throw Error("Invalid tab selection");
        // The side panel only needs counts; review bodies stay unread.
        return {
          tabs: await consoleSnapshot({
            reviews: isConsole(sender),
            tabIds: message.tabIds,
          }),
        };
      }
      if (!isConsole(sender) || !Number.isInteger(message.tabId))
        throw Error("Answer console required");
      return focusApplication(message);
    };
    run().then(
      (data) => reply({ data }),
      (error) => reply({ error: error.message || "无法读取投递页面" }),
    );
    return true;
  });
}
