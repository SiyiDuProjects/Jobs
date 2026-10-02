// Custom ATS domains are entered through the server's canonical job identity.
import { JobsTabProfiles } from "../src/custom/tab-profiles.js";
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== "complete" || !/^https:\/\//.test(tab.url || ""))
    return;
  void (async () => {
    if (!(await JobsTabProfiles.candidate(tab))) return;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["custom/runtime-bundle.js"],
    });
  })().catch(() => {});
});
