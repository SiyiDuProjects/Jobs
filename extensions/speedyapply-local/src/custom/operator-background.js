import { isPanel, notifyPanel } from "./panel-state.js";

const key = (tabId) => "jobsOperator:" + tabId;
let pending = Promise.resolve();
/** @template T @param {()=>Promise<T>} fn @returns {Promise<T>} */
const serial = (fn) => {
  const result = pending.then(fn);
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
};
/** @returns {Promise<{mode:string,epoch:string,since:number}>} */
async function loadOperator(tabId) {
  const saved =
    /** @type {{mode:string,epoch:string,since:number}|undefined} */ (
      (await chrome.storage.local.get(key(tabId)))[key(tabId)]
    );
  if (saved?.epoch) return saved;
  const state = {
    mode: "person",
    epoch: crypto.randomUUID(),
    since: Date.now(),
  };
  await chrome.storage.local.set({ [key(tabId)]: state });
  return state;
}
export const readOperator = (tabId) => serial(() => loadOperator(tabId));
export async function setOperator(tabId, mode) {
  return serial(async () => {
    const state = { mode, epoch: crypto.randomUUID(), since: Date.now() };
    await chrome.storage.local.set({ [key(tabId)]: state });
    // Omitting frameId broadcasts to every document in the tab. New documents
    // inherit the persisted mode on bootstrap, including after worker restart.
    await chrome.tabs
      .sendMessage(tabId, { type: "jobs:operator-changed", state })
      .catch(() => {});
    await notifyPanel(tabId);
    return state;
  });
}
export function initializeOperatorBackground() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.local.remove(key(tabId));
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!["jobs:operator-read", "jobs:operator-set"].includes(message?.type))
      return;
    const run = async () => {
      if (sender.id !== chrome.runtime.id) throw Error("Extension required");
      const panel = isPanel(sender),
        tabId = panel ? message.tabId : sender.tab?.id;
      if (!Number.isInteger(tabId)) throw Error("Application tab required");
      await chrome.tabs.get(tabId);
      if (message.type === "jobs:operator-read")
        return { state: await readOperator(tabId) };
      if (
        !["agent", "page-tool", ...(panel ? ["person"] : [])].includes(
          message.mode,
        )
      )
        throw Error("Only the side panel can hand control back to the person");
      return { state: await setOperator(tabId, message.mode) };
    };
    run().then(reply, (error) => reply({ error: error.message }));
    return true;
  });
}
