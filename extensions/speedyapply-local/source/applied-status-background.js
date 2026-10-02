import { JobsJobMatch } from "../src/custom/job-match.js";
import { publicJobUrl } from "../src/custom/public-job-url.js";
import { JobsSync } from "../src/custom/sync.js";

export async function recordAppliedStatus(message, sender) {
  const key = JobsJobMatch.key(message.url);
  if (
    !sender.documentId ||
    sender.frameId !== 0 ||
    !key ||
    JSON.parse(key)[1] !== "workday" ||
    !JobsJobMatch.same(sender.url, message.url)
  )
    throw Error("Applied status requires the current posting document");
  const url = publicJobUrl(message.url);
  const settings =
    /** @type {{autofillSettings?:{saveApplications?:boolean}}} */ (
      (await chrome.storage.local.get("settings")).settings
    );
  if (settings?.autofillSettings?.saveApplications === false)
    return { ok: true, state: "disabled" };
  async function verify() {
    const live = await chrome.tabs.sendMessage(
      sender.tab.id,
      { type: "jobs:applied-status-check" },
      { documentId: sender.documentId },
    );
    if (!live || live.url !== message.url || live.quote !== message.quote)
      throw Error("Applied status changed before recording");
  }
  await verify();
  const resolved = await JobsSync.resolveJob(url);
  if (!resolved) throw Error("Application status unavailable");
  if (resolved.state !== "matched") return { ok: true, state: "unmatched" };
  await verify();
  if (resolved.application?.confirmed) return { ok: true, state: "confirmed" };
  // Observation time is not a reconstructed submission date. Preserve existing
  // title/Profile metadata and use the same durable receipt queue as submissions.
  await JobsSync.record(
    { status: "applied", jobLink: url, jobTitle: "" },
    { url: sender.url, tabId: sender.tab.id, proof: "ats_confirmation" },
  );
  return { ok: true, state: "pending" };
}
