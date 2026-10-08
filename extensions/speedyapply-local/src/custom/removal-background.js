import { JobsJobMatch } from "./job-match.js";
import { JobsSync } from "./sync.js";
import { JobsPrivateSession } from "./private-session.js";
export var JobsRemovalBackground;
let initialized = false;
export function initializeRemovalBackground() {
  if (initialized) return;
  initialized = true;
  let identityEpoch = JobsPrivateSession.epoch;
  const identityGroups = new Map();
  function currentIdentities() {
    if (identityEpoch !== JobsPrivateSession.epoch) {
      identityGroups.clear();
      identityEpoch = JobsPrivateSession.epoch;
    }
    return identityGroups;
  }
  function rememberIdentities(keys, epoch) {
    JobsPrivateSession.assertCurrent(epoch);
    const groups = currentIdentities();
    // Only remember groups already validated by the fresh safety read. These
    // revoke in-flight permissions locally; they never grant new permission.
    if (keys?.length > 1) {
      const group = [...keys].sort();
      groups.set(JSON.stringify(group), group);
    }
  }
  const removalChecks = new Map();
  async function removalState(url, fresh, localOnly = false) {
    const epoch = JobsPrivateSession.epoch;
    if (await JobsSync.removalPending(url)) return { removed: true };
    if (localOnly) {
      const key = JobsJobMatch.key(url);
      for (const group of currentIdentities().values())
        if (group.includes(key) && (await JobsSync.removalPending(url, group)))
          return { removed: true };
      return { removed: false };
    }
    const key = JobsJobMatch.key(url);
    if (key) {
      let check = removalChecks.get(key);
      if (!check || fresh || Date.now() - check.at > 5000) {
        check = {
          at: Date.now(),
          value: JobsSync.resolveJob(url, undefined, { fresh }),
        };
        removalChecks.set(key, check);
        if (removalChecks.size > 100)
          removalChecks.delete(removalChecks.keys().next().value);
      }
      const result = await check.value.catch((error) => {
        if (fresh) throw error;
        return null;
      });
      if (result?.removal?.removed) return { removed: true };
      // Final navigation requires a verified read. The service omits removal
      // for unmatched jobs, but matched jobs must explicitly be unremoved.
      if (
        fresh &&
        result?.state !== "unmatched" &&
        !(result?.state === "matched" && result.removal?.removed === false)
      )
        throw Error("无法核对岗位移除状态，暂不继续");
      const identityKeys = fresh ? result?.identity_job_keys : undefined;
      const pending = await JobsSync.removalPending(url, identityKeys);
      if (fresh) rememberIdentities(identityKeys, epoch);
      return {
        removed: pending,
        identityKeys,
      };
    }
    return { removed: false };
  }
  async function remove(url) {
    const epoch = JobsPrivateSession.epoch,
      key = JobsJobMatch.key(url),
      identities = new Set();
    for (const group of currentIdentities().values())
      if (group.includes(key))
        for (const identity of group) identities.add(identity);
    const alsoMatches = (candidate) =>
      epoch === JobsPrivateSession.epoch &&
      identities.has(JobsJobMatch.key(candidate));
    // Block every open copy, including ordinary tabs and all their frames.
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => /^https?:/.test(tab.url || ""))
        .map((tab) =>
          chrome.tabs
            .sendMessage(tab.id, {
              type: "jobs:job-removed",
              url,
              identityKeys: [...identities],
              topMatches:
                JobsJobMatch.same(tab.url, url) || alsoMatches(tab.url),
            })
            .catch(() => {}),
        ),
    );
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "jobs:removal-check") return;
    const run = async () => {
      if (
        sender.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        !sender.url?.startsWith("https://")
      )
        throw Error("Application document required");
      const epoch = JobsPrivateSession.epoch;
      const tab = await chrome.tabs.get(sender.tab.id);
      const url = sender.frameId > 0 ? tab.url : message.url || sender.url;
      const result = await removalState(
        url,
        message.final === true,
        message.final !== true,
      );
      const pending = await JobsSync.removalPending(url, result.identityKeys);
      JobsPrivateSession.assertCurrent(epoch);
      return { removed: result.removed || pending };
    };
    run().then(
      (data) => reply({ data }),
      (error) => reply({ error: error.message }),
    );
    return true;
  });
  JobsRemovalBackground = Object.freeze({ remove, removalState });
}
