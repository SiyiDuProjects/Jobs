import { build } from "esbuild";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
const code = (
  await build({
    stdin: {
      contents:
        'import "./src/custom/panel-background.js"; import "./src/custom/review-background.js";',
      resolveDir: new URL("../../", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: "iife",
  })
).outputFiles[0].text;
export const event = () => {
  const handlers = new Set();
  return {
    addListener: (fn) => handlers.add(fn),
    removeListener: (fn) => handlers.delete(fn),
    emit: (...args) => [...handlers].forEach((fn) => fn(...args)),
  };
};
export function dispatch(list, message, sender) {
  return new Promise((resolve) => {
    for (const fn of list) {
      let answered = false;
      const result = fn(message, sender, (value) => {
        answered = true;
        resolve(value);
      });
      if (answered || result === true) return;
    }
    resolve(undefined);
  });
}
export function panelWorker({
  send = async () => undefined,
  inject = async () => [],
} = {}) {
  let listeners = [];
  const storage = {},
    notifications = [],
    badges = [],
    opens = [];
  const tabs = new Map([
    [1, { id: 1, windowId: 5, url: "https://example.test/job" }],
  ]);
  const chrome = {
    runtime: {
      id: "jobs",
      getURL: (path) => "chrome-extension://jobs/" + path,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => {
        notifications.push(message);
      },
    },
    sidePanel: {
      setPanelBehavior: async (value) => {
        opens.push(value);
      },
      open: async (value) => {
        opens.push(value);
      },
    },
    action: {
      setBadgeText: async (value) => {
        badges.push(value);
      },
    },
    scripting: { executeScript: inject },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      session: {
        get: async (key) => ({ [key]: structuredClone(storage[key]) }),
        set: async (value) => {
          Object.assign(storage, structuredClone(value));
        },
        remove: async (keys) => {
          for (const key of [keys].flat()) delete storage[key];
        },
      },
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw Error("Tab closed");
        return tabs.get(id);
      },
      sendMessage: send,
      onUpdated: event(),
      onRemoved: event(),
    },
  };
  function restart() {
    listeners = [];
    vm.runInNewContext(code, { crypto: webcrypto, chrome, console });
  }
  restart();
  const panel = { id: "jobs", url: chrome.runtime.getURL("popup.html") };
  const page = {
    id: "jobs",
    tab: tabs.get(1),
    frameId: 0,
    documentId: "top-doc",
  };
  return {
    chrome,
    storage,
    tabs,
    notifications,
    badges,
    opens,
    restart,
    panel,
    page,
    call: (message, sender = panel) => dispatch(listeners, message, sender),
  };
}
