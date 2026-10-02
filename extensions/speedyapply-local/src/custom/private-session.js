// Private facts belong to the current connection and active page bindings.
// A connection change invalidates pending reads before clearing their storage.
let epoch = 0;
let queue = Promise.resolve();
const RESUMES = "jobsSessionResumesV1";
const profileKey = (key) => /^profile_\d+$/.test(key);
const privateKey = (key) =>
  key === RESUMES ||
  key === "jobsProfilesCache" ||
  key === "jobsProfilesList" ||
  key === "jobsManagementBaseV1" ||
  key === "jobsAnswerTasksV1" ||
  key === "jobsDiagnosticsV1" ||
  key === "jobsBrowserControlV1" ||
  key === "jobsDiagnosticSaltV2" ||
  /^(?:profile_|job_|jobsResponses:|jobsTabBinding:|jobsResponseTab:)/.test(
    key,
  );
/** @template T @param {()=>Promise<T>} action @returns {Promise<T>} */
function serial(action) {
  const task = queue.then(action);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
function assertCurrent(expected) {
  if (expected !== epoch) throw Error("连接已改变，请重新开始填写");
}
// Only attachment bytes are shared. Each tab keeps its own immutable Profile
// facts/version; changing a Profile cannot replace another tab's selected file.
async function prepareProfiles(values, removeKeys) {
  const entries = Object.entries(values).filter(([key]) => profileKey(key));
  if (!entries.length && !removeKeys.some(profileKey)) return values;
  const keys = (await chrome.storage.session.getKeys()).filter(profileKey);
  const saved = await chrome.storage.session.get([...keys, RESUMES]);
  const resumes = {
    .../** @type {Record<string,string>} */ (saved[RESUMES] || {}),
  };
  const update = { ...values };
  for (const [key, value] of entries) {
    const data = value?.profile?.resumeData;
    if (typeof data?.resumeBase64 !== "string" || !data.resumeBase64) continue;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(data.resumeBase64),
    );
    const ref = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    resumes[ref] = data.resumeBase64;
    const { resumeBase64, ...metadata } = data;
    update[key] = {
      ...value,
      resumeRef: ref,
      profile: { ...value.profile, resumeData: metadata },
    };
  }
  const bindings = { ...saved, ...update };
  for (const key of removeKeys) delete bindings[key];
  const used = new Set(
    Object.entries(bindings)
      .filter(([key]) => profileKey(key))
      .map(([, value]) => value?.resumeRef),
  );
  const retained = Object.fromEntries(
    Object.entries(resumes).filter(([ref]) => used.has(ref)),
  );
  if (
    Object.keys(retained).length !== Object.keys(saved[RESUMES] || {}).length ||
    Object.entries(retained).some(
      ([ref, data]) => saved[RESUMES]?.[ref] !== data,
    )
  )
    update[RESUMES] = retained;
  return update;
}
async function readTab(id) {
  // One storage read also captures the attachment before an opener can close.
  const key = "profile_" + id;
  const saved = await chrome.storage.session.get([
    key,
    "jobsTabBinding:" + id,
    RESUMES,
  ]);
  const value = /** @type {import('./tab-profiles').TabProfile | undefined} */ (
    saved[key]
  );
  if (value?.resumeRef) {
    const resumeBase64 = /** @type {Record<string,string>} */ (
      saved[RESUMES]
    )?.[value.resumeRef];
    if (typeof resumeBase64 !== "string")
      throw Error("本页简历缓存不可用，请重新开始填写");
    saved[key] = {
      ...value,
      profile: {
        ...value.profile,
        resumeData: { ...value.profile.resumeData, resumeBase64 },
      },
    };
  }
  delete saved[RESUMES];
  return saved;
}
async function storeValues(expected, values) {
  try {
    await chrome.storage.session.set(values);
  } catch (error) {
    if (!/quota.*exceed/i.test(String(error.message))) throw error;
    assertCurrent(expected);
    // Observations can be requested again. Never evict Profile bindings, pending
    // answers, command receipts, or the journal that prevents duplicate actions.
    const key = "jobsBrowserControlV1";
    const saved = await chrome.storage.session.get(key);
    const compact = (control) => ({
      ...control,
      frames: Object.fromEntries(
        Object.entries(control.frames || {}).map(([id, frame]) => {
          const { snapshot, ...identity } = frame;
          return [id, identity];
        }),
      ),
    });
    await chrome.storage.session.remove("jobsDiagnosticsV1");
    if (saved[key])
      await chrome.storage.session.set({ [key]: compact(saved[key]) });
    if (values[key]) values = { ...values, [key]: compact(values[key]) };
    assertCurrent(expected);
    await chrome.storage.session.set(values);
  }
}
export const JobsPrivateSession = Object.freeze({
  get epoch() {
    return epoch;
  },
  assertCurrent,
  readTab,
  commit(expected, values, removeKeys = []) {
    return serial(async () => {
      assertCurrent(expected);
      const prepared = await prepareProfiles(values, removeKeys);
      assertCurrent(expected);
      await storeValues(expected, prepared);
      if (removeKeys.length) await chrome.storage.session.remove(removeKeys);
      assertCurrent(expected);
    });
  },
  clear(check = undefined, retain = undefined) {
    epoch++;
    return serial(async () => {
      try {
        // Invalidate every frame before clearing storage, so its pending captures
        // cannot repopulate private caches after the connection has changed.
        if (chrome.tabs?.query) {
          const tabs = await chrome.tabs.query({}).catch(() => []);
          await Promise.allSettled(
            tabs
              .filter((tab) => Number.isInteger(tab.id))
              .map((tab) =>
                chrome.tabs.sendMessage(tab.id, {
                  type: "jobs:private-session-invalidated",
                }),
              ),
          );
        }
        await check?.();
        const retained = (await retain?.()) || {};
        const keys = await chrome.storage.session.getKeys();
        // Pending edits must survive a worker stop or a failed storage write.
        // Replace a narrowed BASE first; never delete retained keys to restore
        // them later, since the server may not have acknowledged those answers.
        if (Object.keys(retained).length)
          await chrome.storage.session.set(retained);
        await chrome.storage.session.remove(
          keys.filter(
            (key) => privateKey(key) && !Object.hasOwn(retained, key),
          ),
        );
      } finally {
        // Reads begun while pages were stopping still belonged to the old
        // connection, even if they observed the first epoch change.
        epoch++;
      }
    });
  },
});
