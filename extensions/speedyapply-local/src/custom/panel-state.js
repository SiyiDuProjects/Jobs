// Only routing metadata and progress are retained. Answers stay in their source
// document and are read on demand, including after a service-worker restart.
export const panelKey = (tabId, kind) => `jobsPanel:${tabId}:${kind}`;
/** @returns {Promise<{id:string,documentId:string,url:string,text?:string,canRestore?:boolean,dismissible?:boolean}|null>} */
export async function readPanelRecord(tabId, kind) {
  const key = panelKey(tabId, kind);
  return (
    /** @type {any} */ ((await chrome.storage.session.get(key))[key]) || null
  );
}
export async function notifyPanel(tabId) {
  try {
    await chrome.runtime.sendMessage({ type: "jobs:panel-changed", tabId });
  } catch {}
}
export async function storePanelRecord(tabId, kind, value) {
  const key = panelKey(tabId, kind);
  if (value) await chrome.storage.session.set({ [key]: value });
  else await chrome.storage.session.remove(key);
  await notifyPanel(tabId);
}
// The answer console is the side panel for every open application at once;
// it uses the same versioned review and status commands.
export const consoleUrl = () => chrome.runtime.getURL("console.html");
export function isConsole(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.frameId === 0 &&
    sender.url === consoleUrl()
  );
}
export function isPanel(sender) {
  return (
    (sender.id === chrome.runtime.id &&
      !sender.tab &&
      sender.url === chrome.runtime.getURL("popup.html")) ||
    isConsole(sender)
  );
}
