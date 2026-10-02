import { JobsPrivateSession } from "./private-session.js";
import { JobsManagementModel } from "./management-model.js";
import { JobsResponseContract } from "./response-contract.js";
import { JobsMigrationMaintenance } from "./migration-maintenance.js";
export var JobsDocumentStore;
let initialized = false;
export function initializeDocumentStore() {
  if (initialized) return;
  initialized = true;
  (() => {
    let queue = Promise.resolve();
    const ephemeral = (key) =>
      key.startsWith("jobsResponses:") || key === "jobsManagementBaseV1";
    const durableKeys = ["settings", "jobsKindProfiles"];
    async function readResponses() {
      const keys = (await chrome.storage.session.getKeys()).filter(ephemeral);
      return keys.length ? chrome.storage.session.get(keys) : {};
    }
    async function read() {
      // Upgrading an installed extension does not erase its old local values.
      // Routine synchronization must never load retired Profile/answer backups.
      const local = await chrome.storage.local.get(durableKeys);
      const session =
        /** @type {Record<string,{id?:string,profile?:unknown}>} */ (
          await readResponses()
        );
      return {
        ...Object.fromEntries(
          durableKeys
            .filter((key) => local[key] !== undefined)
            .map((key) => [key, local[key]]),
        ),
        ...Object.fromEntries(
          Object.entries(session).filter(([key]) => ephemeral(key)),
        ),
      };
    }
    function commit(change) {
      const epoch = JobsPrivateSession.epoch;
      const task = queue.then(() =>
        JobsMigrationMaintenance.write(async () => {
          JobsPrivateSession.assertCurrent(epoch);
          const current = await read();
          const update = await change(current);
          JobsPrivateSession.assertCurrent(epoch);
          if (update && Object.keys(update).length) {
            const durable = Object.fromEntries(
              Object.entries(update).filter(([key]) => !ephemeral(key)),
            );
            const transient = Object.fromEntries(
              Object.entries(update).filter(([key]) => ephemeral(key)),
            );
            if (Object.keys(durable).length)
              await chrome.storage.local.set(durable);
            if (Object.keys(transient).length)
              await JobsPrivateSession.commit(epoch, transient);
          }
          return update;
        }),
      );
      queue = task.catch(() => {});
      return task;
    }
    async function activeProfileIds() {
      const session =
        /** @type {Record<string,{id?:string,profile?:unknown}>} */ (
          await chrome.storage.session.get(null)
        );
      return new Set(
        Object.entries(session)
          .filter(([key, value]) => /^profile_\d+$/.test(key) && value?.profile)
          .map(([, value]) => value.id),
      );
    }
    function confirmed(value, baseline) {
      const normalize = (raw) => {
        if (!Array.isArray(raw)) return raw;
        const parsed = JobsResponseContract.readList(raw);
        return {
          data: parsed.data,
          rejected: parsed.rejected.map((item) => raw[item.index]),
        };
      };
      return JobsManagementModel.same(normalize(value), normalize(baseline));
    }
    function pruneResponses() {
      const epoch = JobsPrivateSession.epoch;
      const task = queue
        .then(() =>
          JobsMigrationMaintenance.write(async () => {
            JobsPrivateSession.assertCurrent(epoch);
            const current = await read();
            const active = await activeProfileIds();
            const base = {
              .../** @type {Record<string,{value?:unknown,revision?:number}>} */ (
                current.jobsManagementBaseV1 || {}
              ),
            };
            const remove = [];
            for (const key of new Set([
              ...Object.keys(current),
              ...Object.keys(base),
            ])) {
              if (
                !key.startsWith("jobsResponses:") ||
                active.has(key.slice("jobsResponses:".length))
              )
                continue;
              // A page closing is not permission to discard its pending edits. The
              // acknowledged baseline proves which exact value reached the server.
              if (
                current[key] !== undefined &&
                !confirmed(current[key], base[key]?.value)
              )
                continue;
              if (current[key] !== undefined) remove.push(key);
              delete base[key];
            }
            await JobsPrivateSession.commit(
              epoch,
              { jobsManagementBaseV1: base },
              remove,
            );
          }),
        )
        .catch((error) => {
          if (error.code !== "migration_in_progress") throw error;
        });
      queue = task.catch(() => {});
      return task;
    }
    async function hasPendingResponses() {
      const current = await read();
      return Object.keys(current).some(
        (key) =>
          key.startsWith("jobsResponses:") &&
          !confirmed(current[key], current.jobsManagementBaseV1?.[key]?.value),
      );
    }
    async function pendingSnapshot() {
      const current = await readResponses();
      const baseline =
        /** @type {Record<string,{value?:unknown,revision?:number}>} */ (
          current.jobsManagementBaseV1 || {}
        );
      const pending = {},
        base = {};
      for (const key of Object.keys(current)) {
        if (
          !key.startsWith("jobsResponses:") ||
          confirmed(current[key], baseline[key]?.value)
        )
          continue;
        pending[key] = current[key];
        if (baseline[key]) base[key] = baseline[key];
      }
      if (Object.keys(pending).length) pending.jobsManagementBaseV1 = base;
      return pending;
    }
    JobsDocumentStore = Object.freeze({
      commit,
      read,
      pruneResponses,
      hasPendingResponses,
      activeProfileIds,
      pendingSnapshot,
    });
    chrome.runtime?.onMessage?.addListener((m, sender, reply) => {
      if (m?.type !== "jobs:responses-edit") return;
      const key = m.key;
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        !/^jobsResponses:[a-f0-9-]{36}$/i.test(key) ||
        !Array.isArray(m.base) ||
        !Array.isArray(m.value)
      ) {
        reply({ error: "Invalid document editor" });
        return;
      }
      commit((current) => {
        const contract = JobsResponseContract;
        const raw = current[key] ?? [];
        const incoming = contract.parseList(m.value);
        const next = JobsManagementModel.merge(
          key,
          contract.readList(m.base).data,
          incoming,
          contract.readList(raw).data,
        );
        return {
          [key]:
            m.replaceRejected === true
              ? next
              : contract.preserveRejected(raw, next),
        };
      }).then(
        () => reply({ ok: true }),
        (error) => reply({ error: error.message }),
      );
      return true;
    });
  })();
}
