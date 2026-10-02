import { MIGRATION_JOURNAL } from "../../src/custom/migration-maintenance.js";
import { failure, hashText, uuidPattern, shaPattern } from "./codec.js";
export function createJournal(storage, build) {
  return {
    async read() {
      if ((await storage.getBytesInUse(MIGRATION_JOURNAL)) > 4 * 1024 * 1024)
        throw failure("migration_limit");
      const value = (await storage.get(MIGRATION_JOURNAL))[MIGRATION_JOURNAL];
      if (!value) return null;
      if (
        value.version !== 1 ||
        !uuidPattern.test(value.migrationId) ||
        typeof value.phase !== "string"
      )
        throw failure(
          "migration_invalid_source",
          "迁移恢复记录无效，原资料保持不变",
        );
      // A new build may inspect metadata and explicitly supersede a paused
      // session. Only the worker's current-build guard can authorize mutation.
      if (typeof value.clientBuild !== "string" || !value.clientBuild)
        throw failure("migration_invalid_source");
      if (value.manifestText) {
        if (
          !shaPattern.test(value.manifestHash) ||
          (await hashText(value.manifestText)) !== value.manifestHash
        )
          throw failure("migration_manifest_conflict");
        const parsed = JSON.parse(value.manifestText);
        // Chrome storage reorders object members. The manifest text itself is
        // the exact-byte authority; compare redundant metadata structurally,
        // never by the incidental property order returned from storage.
        const metadata = (entries) =>
          JSON.stringify(
            entries?.map((entry) =>
              Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
            ),
          );
        if (
          parsed.migrationId !== value.migrationId ||
          parsed.clientBuild !== value.clientBuild ||
          metadata(parsed.entries) !== metadata(value.entries)
        )
          throw failure("migration_manifest_conflict");
        value.entries = parsed.entries;
      }
      return value;
    },
    async save(value) {
      // Constructed by the worker only: selectors, hashes, IDs, phases and
      // permission receipts. Never include plans, values or error payloads.
      await storage.set({ [MIGRATION_JOURNAL]: value });
    },
  };
}
