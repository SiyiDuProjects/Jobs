import { JobsPrivateSession } from "./private-session.js";
import { JobsStorageUpgrade } from "./storage-upgrade.js";
import { JobsManagementModel } from "./management-model.js";
import { JobsResponseContract } from "./response-contract.js";
import { JobsSync } from "./sync.js";
import { JobsDocumentStore } from "./document-store.js";
import { JobsResponseScope } from "./response-scope.js";
export var JobsManagementSync;
let initialized = false;
export function initializeManagementSync() {
  if (initialized) return;
  initialized = true;
  (() => {
    const BASE = "jobsManagementBaseV1",
      STATUS = "jobsManagementStatus";
    let running,
      timer,
      applying = false,
      fetchingProfiles;
    const model = JobsManagementModel;
    const responses = JobsResponseContract;
    const responseKey = (key) => key.startsWith("jobsResponses:");
    const usable = (values) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          responseKey(key) ? responses.readList(value).data : value,
        ]),
      );
    const usableDocuments = (docs) =>
      Object.fromEntries(
        Object.entries(docs).map(([key, doc]) => [
          key,
          responseKey(key)
            ? { ...doc, value: responses.readList(doc.value).data }
            : doc,
        ]),
      );
    const rejected = (raw) =>
      responses
        .readList(raw ?? [])
        .rejected.filter((item) => item.index >= 0)
        .map((item) => raw[item.index]);
    function remoteAfterDeletes(base, local, remote) {
      const remaining = rejected(remote);
      if (!Array.isArray(local) || !Array.isArray(base)) return remaining;
      const current = rejected(local);
      for (const row of rejected(base)) {
        const kept = current.findIndex((value) => model.same(value, row));
        if (kept >= 0) current.splice(kept, 1);
        else {
          const deleted = remaining.findIndex((value) =>
            model.same(value, row),
          );
          if (deleted >= 0) remaining.splice(deleted, 1);
        }
      }
      return remaining;
    }
    function retainDamaged(local, remote, valid) {
      const kept = rejected(local ?? []);
      for (const row of rejected(remote ?? []))
        if (!kept.some((old) => model.same(old, row))) kept.push(row);
      return responses.preserveRejected(kept, valid);
    }
    const state = async (value) =>
      chrome.storage.local.set({ [STATUS]: { ...value, at: Date.now() } });
    async function loadProfiles(epoch) {
      await JobsStorageUpgrade.assertReady();
      const list = await JobsSync.profileRequest({
        path: "/api/extension/profiles",
        method: "GET",
      });
      JobsPrivateSession.assertCurrent(epoch);
      // Only identity/version metadata is prefetched. Full facts are fetched for
      // the chosen tab and disappear when that binding is released.
      await JobsPrivateSession.commit(epoch, { jobsProfilesList: list });
      await chrome.storage.session.remove("jobsProfilesCache");
      return list;
    }
    let fetchingEpoch;
    function profiles() {
      const epoch = JobsPrivateSession.epoch;
      if (!fetchingProfiles || fetchingEpoch !== epoch) {
        fetchingEpoch = epoch;
        const task = loadProfiles(epoch).finally(() => {
          if (fetchingProfiles === task) fetchingProfiles = undefined;
        });
        fetchingProfiles = task;
      }
      return fetchingProfiles;
    }
    async function run() {
      const epoch = JobsPrivateSession.epoch;
      await JobsSync.ready;
      await JobsResponseScope.ready;
      const list = await profiles();
      // Resolving a question from Profile is not proof that an existing response
      // is redundant or safe to delete. Keep routine synchronization lossless;
      // any future cleanup needs its own reviewed, versioned migration.
      let local = await JobsDocumentStore.read();
      const rawLocal = local;
      local = usable(local);
      const rawRemote = await JobsSync.managementRequest("GET");
      JobsPrivateSession.assertCurrent(epoch);
      const remote = usableDocuments(rawRemote);
      const base = usableDocuments(local[BASE] || {}),
        changes = [];
      for (const k of new Set([
        ...Object.keys(local).filter(model.allowed),
        ...Object.keys(remote),
      ])) {
        if (!model.allowed(k)) continue;
        if (
          responseKey(k) &&
          rawLocal[k] !== undefined &&
          !Array.isArray(rawLocal[k])
        )
          continue;
        const value = model.merge(
          k,
          base[k]?.value,
          local[k],
          remote[k]?.value,
        );
        if (value === undefined) continue;
        const retained = responseKey(k)
          ? remoteAfterDeletes(
              rawLocal[BASE]?.[k]?.value,
              rawLocal[k],
              rawRemote[k]?.value,
            )
          : [];
        const removedDamage =
          responseKey(k) &&
          !model.same(retained, rejected(rawRemote[k]?.value));
        if (!model.same(value, remote[k]?.value) || removedDamage)
          changes.push({
            key: k,
            value: responseKey(k)
              ? responses.preserveRejected(retained, value)
              : value,
            revision: remote[k]?.revision || 0,
          });
      }
      const rawAck = changes.length
        ? await JobsSync.managementRequest("POST", { changes })
        : rawRemote;
      JobsPrivateSession.assertCurrent(epoch);
      const ack = usableDocuments(rawAck);
      let newer = false,
        hydratedProfiles = [];
      await JobsDocumentStore.commit(async (current) => {
        JobsPrivateSession.assertCurrent(epoch);
        const active = await JobsDocumentStore.activeProfileIds();
        hydratedProfiles = [...active];
        const updates = { [BASE]: { ...rawAck } };
        for (const k of new Set([
          ...Object.keys(current).filter(model.allowed),
          ...Object.keys(ack),
        ])) {
          if (!model.allowed(k)) continue;
          if (
            responseKey(k) &&
            !active.has(k.slice("jobsResponses:".length)) &&
            current[k] === undefined
          ) {
            delete updates[BASE][k];
            continue;
          }
          if (
            responseKey(k) &&
            current[k] !== undefined &&
            !Array.isArray(current[k])
          )
            continue;
          // The server returns a fresh full snapshot, including other website
          // changes made during our upload. Rebase edits learned during that
          // upload onto this acknowledged snapshot before advancing the baseline.
          // Keeping just the newer local array would turn missing remote additions
          // into deletions on the next exchange.
          const value = model.merge(
            k,
            local[k],
            responseKey(k)
              ? responses.readList(current[k] ?? []).data
              : current[k],
            ack[k]?.value,
          );
          if (value === undefined) continue;
          const stored = responseKey(k)
            ? retainDamaged(
                current[k],
                remoteAfterDeletes(rawLocal[k], current[k], rawAck[k]?.value),
                value,
              )
            : value;
          if (!model.same(stored, current[k])) updates[k] = stored;
          if (
            !model.same(value, ack[k]?.value) ||
            (responseKey(k) &&
              !model.same(rejected(stored), rejected(rawAck[k]?.value)) &&
              rejected(rawLocal[k]).length > rejected(current[k]).length)
          )
            newer = true;
        }
        return updates;
      });
      const invalidResponses = Object.entries(rawLocal)
        .filter(([key]) => responseKey(key))
        .reduce(
          (n, [, value]) => n + responses.readList(value).invalidCount,
          0,
        );
      await state({
        state: newer ? "pending" : "synced",
        invalidResponses,
        message:
          (newer ? "有新修改等待同步" : "投递记录、回答和设置已同步") +
          (invalidResponses
            ? "；" + invalidResponses + " 条格式有误的回答已保留在本地，未上传"
            : ""),
      });
      await JobsDocumentStore.pruneResponses();
      if (newer) schedule();
      return { ok: true, pending: newer, invalidResponses, hydratedProfiles };
    }
    function sync() {
      if (!running)
        running = run()
          .catch(async (error) => {
            await state({ state: "error", message: error.message });
            return { ok: false, error: error.message };
          })
          .finally(() => {
            running = undefined;
          });
      return running;
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void sync();
      }, 1500);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        ["local", "session"].includes(area) &&
        !applying &&
        Object.entries(changes).some(
          ([key, change]) =>
            model.allowed(key) &&
            !(responseKey(key) && change.newValue === undefined),
        )
      )
        schedule();
    });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === "jobs-sync") void sync();
    });
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg?.type !== "jobs:management-sync") return;
      if (sender.id !== chrome.runtime.id) {
        reply({ error: "Invalid caller" });
        return;
      }
      sync().then(reply);
      return true;
    });
    async function release() {
      await JobsDocumentStore.pruneResponses();
      // Failure leaves unacknowledged edits in session for the next retry.
      void sync();
    }
    async function assertNoPendingResponses() {
      if (await JobsDocumentStore.hasPendingResponses()) {
        const message =
          "有个人回答尚未同步，已保留草稿；请恢复连接并完成同步后再断开或更换连接";
        throw Object.assign(Error(message), { connectionMessage: message });
      }
    }
    async function prepareConnectionChange() {
      if (await JobsDocumentStore.hasPendingResponses()) await sync();
      await assertNoPendingResponses();
    }
    async function forProfile(id) {
      const result = await sync();
      if (!result.ok || result.hydratedProfiles.includes(id)) return result;
      // A binding can appear after an already-running sync selected its active
      // scopes. That run cannot prove this new tab has its saved answers yet.
      return sync();
    }
    JobsManagementSync = {
      sync,
      profiles,
      forProfile,
      release,
      prepareConnectionChange,
      assertNoPendingResponses,
      pendingSnapshot: JobsDocumentStore.pendingSnapshot,
    };
  })();
}
