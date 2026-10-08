import { JobsAnswerContext } from "./automatic-background.js";
import { JobsPrivateSession } from "./private-session.js";
import { JobsJobMatch } from "./job-match.js";
import { updateDraftJournal, approveDraftJournal } from "./draft-journal.js";
let serial = Promise.resolve();
export async function draftRequest(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.documentId)
    throw Error("Application document required");
  const epoch = JobsPrivateSession.epoch;
  const operation = await JobsAnswerContext.create(sender);
  const job = JobsJobMatch.key(operation.job?.appUrl || operation.url);
  if (!job) throw Error("当前申请身份不可用");
  const key = "jobsDrafts:" + sender.tab.id;
  const scope = JSON.stringify([
    job,
    operation.bound.id,
    operation.bound.lastSync,
  ]);
  const run = serial.then(async () => {
    JobsPrivateSession.assertCurrent(epoch);
    await operation.verify();
    const stored = /** @type {{scope?:string,state?:object}|undefined} */ (
      (await chrome.storage.session.get(key))[key]
    );
    let state =
      stored?.scope === scope ? stored.state : updateDraftJournal(null, []);
    if (message.action === "put") {
      if (!Array.isArray(message.items) || message.items.length > 90)
        throw Error("Invalid drafts");
      state = updateDraftJournal(state, message.items);
    } else if (message.action === "approve") {
      state = approveDraftJournal(state, message.revision);
    } else if (message.action !== "read") throw Error("Invalid draft action");
    await operation.verify();
    await JobsPrivateSession.commit(epoch, { [key]: { scope, state } });
    return state;
  });
  serial = run.catch(() => {});
  return run;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "jobs:drafts") return;
  draftRequest(message, sender).then(
    (data) => reply({ data }),
    (error) => reply({ error: error.message }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener(
  (id) => void chrome.storage.session.remove("jobsDrafts:" + id),
);
