import { JobsBrand } from "./brand.js";
import { JobsApplicationQueue } from "./application-queue.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsSync } from "./sync.js";
import { JobsPrivateSession } from "./private-session.js";
export var JobsQueueBackground;
let initialized = false;
export function initializeQueueBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const KEY = "jobsApplicationQueueV1",
      SESSION = "jobsApplicationQueueSessionV1";
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
    const engine = JobsApplicationQueue.create({
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      same: (a, b) => JobsJobMatch.same(a, b),
      load: async () => (await chrome.storage.local.get(KEY))[KEY],
      save: (state) => chrome.storage.local.set({ [KEY]: state }),
      session: async () => {
        let id = (await chrome.storage.session.get(SESSION))[SESSION];
        if (!id) {
          id = crypto.randomUUID();
          await chrome.storage.session.set({ [SESSION]: id });
        }
        return id;
      },
      resolve: async (url, id) => {
        const epoch = JobsPrivateSession.epoch;
        if (await JobsSync.removalPending(url))
          throw Error("岗位已停止并请求移除");
        const result = await JobsSync.resolveJob(url, id, { fresh: true });
        if (
          result?.removal?.removed ||
          (await JobsSync.removalPending(url, result?.identity_job_keys))
        )
          throw Error("岗位已停止并请求移除");
        JobsPrivateSession.assertCurrent(epoch);
        rememberIdentities(result?.identity_job_keys, epoch);
        return result;
      },
      autoSubmit: async () => {
        const value =
          /** @type {{settings?:{autofillSettings?:{autoSubmit?:boolean}}}} */ (
            await chrome.storage.local.get("settings")
          );
        return value.settings?.autofillSettings?.autoSubmit === true;
      },
      tabs: () => chrome.tabs.query({}),
      tab: (id) => chrome.tabs.get(id),
      staging: (nonce) =>
        chrome.runtime.getURL("queue-entry.html") + "#" + nonce,
      createTab: (url) => chrome.tabs.create({ url, active: true }),
      navigate: (id, url) => chrome.tabs.update(id, { url }),
      focus: async (id) => {
        const tab = await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      },
      control: (id, state) =>
        chrome.tabs.sendMessage(id, { type: "jobs:queue-control", state }),
    });
    const removed = {
      owned: true,
      allowed: false,
      removed: true,
      state: "cancelled",
    };
    const removalChecks = new Map();
    async function removalState(url, fresh) {
      const epoch = JobsPrivateSession.epoch;
      if (await JobsSync.removalPending(url)) return { removed: true };
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
          .filter(
            (tab) => JobsJobMatch.same(tab.url, url) || alsoMatches(tab.url),
          )
          .map((tab) =>
            chrome.tabs
              .sendMessage(tab.id, {
                type: "jobs:queue-control",
                state: removed,
              })
              .catch(() => {}),
          ),
      );
      await engine.remove(url, alsoMatches);
    }
    const run = () => engine.tick().catch(() => {});
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (!["jobs:queue", "jobs:queue-page"].includes(message?.type)) return;
      const task = (async () => {
        if (sender.id !== chrome.runtime.id) throw Error("仅限本插件");
        if (message.type === "jobs:queue-page") {
          const epoch = JobsPrivateSession.epoch;
          if (
            !Number.isInteger(sender.tab?.id) ||
            !/^https:\/\//.test(sender.url || "")
          )
            throw Error("仅限申请页面");
          const tabUrl =
            sender.frameId > 0
              ? (await chrome.tabs.get(sender.tab.id)).url
              : message.data.url || sender.url;
          const removal = await removalState(
            tabUrl,
            message.data.type === "intent",
          );
          if (removal.removed) return removed;
          const result = await engine.page(message.data, {
            tabId: sender.tab.id,
            frameId: sender.frameId,
            browserDocumentId: sender.documentId,
            lifecycle: sender.documentLifecycle,
            url: sender.url,
          });
          // A popup deletion may arrive while the queue awaited the service.
          const pending = await JobsSync.removalPending(
            tabUrl,
            removal.identityKeys,
          );
          JobsPrivateSession.assertCurrent(epoch);
          return pending ? removed : result;
        }
        const ui = sender.url === chrome.runtime.getURL("queue.html");
        const site =
          sender.tab &&
          sender.frameId === 0 &&
          new URL(sender.url).origin === JobsBrand.origin &&
          message.action === "add";
        if (!ui && !site) throw Error("请从队列界面或岗位列表操作");
        return engine.command(message.action, message.args);
      })();
      task.then(
        (data) => reply({ data }),
        (error) =>
          reply({ error: String(error.message || error).slice(0, 500) }),
      );
      return true;
    });
    chrome.alarms.create("jobs-application-queue", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "jobs-application-queue") void run();
    });
    chrome.runtime.onStartup.addListener(run);
    chrome.tabs.onRemoved.addListener(run);
    chrome.tabs.onUpdated.addListener((_id, change) => {
      if (change.status === "complete") void run();
    });
    JobsQueueBackground = Object.freeze({ tick: run, remove });
    void run();
  })();
}
