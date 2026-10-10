import { JobsSync } from "./sync.js";
import { validateCorpus } from "./corpus-case.js";
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
      validateCorpus(message.value);
      const fingerprint = await corpusFingerprint(message.value);
      const known = await JobsSync.corpusRequest("POST", {
        action: "probe",
        fingerprint,
        platform: message.value.platform,
        company: message.value.company,
      });
      if (!known.known)
        await JobsSync.corpusRequest("POST", {
          action: "capture",
          fingerprint,
          page: message.value,
        });
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
      return { ok: true };
    }
    void upload().then(
      (data) => reply({ data }),
      () => reply({ error: "题库采集暂未同步" }),
    );
    return true;
  });
}
