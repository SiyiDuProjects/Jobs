// Read-only installation boundary. Profile/answer legacy values are not read.
// Mixed settings receive a bounded presence check for retired personal context.
import { JobsStorageMigrationPolicy } from "./storage-migration-policy.js";
import { contextPointers } from "./migration-context-fields.js";
import { MIGRATION_JOURNAL } from "./migration-maintenance.js";
const legacy = new Map([
  ["profile", "profile"],
  ["jobsProfilesCache", "profile"],
  ["jobsProfileBeforeMigration", "profile_backup"],
  ["jobsProfilePending", "profile_pending"],
  ["responseList", "answers"],
  ["jobsResponsesLegacyBackup", "answers_backup"],
  ["jobsManagementBaseV1", "merge_baseline"],
  ["jobsManagementBeforeMigrationV1", "management_backup"],
  ["jobsTabProfileRecoveryV1", "legacy_recovery"],
  ["appliedList", "legacy_applications"],
]);
export function legacyStorageKind(key) {
  return (
    legacy.get(key) ||
    (/^jobsResponses:(?:[a-f0-9-]{36}|local-default)$/i.test(key)
      ? "answers"
      : null)
  );
}
const message =
  "旧版插件的本地资料尚未完成受控迁移，自动填写已暂停。请先完成服务器备份和差异核对；未核验的资料不会被清理。";
let revision = 0,
  cached,
  latest,
  checking;
function invalidate(changes, area) {
  if (
    area === "local" &&
    Object.keys(changes).some(
      (key) =>
        legacyStorageKind(key) ||
        ["settings", "configList", MIGRATION_JOURNAL].includes(key),
    )
  ) {
    revision++;
    cached = null;
    void inspect();
  }
}
async function inspect() {
  if (cached) return cached;
  if (checking) return checking;
  checking = (async () => {
    // Every waiter shares the same validated result. A legacy write arriving
    // during enumeration invalidates the whole pass, including concurrent callers.
    while (true) {
      const current = revision;
      let state;
      try {
        const storage = chrome.storage.local;
        if (
          typeof storage.getKeys !== "function" ||
          typeof storage.getBytesInUse !== "function"
        )
          throw Error(
            "浏览器无法安全检查旧缓存，请更新 Chrome 后重试；自动填写已暂停。",
          );
        const allKeys = await storage.getKeys();
        const keys = allKeys.filter((key) => legacyStorageKind(key)).sort();
        const entries = await Promise.all(
          keys.map(async (key) => ({
            key,
            kind: legacyStorageKind(key),
            bytes: await storage.getBytesInUse(key),
          })),
        );
        for (const key of ["settings", "configList"]) {
          if (!allKeys.includes(key)) continue;
          const bytes = await storage.getBytesInUse(key);
          if (bytes > JobsStorageMigrationPolicy.limits.maxEntryBytes)
            throw Error(
              "旧设置超出安全检查范围，自动填写已暂停；原数据保持不变",
            );
          const value = (await storage.get(key))[key];
          for (const pointer of contextPointers(key, value))
            entries.push({
              key: key + "#" + pointer,
              kind: "response_context",
              bytes,
            });
        }
        if (
          allKeys.includes(MIGRATION_JOURNAL) &&
          (await storage.getBytesInUse(MIGRATION_JOURNAL)) > 4 * 1024 * 1024
        )
          throw Error("迁移记录超出安全检查范围，自动填写已暂停");
        const journal = allKeys.includes(MIGRATION_JOURNAL)
          ? (await storage.get(MIGRATION_JOURNAL))[MIGRATION_JOURNAL]
          : null;
        const activeMigration =
          journal &&
          (typeof journal !== "object" ||
            !("phase" in journal) ||
            journal.phase !== "complete");
        state = {
          schemaVersion: 1,
          state:
            entries.length || activeMigration ? "needs_migration" : "ready",
          entries,
          message: entries.length || activeMigration ? message : "",
        };
      } catch (error) {
        state = {
          schemaVersion: 1,
          state: "unavailable",
          entries: [],
          message: error.message || "无法检查旧缓存，自动填写已暂停。",
        };
      }
      if (current !== revision) continue;
      latest = state;
      if (state.state !== "unavailable") cached = state;
      return state;
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}
export const JobsStorageUpgrade = Object.freeze({
  inspect,
  refresh() {
    cached = null;
    revision++;
    return inspect();
  },
  peek: () => latest,
  async assertReady() {
    const state = await inspect();
    if (state.state !== "ready")
      throw Object.assign(Error(state.message), {
        code: "storage_upgrade_required",
      });
  },
});
let initialized = false;
export function initializeStorageUpgrade() {
  if (initialized) return;
  initialized = true;
  chrome.storage.onChanged.addListener(invalidate);
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (request?.type !== "jobs:storage-upgrade-status") return;
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    ) {
      reply({ error: "Private extension page required" });
      return;
    }
    inspect().then((data) => reply({ data }));
    return true;
  });
  void inspect();
}
