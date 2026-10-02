import { failure, shaPattern } from "./codec.js";
export function assertSession(value, journal) {
  if (
    !value ||
    value.migrationId !== journal.migrationId ||
    value.deviceId !== journal.deviceId ||
    value.manifestHash !== journal.manifestHash ||
    value.clientBuild !== journal.clientBuild
  )
    throw failure("migration_owner_mismatch");
  return value;
}
export function assertBackup(proof, journal) {
  if (
    !proof ||
    proof.migrationId !== journal.migrationId ||
    proof.deviceId !== journal.deviceId ||
    proof.manifestHash !== journal.manifestHash ||
    proof.durable !== true ||
    proof.restoreVerified !== true ||
    typeof proof.backupId !== "string" ||
    !proof.backupId ||
    !shaPattern.test(proof.serverManifestHash) ||
    !Array.isArray(proof.entries) ||
    !Array.isArray(proof.serverEntries)
  )
    throw failure("migration_restore_unverified");
  const source = journal.entries;
  if (
    proof.entries.length !== source.length ||
    new Set(proof.entries.map((row) => row.entryId)).size !== source.length
  )
    throw failure("migration_incomplete_backup");
  for (const entry of source) {
    const row = proof.entries.find((item) => item.entryId === entry.entryId);
    if (!row || row.sha256 !== entry.sha256 || row.size !== entry.size)
      throw failure("migration_incomplete_backup");
  }
  const seen = new Set();
  for (const entry of proof.serverEntries) {
    if (
      !["settings", "configList"].includes(entry.key) ||
      seen.has(entry.key) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !shaPattern.test(entry.sha256)
    )
      throw failure("migration_incomplete_backup");
    seen.add(entry.key);
  }
  return {
    backupId: proof.backupId,
    migrationId: proof.migrationId,
    deviceId: proof.deviceId,
    manifestHash: proof.manifestHash,
    serverManifestHash: proof.serverManifestHash,
    durable: true,
    restoreVerified: true,
    entries: proof.entries.map(({ entryId, size, sha256 }) => ({
      entryId,
      size,
      sha256,
    })),
    serverEntries: proof.serverEntries.map(
      ({ key, revision, size, sha256 }) => ({ key, revision, size, sha256 }),
    ),
  };
}
export function assertPermit(
  permit,
  journal,
  entry,
  beforeHash = undefined,
  observedState = "present",
) {
  assertSession(permit, journal);
  if (
    !permit.permitId ||
    permit.backupId !== journal.backup.backupId ||
    permit.entryId !== entry.entryId ||
    permit.selector !== entry.selector ||
    permit.sha256 !== entry.sha256 ||
    permit.disposition !== entry.disposition ||
    permit.observedState !== observedState ||
    (entry.pointer && permit.containerBeforeSha256 !== beforeHash)
  )
    throw failure("migration_permit_invalid");
  if (!Number.isFinite(permit.expiresAt) || permit.expiresAt <= Date.now())
    throw failure("migration_permit_expired");
  return {
    permitId: permit.permitId,
    migrationId: permit.migrationId,
    deviceId: permit.deviceId,
    manifestHash: permit.manifestHash,
    clientBuild: permit.clientBuild,
    backupId: permit.backupId,
    entryId: permit.entryId,
    selector: permit.selector,
    sha256: permit.sha256,
    disposition: permit.disposition,
    observedState: permit.observedState,
    expiresAt: permit.expiresAt,
    ...(entry.pointer
      ? { containerBeforeSha256: permit.containerBeforeSha256 }
      : {}),
  };
}
