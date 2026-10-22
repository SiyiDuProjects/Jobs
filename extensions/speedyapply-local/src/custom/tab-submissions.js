// The latest submit attempt in each tab. It is the only basis for attributing
// a receipt shown on a page that no longer names its posting, such as
// Workday's "Application Submitted" dialog over Candidate Home.
const key = (tabId) => "jobsTabSubmit:" + tabId;
export const RECEIPT_WINDOW_MS = 30 * 60 * 1000;
const writes = new Map();
function update(tabId, action) {
  const task = (writes.get(tabId) || Promise.resolve()).then(action);
  const settled = task.catch(() => {});
  writes.set(tabId, settled);
  void settled.finally(() => {
    if (writes.get(tabId) === settled) writes.delete(tabId);
  });
  return task;
}
export const sameSubmitAttempt = (a, b) =>
  !!a && !!b && a.jobUrl === b.jobUrl && a.at === b.at && a.id === b.id;

/** @returns {Promise<{jobUrl:string,at:number,id?:string,confirmed?:boolean}|null>} */
export async function readSubmitAttempt(tabId) {
  const value = (await chrome.storage.session.get(key(tabId)))[key(tabId)];
  return /** @type {any} */ (value) || null;
}
export async function rememberSubmitAttempt(tabId, jobUrl, id) {
  if (!Number.isInteger(tabId) || typeof jobUrl !== "string") return;
  return update(tabId, async () => {
    const previous = await readSubmitAttempt(tabId);
    if (
      previous?.jobUrl === jobUrl &&
      (previous.confirmed || (id && previous.id === id))
    )
      return;
    await chrome.storage.session.set({
      [key(tabId)]: { jobUrl, at: Date.now(), ...(id ? { id } : {}) },
    });
  });
}
export async function confirmSubmitAttempt(tabId, attempt) {
  return update(tabId, async () => {
    if (!sameSubmitAttempt(await readSubmitAttempt(tabId), attempt))
      return false;
    await chrome.storage.session.set({
      [key(tabId)]: { ...attempt, confirmed: true },
    });
    return true;
  });
}
export async function forgetSubmitAttempt(tabId) {
  await update(tabId, () => chrome.storage.session.remove(key(tabId)));
}
export const submitAttemptKey = key;
