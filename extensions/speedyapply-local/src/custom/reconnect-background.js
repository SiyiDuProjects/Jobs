// Reattach existing ATS documents after a connection reset or extension reload.
// This entry only restores observation/review; it cannot restart autofill.
let running;
export async function reconnectPages() {
  if (running) return running;
  running = (async () => {
    const connection =
      /** @type {import('./worker-types.js').PrivateConnectionState} */ (
        (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1
      );
    if (!connection?.profileToken || connection.disabled) return;
    const scripts = chrome.runtime.getManifest().content_scripts || [];
    for (const script of scripts) {
      if (!script.js?.includes("custom/runtime-bundle.js")) continue;
      const tabs = await chrome.tabs.query({ url: script.matches });
      const saved = await chrome.storage.local.get(null);
      const known = Object.entries(saved).filter(([key]) =>
        key.startsWith("jobsReconnectTab:"),
      );
      for (const [key, origin] of known) {
        try {
          const tab = await chrome.tabs.get(Number(key.split(":")[1]));
          if (
            new URL(tab.url).origin === origin &&
            !tabs.some((item) => item.id === tab.id)
          )
            tabs.push(tab);
        } catch {
          await chrome.storage.local.remove(key);
        }
      }
      for (const tab of tabs) {
        if (
          !Number.isInteger(tab.id) ||
          tab.discarded ||
          tab.status === "loading"
        )
          continue;
        try {
          // Check every frame: a healthy parent must not hide a disconnected ATS
          // iframe. These functions execute only in the extension's isolated world.
          const frames = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: script.all_frames === true },
            func: async () => {
              if (!globalThis.__jobsReconnectPage) return false;
              await globalThis.__jobsReconnectPage();
              return true;
            },
          });
          const missing = frames
            .filter((frame) => frame.result !== true)
            .map((frame) => frame.frameId);
          if (!missing.length) continue;
          const target = { tabId: tab.id, frameIds: missing };
          await chrome.scripting.executeScript({
            target,
            func: () => {
              globalThis.__jobsRecoveryStart = true;
            },
          });
          await chrome.scripting.executeScript({ target, files: script.js });
        } catch {
          /* A closed or restricted tab is retried at the next wakeup. */
        }
      }
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
chrome.runtime.onInstalled.addListener(() => {
  void reconnectPages();
});
chrome.runtime.onStartup.addListener(() => {
  void reconnectPages();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "jobs-control") void reconnectPages();
});
