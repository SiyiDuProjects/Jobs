import { JobsBrand } from "./brand.js";
import { JobsApplicationQueue } from "./application-queue.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsSync } from "./sync.js";
export var JobsQueueBackground;
let initialized = false;
export function initializeQueueBackground() {
  if (initialized) return;
  initialized = true;
  (() => {
    const KEY = "jobsApplicationQueueV1",
      SESSION = "jobsApplicationQueueSessionV1";
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
      resolve: (url, id) => JobsSync.resolveJob(url, id),
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
    const run = () => engine.tick().catch(() => {});
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (!["jobs:queue", "jobs:queue-page"].includes(message?.type)) return;
      const task = (async () => {
        if (sender.id !== chrome.runtime.id) throw Error("仅限本插件");
        if (message.type === "jobs:queue-page") {
          if (
            !Number.isInteger(sender.tab?.id) ||
            !/^https:\/\//.test(sender.url || "")
          )
            throw Error("仅限申请页面");
          return engine.page(message.data, {
            tabId: sender.tab.id,
            frameId: sender.frameId,
            browserDocumentId: sender.documentId,
            lifecycle: sender.documentLifecycle,
            url: sender.url,
          });
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
    JobsQueueBackground = Object.freeze({ tick: run });
    void run();
  })();
}
