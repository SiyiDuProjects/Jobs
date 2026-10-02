import { JobsJobMatch } from "../src/custom/job-match.js";
import { JobsSync } from "../src/custom/sync.js";

// Only an existing adapter's title for its current document reaches the board.
// This does not read a Profile or write an application/submission record.
export async function reportJobTitle(message, sender) {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab?.id ||
    !sender.documentId ||
    typeof message.url !== "string" ||
    !/^https:\/\//.test(message.url) ||
    !JobsJobMatch.key(message.url)
  )
    throw Error("Current application document required");
  if (
    typeof message.title !== "string" ||
    !message.title.trim() ||
    message.title.length > 500
  )
    throw Error("Invalid job title");
  const title = message.title.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(title))
    throw Error("Invalid job title");
  // Sync invokes this after its connection queue settles, immediately before
  // dispatch. Read metadata first so a navigation during storage access is also
  // caught by the exact-document check. No Profile is needed for a list title.
  async function currentDocument() {
    const key = "jobsTabBinding:" + sender.tab.id;
    const binding =
      /** @type {import('../src/custom/tab-profiles').TabBinding} */ (
        (await chrome.storage.session.get(key))[key]
      );
    const tab = await chrome.tabs.get(sender.tab.id);
    let timer;
    let live;
    try {
      live = await Promise.race([
        chrome.tabs.sendMessage(
          sender.tab.id,
          { type: "jobs:document-check" },
          { documentId: sender.documentId },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Document unavailable")), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // The injected document answers this even before autofill starts or when
    // it is disabled. Public title reporting does not require an active form.
    if (typeof live?.active !== "boolean" || live.url !== message.url)
      throw Error("Application document changed");
    if (!sender.frameId && tab.url !== live.url)
      throw Error("Application tab changed");
    return binding?.websiteJobId;
  }
  return JobsSync.reportJobTitle(
    message.url,
    title,
    undefined,
    currentDocument,
  );
}
