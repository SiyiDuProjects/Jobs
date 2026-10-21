import { JobsSync } from "./sync.js";
import { validateCorpus } from "./corpus-case.js";
import { publicJobUrl, icimsFormJobUrl } from "./public-job-url.js";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export async function corpusFingerprint(value) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonical({ trees: value.trees, fields: value.fields })),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
// A page outcome the service has not acknowledged is kept, latest state per
// page, and sent again; the service keeps one entry per page of a run, so a
// repeat or a newer state never adds a second failure.
const RETRY = "jobsCorpusOutcomeRetryV1",
  RETRY_LIMIT = 20,
  RETRY_BYTES = 1500000,
  RETRY_AGE = 86400000;
const outcomeKey = (failure) =>
  failure?.outcomes ? failure.runId + "|" + failure.documentId : "";
let retryQueue = Promise.resolve();
// Pages in many tabs report at once; each read-modify-write runs alone.
function retryState(update) {
  const task = retryQueue.then(() => updateRetry(update));
  retryQueue = task.then(
    () => {},
    () => {},
  );
  return task;
}
async function updateRetry(update) {
  const saved = (await chrome.storage.local.get(RETRY))[RETRY] || {};
  const next = update(saved) || saved;
  const kept = Object.entries(next)
    .filter(([, entry]) => Date.now() - entry.at < RETRY_AGE)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, RETRY_LIMIT);
  if (kept.length)
    await chrome.storage.local.set({ [RETRY]: Object.fromEntries(kept) });
  else await chrome.storage.local.remove(RETRY);
  if (kept.length)
    chrome.alarms?.create("jobs-corpus-outcomes", { periodInMinutes: 1 });
  else chrome.alarms?.clear("jobs-corpus-outcomes");
  return Object.fromEntries(kept);
}
async function captureOutcome({ fingerprint, page, failure }) {
  const captured = await JobsSync.corpusRequest("POST", {
    action: "capture",
    fingerprint,
    page,
    failure,
  });
  if (!captured?.failureId)
    throw Error("Server did not acknowledge the failed corpus page");
  return captured;
}
let retrying;
function retryOutcomes() {
  retrying ||= (async () => {
    for (const [key, entry] of Object.entries(await retryState(() => {}))) {
      await captureOutcome(entry);
      await retryState((saved) => {
        if (saved[key]?.at === entry.at) delete saved[key];
      });
    }
  })()
    .catch(() => {})
    .finally(() => {
      retrying = undefined;
    });
  return retrying;
}
export function initializeCorpusBackground() {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === "jobs-corpus-outcomes") void retryOutcomes();
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      [
        "jobs:corpus-failures",
        "jobs:corpus-failure-page",
        "jobs:corpus-resolve-failure",
      ].includes(message?.type)
    ) {
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        sender.url?.split(/[?#]/)[0] !==
          chrome.runtime.getURL("diagnostics.html")
      ) {
        reply({ error: "Private diagnostics page required" });
        return;
      }
      const action = message.type.slice("jobs:corpus-".length);
      void JobsSync.corpusRequest("POST", {
        action,
        id: message.id,
        resolved: message.resolved,
      }).then(
        (data) => reply({ data }),
        () => reply({ error: "题库暂未连接，已有记录保留" }),
      );
      return true;
    }
    if (message?.type !== "jobs:corpus-page") return;
    if (
      sender.id !== chrome.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      !sender.url?.startsWith("https://")
    ) {
      reply({ error: "Invalid corpus sender" });
      return;
    }
    async function upload() {
      // Identity comes from Chrome's sender, never a URL claimed by page code.
      let jobIdentity = "";
      try {
        jobIdentity = icimsFormJobUrl(sender) || publicJobUrl(sender.url);
      } catch {
        // Unknown token-dependent URLs remain unlinked, never guessed.
      }
      const page = { ...message.value, jobIdentity };
      validateCorpus(page);
      const fingerprint = await corpusFingerprint(page);
      const known = message.failure
        ? { known: false }
        : await JobsSync.corpusRequest("POST", {
            action: "probe",
            fingerprint,
            platform: message.value.platform,
            company: page.company,
            jobIdentity,
          });
      let captured;
      const key = outcomeKey(message.failure);
      if (key) {
        const entry = {
          fingerprint,
          page,
          failure: message.failure,
          at: Date.now(),
        };
        try {
          captured = await captureOutcome(entry);
        } catch (error) {
          if (JSON.stringify(entry).length <= RETRY_BYTES)
            await retryState((saved) => {
              saved[key] = entry;
            });
          throw error;
        }
        await retryState((saved) => {
          delete saved[key];
        });
        void retryOutcomes();
      } else if (!known.known)
        captured = await JobsSync.corpusRequest("POST", {
          action: "capture",
          fingerprint,
          page,
          ...(message.failure ? { failure: message.failure } : {}),
        });
      if (message.failure && !captured?.failureId)
        throw Error("Server did not acknowledge the failed corpus page");
      if (
        message.correction &&
        message.value.fields.some((field) => field.id === message.correction)
      )
        await JobsSync.corpusRequest("POST", {
          action: "correction",
          fingerprint,
          fieldId: message.correction,
          id: message.correctionId,
        });
      return { ok: true, ...captured };
    }
    void upload().then(
      (data) => reply({ data }),
      () => reply({ error: "题库采集暂未同步" }),
    );
    return true;
  });
}
