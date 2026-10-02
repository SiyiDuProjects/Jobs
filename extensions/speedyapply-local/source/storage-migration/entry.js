import { JobsBuildInfo } from "../../src/custom/build-info.js";
import { JobsSync } from "../../src/custom/sync.js";
import { JobsPrivateSession } from "../../src/custom/private-session.js";
import { JobsManagementSync } from "../../src/custom/management-sync.js";
import { JobsMigrationMaintenance } from "../../src/custom/migration-maintenance.js";
import { JobsStorageUpgrade } from "../../src/custom/storage-upgrade.js";
let loading;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "jobs:storage-migration") return;
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("migration.html") ||
    sender.frameId !== 0 ||
    !sender.tab?.id ||
    message.build !== JobsBuildInfo.id
  ) {
    reply({
      error: "请使用当前版本的 jobs 资料迁移页面",
      code: "migration_writer_active",
    });
    return;
  }
  loading ||= Promise.all([
    import("./worker.js"),
    import("./contexts.js"),
  ]).then(([{ createMigration }, { quiesce }]) =>
    createMigration({
      storage: chrome.storage,
      build: JobsBuildInfo.id,
      identity: () => JobsSync.migrationIdentity(),
      remote: (path, method, body) =>
        JobsSync.migrationRequest(path, method, body),
      maintenance: JobsMigrationMaintenance,
      stopPages: () =>
        JobsPrivateSession.clear(undefined, JobsManagementSync.pendingSnapshot),
      pendingSnapshot: () => JobsManagementSync.pendingSnapshot(),
      quiesce: (source) => quiesce(chrome, source),
    }),
  );
  loading
    .then((migration) =>
      migration.handle(message.action, sender, message.input),
    )
    .then(
      async (data) => {
        if (data.status?.phase === "complete")
          await JobsStorageUpgrade.refresh();
        reply({ data });
      },
      (error) =>
        reply({
          error: error.code
            ? error.message
            : "迁移暂时未能完成，请检查连接后继续；不会清理未经核验的资料",
          code: error.code || "migration_offline",
        }),
    );
  return true;
});
