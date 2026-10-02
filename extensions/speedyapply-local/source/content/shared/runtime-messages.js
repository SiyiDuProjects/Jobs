import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsJobMatch } from "../../../src/custom/job-match.js";
let lastReportedTitle = "";
/** @type {Set<string>} */
const pendingTitles = new Set();

/** Accept job titles, excluding generic page and application-step labels.
 * @param {unknown} title
 */
export function jobsJobTitle(title) {
  if (typeof title !== "string") return "";
  const value = title.replace(/\s+/g, " ").trim();
  const label = value.replace(/[.!…]+$/u, "").trim();
  if (
    !value ||
    value.length > 500 ||
    /^https?:\/\//i.test(value) ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    /^(?:apply(?: now| for (?:this )?(?:job|position))?|review(?: (?:your )?application)?|(?:job )?application(?: form)?|confirmation|success|careers?(?: page)?|job(?: details| opening| posting)?|unknown|untitled|n\/a|loading|sign in|log in|create account|about us|introduce yourself|similar jobs(?:\s*\(\d+\))?|my information|my experience|application questions|voluntary disclosures|self identification)$/i.test(
      label,
    ) ||
    /^(?:thank you\b|thanks for applying\b|your application\b|application (?:submitted|complete|received|confirmation)\b)/i.test(
      label,
    )
  )
    return "";
  return value;
}

/** Report observed metadata without waiting for an application or Profile. */
export async function jobsReportJobTitle(title, url = location.href) {
  if (url !== location.href) return false;
  const value = jobsJobTitle(title);
  if (!value) return false;
  const key = JSON.stringify([url, value]);
  if (lastReportedTitle === key) return true;
  if (pendingTitles.has(key)) return false;
  if (pendingTitles.size >= 8) return false;
  pendingTitles.add(key);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "jobs:job-title-observed",
      title: value,
      url,
    });
    if (response?.ok !== true) return false;
    lastReportedTitle = key;
    return true;
  } catch {
    return false;
  } finally {
    pendingTitles.delete(key);
  }
}

export async function jobsSaveApplicationRecord(application) {
  if (JobsJobMatch?.same(application.jobLink, location.href))
    void jobsReportJobTitle(application.jobTitle);
  if (application.jobsSyncProof === "ats_confirmation")
    JobsPageSession?.confirmed();
  const response = await chrome.runtime.sendMessage({
    type: "saveApplication",
    ...application,
  });
  if (response?.error) throw Error(response.error);
  return response;
}
