import { JobsTabProfiles } from "./tab-profiles.js";
import { JobsResponseContract } from "./response-contract.js";
export var JobsResponseScope;
let initialized = false;
export function initializeResponseScope() {
  if (initialized) return;
  initialized = true;
  const key = (id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id || ""))
      throw Error("Select this page's Profile before using saved answers");
    return "jobsResponses:" + id;
  };
  async function scopeFor(sender = {}) {
    if (!Number.isInteger(sender.tab?.id))
      throw Error("Application tab required");
    const selected = await JobsTabProfiles.ensure(sender);
    if (!selected?.id)
      throw Error("Select this page's Profile before using saved answers");
    return selected.id;
  }
  const storageKey = async (scope) => key(await scope);
  const read = async (storageKey) =>
    (await chrome.storage.session.get(storageKey))[storageKey] ?? [];
  JobsResponseScope = {
    ready: Promise.resolve(),
    key,
    scopeFor,
    storageKey,
    read,
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "jobs:responses-read") return;
    if (sender.id !== chrome.runtime.id) {
      reply({ error: "Invalid response caller" });
      return;
    }
    scopeFor(sender)
      .then(storageKey)
      .then(read)
      .then(
        (raw) => {
          const result = JobsResponseContract.readList(raw);
          reply({ data: result.data, rejected: result.rejected });
        },
        (error) => reply({ error: error.message }),
      );
    return true;
  });
}
