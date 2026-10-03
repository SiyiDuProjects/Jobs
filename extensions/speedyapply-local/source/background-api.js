import { saveResponses } from "./saved-responses.js";
// Packaged worker protocol. Content senders may only act on their own tab.
import { JobsTabProfiles } from "../src/custom/tab-profiles.js";
import { JobsPrivateSession } from "../src/custom/private-session.js";
import { JobsSync } from "../src/custom/sync.js";
import { JobsJobMatch } from "../src/custom/job-match.js";
import { JobsAnswerContext } from "../src/custom/automatic-background.js";
import { reportJobTitle } from "./job-title-background.js";
import { recordAppliedStatus } from "./applied-status-background.js";
const defaults = {
  saveApplications: true,
  saveResponses: true,
  autoClickNextPage: false,
  autoSubmit: false,
};
export async function handle(message, sender) {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab?.id ||
    !/^https?:\/\//.test(sender.url || "")
  )
    throw Error("Application tab required");
  const id = sender.tab.id;
  if (message.type === "jobs:applied-status-observed")
    return recordAppliedStatus(message, sender);
  if (message.type === "jobs:job-title-observed")
    return reportJobTitle(message, sender);
  if (message.type === "getAutofillConfig") {
    const data =
      /** @type {{settings?:{autofillSettings?:Partial<typeof defaults>},autofillAccount?:{accountEmail?:string,accountPassword?:string,useProfileEmail?:boolean},autofillEnabled?:boolean}} */ (
        await chrome.storage.local.get([
          "settings",
          "autofillAccount",
          "autofillEnabled",
        ])
      );
    const account = {
      accountEmail: "",
      accountPassword: "",
      useProfileEmail: false,
      ...data.autofillAccount,
    };
    // Reading local settings must not prepare and synchronize a filling run.
    // Only Profile-derived account email needs resolution before account entry.
    const bound = account.useProfileEmail
      ? await JobsTabProfiles.ensure(sender, false)
      : await JobsTabProfiles.selected(id);
    if (account.useProfileEmail && bound?.profile)
      account.accountEmail = bound.profile.contactData.email;
    return {
      enabled: data.autofillEnabled !== false,
      hasProfile: !!bound,
      autofillSettings: { ...defaults, ...data.settings?.autofillSettings },
      accountSettings: account,
    };
  }
  if (message.type === "storeJobDetails") {
    const epoch = JobsPrivateSession.epoch;
    if (
      typeof message.appUrl !== "string" ||
      !/^https?:\/\//.test(message.appUrl)
    )
      throw Error("Invalid job URL");
    const key = "job_" + id;
    const previous =
      /** @type {{appUrl:string,title:string,description:string}|undefined} */ (
        (await chrome.storage.session.get(key))[key]
      );
    const sameJob =
      previous && JobsJobMatch.same(previous.appUrl, message.appUrl);
    await JobsPrivateSession.commit(epoch, {
      [key]: {
        title: String(
          message.observedTitle ||
            (sameJob && previous.title) ||
            message.title ||
            "",
        ).slice(0, 500),
        description: String(
          message.description || (sameJob && previous.description) || "",
        ).slice(0, 18000),
        appUrl: message.appUrl,
      },
    });
    return { ok: true };
  }
  if (message.type === "saveResponses")
    return saveResponses(message.data, sender);
  if (message.type === "saveApplication") {
    const bound = await JobsTabProfiles.ensure(sender, false);
    await JobsSync.record(
      {
        status: "applied",
        // A receipt may have no posting title. Keep the server's existing
        // title instead of replacing it with the confirmation page heading.
        jobTitle:
          message.jobsSyncProof === "ats_confirmation" &&
          message.jobTitle === ""
            ? ""
            : message.jobTitle || documentTitle(sender),
        jobLink: message.jobLink || sender.url,
        companyName: message.companyName || "",
        date: new Date().toISOString(),
        profileName: bound?.profileName,
      },
      {
        url: sender.url,
        tabId: id,
        proof: message.jobsSyncProof,
        profileId: bound?.id,
      },
    );
    return { ok: true };
  }
  if (message.type === "jobs:application-status") {
    const key = JobsJobMatch.key(message.url);
    // Login/registration pages can fill account settings without a posting.
    // No identity means unknown status, not permission to submit.
    if (!key) return { applied: false, confirmed: false, unknown: true };
    const epoch = JobsPrivateSession.epoch;
    const result = await JobsSync.resolveJob(message.url);
    await JobsTabProfiles.rememberResolution?.(message.url, result, epoch);
    if (result?.application?.submitted)
      return {
        applied: true,
        confirmed: result.application.confirmed,
        label: result.application.label,
      };
    const connection =
      /** @type {import('../src/custom/sync-types').SyncState} */ (
        (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1
      );
    const pending = connection?.outbox?.some(
      (item) =>
        [
          "submit_attempt",
          "submit_validation_error",
          "tracker_record",
          "ats_confirmation",
        ].includes(item.payload.proof) &&
        JobsJobMatch.key(item.payload.job_url) === key,
    );
    return {
      applied: !!pending,
      confirmed: false,
      label: pending ? "已有提交记录，等待同步" : "",
      unknown: !result,
    };
  }
}
function documentTitle(sender) {
  return sender.tab?.title || "Application";
}
const types = new Set([
  "jobs:applied-status-observed",
  "jobs:job-title-observed",
  "getAutofillConfig",
  "storeJobDetails",
  "saveApplication",
  "saveResponses",
  "jobs:application-status",
]);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!types.has(message?.type)) return;
  handle(message, sender).then(
    (data) => reply({ data, ...(data?.ok ? { ok: true } : {}) }),
    (error) => reply({ error: error.message }),
  );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "generate-response") return;
  let disconnected = false,
    busy = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  port.onMessage.addListener(async (message) => {
    if (message?.type !== "GENERATE_RESPONSE" || busy || disconnected) return;
    busy = true;
    try {
      const sender = port.sender;
      if (sender?.id !== chrome.runtime.id || !sender.tab?.id)
        throw Error("Application tab required");
      const operation = await JobsAnswerContext.create(sender),
        { bound, job } = operation;
      const result = await JobsSync.generateAnswer({
        profileId: bound.id,
        profileVersion: bound.lastSync,
        prompt: String(message.prompt || "").slice(0, 4000),
        additionalContext: String(message.additionalContext || "").slice(
          0,
          4000,
        ),
        jobTitle: job?.title || "",
        jobDescription: job?.description || "",
      });
      await operation.verify();
      if (disconnected) return;
      port.postMessage({ type: "STREAM_UPDATE", text: result.text });
      port.postMessage({
        type: "STREAM_END",
        responseId: result.responseId,
        source: result.source,
      });
    } catch (error) {
      if (!disconnected)
        port.postMessage({ type: "STREAM_ERROR", error: error.message });
    } finally {
      busy = false;
    }
  });
});
