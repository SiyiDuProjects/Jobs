import { JobsTabProfiles } from "./tab-profiles.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsSync } from "./sync.js";
export var JobsAnswerContext;
let initialized = false;
export function initializeAutomaticBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const requests = new Map();
    async function context(sender) {
      const bound = await JobsTabProfiles.verify(sender);
      if (!bound) throw Error("本页 Profile 不可用");
      const snapshot = JSON.stringify(bound),
        frameId = sender.frameId || 0,
        tab = await chrome.tabs.get(sender.tab.id);
      if (!/^https?:\/\//.test(sender.url || tab.url || ""))
        throw Error("申请页面已变化，请重新开始");
      if (frameId > 0 && !sender.documentId)
        throw Error("申请文档已变化，请重新开始");
      // Chrome's exact document target, plus its active adapter, is the identity
      // authority. Its live location is the page URL: a single-page ATS (Ashby
      // Overview -> Application) changes location without a new document, while
      // sender.url keeps the URL that document was created with. This read-only
      // check does not register a frame or enable any writes.
      async function documentUrl() {
        if (!sender.documentId) return sender.url || tab.url;
        let timer, answer;
        try {
          answer = await Promise.race([
            chrome.tabs.sendMessage(
              sender.tab.id,
              { type: "jobs:document-check" },
              { documentId: sender.documentId },
            ),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("申请文档未响应，请检查当前页面")),
                2500,
              );
            }),
          ]);
        } catch (error) {
          throw Error(
            /未响应/.test(error.message)
              ? error.message
              : "申请文档已变化，请重新开始",
          );
        } finally {
          clearTimeout(timer);
        }
        if (answer?.active !== true || !/^https?:\/\//.test(answer.url || ""))
          throw Error("申请文档已变化，请重新开始");
        return answer.url;
      }
      const url = await documentUrl();
      if (frameId === 0 && url !== tab.url)
        throw Error("申请页面已变化，请重新开始");
      const current = async () => {
        const live = await chrome.tabs.get(sender.tab.id);
        if (live.url !== tab.url) throw Error("等待 AI 时申请页面已变化");
        if (sender.documentId && (await documentUrl()) !== url)
          throw Error("申请文档已变化，请重新开始");
      };
      const cached =
        /** @type {{appUrl:string,title:string,description:string}|undefined} */ (
          (await chrome.storage.session.get("job_" + sender.tab.id))[
            "job_" + sender.tab.id
          ]
        );
      const job =
        cached?.appUrl &&
        (JobsJobMatch.same(cached.appUrl, url) ||
          (frameId > 0 && JobsJobMatch.same(cached.appUrl, tab.url)))
          ? cached
          : null;
      return {
        bound,
        job,
        async verify() {
          const after = await JobsTabProfiles.verify(sender);
          if (JSON.stringify(after) !== snapshot)
            throw Error("等待 Luna 时本页 Profile 已改变");
          await current();
        },
      };
    }
    JobsAnswerContext = Object.freeze({ create: context });
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message?.type !== "jobs:auto-answers") return;
      const run = async () => {
        if (sender.id !== chrome.runtime.id || !sender.tab?.id)
          throw Error("Application tab required");
        if (sender.frameId > 0) {
          // context() verifies the exact document and active ATS adapter even
          // when an iframe's observation registration has not arrived yet.
          if (!sender.documentId || new URL(sender.url).protocol !== "https:")
            throw Error("Active application frame required");
        }
        if (requests.has(sender.tab.id)) throw Error("本页已有 Luna 请求");
        requests.set(sender.tab.id, true);
        try {
          const operation = await context(sender),
            { bound, job } = operation;
          if (
            !bound ||
            JobsProfileAnswers.signature(bound.profile) !== message.profileStamp
          )
            throw Error("本页 Profile 已改变");
          const result = await JobsSync.generateAnswer({
            profileId: bound.id,
            profileVersion: bound.lastSync,
            fields: message.fields,
            formContext: message.formContext,
            jobTitle: String(job?.title || message.jobTitle || "").slice(
              0,
              500,
            ),
            jobDescription: String(job?.description || "").slice(0, 18000),
          });
          await operation.verify();
          return { ...result, profileId: bound.id };
        } finally {
          requests.delete(sender.tab.id);
        }
      };
      run().then(
        (data) => reply({ data }),
        (error) =>
          reply({ error: String(error.message || error).slice(0, 600) }),
      );
      return true;
    });
  })();
}
