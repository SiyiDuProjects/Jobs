import { JobsJobMatch } from "./job-match.js";
import { JobsTabProfiles } from "./tab-profiles.js";
import { JobsSync } from "./sync.js";
let initialized = false;
export function initializeSubmissionBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const KEY = "jobsSubmissionGuardsV1";
    let serial = Promise.resolve();
    async function handle(message, sender) {
      if (
        sender.id !== chrome.runtime.id ||
        !sender.tab?.id ||
        !sender.documentId ||
        !/^https:\/\//.test(sender.url || "")
      )
        throw Error("Application document required");
      const key = JobsJobMatch.key(message.url);
      if (!key || !JobsJobMatch.same(sender.url, message.url))
        throw Error("Application identity unavailable");
      const state = (await chrome.storage.local.get(KEY))[KEY] || {},
        observed = message.type === "jobs:submission-observed";
      let old = state[key];
      if (message.type === "jobs:submission-prepare" || (observed && !old)) {
        if (old)
          throw Error("此岗位已有提交保护记录，结果待核实，不能再次自动提交");
        if (observed && message.validationError)
          throw Error("No executed submission attempt");
        const live = await chrome.tabs.sendMessage(
          sender.tab.id,
          { type: "jobs:document-check" },
          { documentId: sender.documentId },
        );
        if (!live?.active || !JobsJobMatch.same(live.url, message.url))
          throw Error("Application document changed");
        const bound = await JobsTabProfiles.verify(sender);
        const application = await JobsSync.resolveJob(live.url);
        if (!application) throw Error("无法核对既有投递记录，暂不提交");
        if (application.application?.submitted)
          throw Error("此岗位已有提交记录，不能重复自动提交");
        const row = {
          id: crypto.randomUUID(),
          state: "prepared",
          at: Date.now(),
          tabId: sender.tab.id,
          documentId: sender.documentId,
          profileId: bound?.id,
          profileName: bound?.profileName,
        };
        state[key] = row;
        await chrome.storage.local.set({ [KEY]: state });
        if (!observed) return { id: row.id };
        old = row;
      }
      if (
        !old ||
        (!observed && old.id !== message.id) ||
        old.documentId !== sender.documentId
      )
        throw Error("Submission guard changed");
      const rejected =
        message.type === "jobs:submission-validation-error" ||
        (observed && message.validationError === true);
      if (rejected && old.state === "prepared")
        throw Error("No executed submission attempt");
      if (
        (rejected && old.state === "validation_error") ||
        (!rejected && old.state !== "prepared")
      )
        return { ok: true, id: old.id };
      await JobsSync.record(
        {
          status: "applied",
          jobLink: message.url,
          jobTitle: sender.tab.title || "Application",
          date: new Date().toISOString(),
          profileName: old.profileName,
        },
        {
          url: sender.url,
          tabId: sender.tab.id,
          proof: rejected ? "submit_validation_error" : "submit_attempt",
          eventId: old.id + (rejected ? ":validation" : ""),
          profileId: old.profileId,
        },
      );
      state[key] = {
        ...old,
        state: rejected ? "validation_error" : "attempted",
        attemptedAt: old.attemptedAt || Date.now(),
      };
      await chrome.storage.local.set({ [KEY]: state });
      return { ok: true };
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        ![
          "jobs:submission-prepare",
          "jobs:submission-attempted",
          "jobs:submission-validation-error",
          "jobs:submission-observed",
        ].includes(message?.type)
      )
        return;
      const task = serial.then(() => handle(message, sender));
      serial = task.then(
        () => {},
        () => {},
      );
      task.then(
        (data) => reply({ data }),
        (error) => reply({ error: error.message }),
      );
      return true;
    });
  })();
}
