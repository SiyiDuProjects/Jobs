// Only redacted diagnostic runs enter this store. The index contains retention
// metadata; each immutable payload has its own key. Publish the index last so
// an interrupted write leaves either the old or new complete run readable.
export function createDiagnosticHistoryStore() {
  /** @typedef {import('./sync-types').HistoryState} HistoryState */
  /** @typedef {HistoryState['applications'][string]} Entry */
  /** @typedef {{version:2, applications:Record<string,{storageKey:string,bytes:number,summary:Omit<Entry,'data'> & {data:Omit<Entry['data'],'snapshots'|'events'>}}>, retentions?:HistoryState['retentions'], garbage?:string[], pendingAcks?:Record<string,number>}} Index */
  const KEY = "jobsDiagnosticHistoryV1",
    PREFIX = "jobsDiagnosticRunV2:";
  const contexts = new WeakMap();
  let swept = false;
  const bytes = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const full = (row) => Array.isArray(row?.data?.snapshots);
  /** @returns {Promise<HistoryState>} */
  async function read(only = undefined) {
    const saved = /** @type {HistoryState|Index|undefined} */ (
      (await chrome.storage.local.get(KEY))[KEY]
    );
    if (!swept && chrome.storage.local.getKeys) {
      try {
        const live = new Set(
          saved && "version" in saved
            ? Object.values(saved.applications).map((item) => item.storageKey)
            : [],
        );
        const orphaned = (await chrome.storage.local.getKeys()).filter(
          (key) => key.startsWith(PREFIX) && !live.has(key),
        );
        if (orphaned.length) await chrome.storage.local.remove(orphaned);
        swept = true;
      } catch {
        /* Cleanup can retry; referenced runs are never removed. */
      }
    }
    if (!saved || !("version" in saved) || saved.version !== 2) {
      const state = /** @type {HistoryState} */ (saved || { applications: {} });
      contexts.set(state, { index: null, originals: {} });
      return state;
    }
    // Old payload cleanup is retryable and never part of the data commit.
    if (saved.garbage?.length) {
      try {
        await chrome.storage.local.remove(saved.garbage);
        saved.garbage = [];
      } catch {}
    }
    const wanted = Object.entries(saved.applications).filter(
      ([key]) =>
        only === undefined ||
        key === only ||
        Object.hasOwn(saved.pendingAcks || {}, key),
    );
    const records = wanted.length
      ? await chrome.storage.local.get(
          wanted.map(([, item]) => item.storageKey),
        )
      : {};
    const state = /** @type {import('./sync-types').HistoryState} */ ({
      applications: Object.fromEntries(
        Object.entries(saved.applications).map(([key, item]) => [
          key,
          item.summary,
        ]),
      ),
      ...(saved.retentions ? { retentions: saved.retentions } : {}),
    });
    const originals = {};
    for (const [key, item] of wanted) {
      const record = /** @type {Entry} */ (records[item.storageKey]);
      if (!full(record))
        throw Error("诊断记录不完整，已停止覆盖，请保留本地数据");
      state.applications[key] = record;
      originals[key] = JSON.stringify(record);
      // An interrupted acknowledgement was never confirmed for its connection.
      // Load these runs even during a partial read so the next write persists
      // their restored acknowledgements before dropping the recovery marker.
      if (Object.hasOwn(saved.pendingAcks || {}, key))
        record.ack = Math.min(record.ack, saved.pendingAcks[key]);
    }
    contexts.set(state, { index: saved, originals });
    return state;
  }
  function size(state) {
    const { index } = contexts.get(state);
    return (
      bytes({ applications: {}, retentions: state.retentions }) +
      Object.entries(state.applications).reduce(
        (total, [key, row]) =>
          total +
          bytes(key) +
          2 +
          (full(row) ? bytes(row) : index.applications[key].bytes),
        0,
      )
    );
  }
  /** @param {{check:()=>void,pendingAcks:Record<string,number>}} [confirmation] */
  async function write(state, confirmation = undefined) {
    const { index: old, originals } = contexts.get(state);
    const index = {
      version: 2,
      applications: {},
      retentions: state.retentions || {},
      garbage: [...(old?.garbage || [])],
      ...(confirmation ? { pendingAcks: confirmation.pendingAcks } : {}),
    };
    const updates = {};
    for (const [key, row] of Object.entries(state.applications)) {
      const previous = old?.applications[key];
      if (previous && (!full(row) || JSON.stringify(row) === originals[key])) {
        index.applications[key] = previous;
        continue;
      }
      if (!full(row))
        throw Error("Cannot persist an incomplete diagnostic run");
      const storageKey = PREFIX + crypto.randomUUID();
      updates[storageKey] = row;
      const { snapshots, events, ...data } = row.data;
      const { signature, ...metadata } = row;
      index.applications[key] = {
        storageKey,
        bytes: bytes(row),
        summary: { ...metadata, data },
      };
      if (previous) index.garbage.push(previous.storageKey);
    }
    for (const [key, item] of Object.entries(old?.applications || {}))
      if (!state.applications[key]) index.garbage.push(item.storageKey);
    const keys = Object.keys(updates);
    let published = false;
    try {
      if (keys.length) await chrome.storage.local.set(updates);
      confirmation?.check();
      await chrome.storage.local.set({ [KEY]: index });
      published = true;
      if (confirmation) {
        // Checking only before set cannot detect a connection change while the
        // index write is in flight. Keep the old ack values durable until this
        // check confirms the write; a crash or failure leaves them recoverable.
        confirmation.check();
        const { pendingAcks, ...confirmed } = index;
        await chrome.storage.local.set({ [KEY]: confirmed });
      }
    } catch (error) {
      // Never remove old referenced data when publishing the new index fails.
      // Once published, its payloads also remain live during ack recovery.
      try {
        if (!published && keys.length) await chrome.storage.local.remove(keys);
      } catch {}
      throw error;
    }
    // A crash here leaves harmless old payloads, listed for cleanup on read.
    try {
      if (index.garbage.length)
        await chrome.storage.local.remove(index.garbage);
    } catch {}
  }
  return { read, write, size };
}
