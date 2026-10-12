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
export function initializeCorpusBackground() {
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
      if (!known.known)
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
