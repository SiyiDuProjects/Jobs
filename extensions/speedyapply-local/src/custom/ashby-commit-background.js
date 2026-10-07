import { readAshbyCommit } from "./ashby-page-state.js";

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "jobs:ashby-commit") return;
  const run = async () => {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.tab?.id ||
      !sender.documentId ||
      new URL(sender.url).hostname !== "jobs.ashbyhq.com" ||
      typeof message.path !== "string" ||
      message.path.length > 500 ||
      !["draft", "saved", "upload-start"].includes(message.phase)
    )
      throw Error("Ashby application document required");
    const results = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN",
      func: readAshbyCommit,
      args: [message.path, message.phase],
    });
    if (results.length !== 1 || results[0].documentId !== sender.documentId)
      throw Error("Application document changed");
    return results[0].result;
  };
  run().then(
    (data) => reply({ data }),
    () => reply({ data: { state: "unavailable" } }),
  );
  return true;
});
