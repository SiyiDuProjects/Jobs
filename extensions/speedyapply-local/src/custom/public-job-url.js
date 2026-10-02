import { JobsJobMatch } from "./job-match.js";
const sensitive =
  /secret|credential|token|session|^sid$|auth|^code$|^(?:api[-_]?)?key$|^sig(?:nature)?$|pass(?:word|code)?$|e-?mail|^nonce$|^state$|ticket|jwt|otp|phone/i;
const postingToken = (url, name) =>
  name === "token" &&
  /(^|\.)greenhouse\.io$/.test(url.hostname) &&
  /^\d+$/.test(url.searchParams.get(name) || "");
// An observation can exist before a posting has been identified. Its URL is
// descriptive only; command freshness is bound to the actual Chrome document.
export function publicPageUrl(value) {
  try {
    return publicJobUrl(value);
  } catch {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    if (/@/.test(decodeURIComponent(url.pathname))) url.pathname = "/";
    for (const name of [...url.searchParams.keys()])
      if (sensitive.test(name) && !postingToken(url, name))
        url.searchParams.delete(name);
    return url.href.slice(0, 3000);
  }
}
// Public posting identity is separate from credentials. If redacting a secret
// would change an unknown URL's identity, decline to archive that URL.
export function publicJobUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /@/.test(decodeURIComponent(url.pathname))
  )
    throw Error("Private or unsupported job URL");
  const key = JobsJobMatch.key(url.href);
  if (!key) throw Error("Job identity unavailable");
  for (const name of [...url.searchParams.keys()]) {
    const trial = new URL(url);
    trial.searchParams.delete(name);
    const unchanged = JobsJobMatch.key(trial.href) === key;
    if (sensitive.test(name) && !postingToken(url, name)) {
      if (!unchanged)
        throw Error("Private parameters are part of an unknown job identity");
      url.searchParams.delete(name);
    } else if (unchanged) url.searchParams.delete(name);
  }
  if (url.hash) {
    const trial = new URL(url);
    trial.hash = "";
    if (JobsJobMatch.key(trial.href) === key) url.hash = "";
    else if (/token|code=|state=|auth|@/i.test(url.hash))
      throw Error("Private fragment is part of an unknown job identity");
  }
  if (JobsJobMatch.key(url.href) !== key)
    throw Error("Redaction changed the job identity");
  url.searchParams.sort();
  if (url.href.length > 3000) throw Error("Job URL is too long");
  return url.href;
}
