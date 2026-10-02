import { failure, fingerprint, removePointer } from "./codec.js";
import { readEntry, currentSelectors } from "./inventory.js";
import { assertSession, assertBackup, assertPermit } from "./proofs.js";

export async function verifyInventory(storage, journal, cleaned) {
  const expected = journal.entries
    .filter(
      (entry) =>
        entry.storageArea === "local" &&
        entry.disposition !== "retain_identity" &&
        !cleaned.includes(entry.entryId) &&
        !journal.intents?.[entry.entryId],
    )
    .map((entry) => entry.selector);
  const observed = await currentSelectors(storage);
  const known = new Set(journal.entries.map((entry) => entry.selector));
  if (
    observed.some((selector) => !known.has(selector)) ||
    expected.some((selector) => !observed.includes(selector))
  )
    throw failure("migration_source_changed");
  for (const entry of journal.entries) {
    const current = await readEntry(storage, entry),
      intent = journal.intents?.[entry.entryId];
    if (!current.found) {
      if (
        cleaned.includes(entry.entryId) ||
        intent ||
        entry.storageArea === "session"
      )
        continue;
      throw failure("migration_source_changed");
    }
    if (
      cleaned.includes(entry.entryId) ||
      current.sha256 !== entry.sha256 ||
      current.size !== entry.size
    )
      throw failure("migration_source_changed");
    if (entry.pointer) {
      const actual = (await fingerprint(current.container)).sha256;
      const expectedHash =
        journal.containers?.[entry.storageKey] || entry.containerSha256;
      const pendingAfter = Object.values(journal.intents || {}).some(
        (item) =>
          item.storageKey === entry.storageKey && item.afterHash === actual,
      );
      if (actual !== expectedHash && !pendingAfter)
        throw failure("migration_source_changed");
    }
  }
}

// A step removes at most one source. Each reply ends a bounded worker action;
// closing the private page stops the sequence, and the durable intent resumes it.
export async function cleanupStep({
  storage,
  journal,
  request,
  save,
  quiesce,
}) {
  const session = assertSession(await request("", "GET"), journal);
  if (!["ready_to_clean", "cleaning", "complete"].includes(session.phase))
    throw failure("migration_required_input");
  assertBackup(session.backup || journal.backup, journal);
  await quiesce();
  await verifyInventory(storage, journal, session.cleaned);
  const entry = journal.entries.find(
    (item) =>
      item.disposition !== "retain_identity" &&
      !session.cleaned.includes(item.entryId),
  );
  if (!entry) {
    if ((await currentSelectors(storage)).length)
      throw failure("migration_source_changed");
    const completed = assertSession(
      await request("/complete", "POST", {
        manifestHash: journal.manifestHash,
        legacyRemaining: 0,
      }),
      journal,
    );
    if (completed.phase !== "complete")
      throw failure("migration_incomplete_backup");
    journal.phase = "complete";
    await save(journal);
    return completed;
  }
  let current = await readEntry(storage, entry),
    intent = journal.intents?.[entry.entryId];
  if (!current.found) {
    if (!intent && entry.storageArea === "session") {
      const permit = assertPermit(
        await request("/cleanup-claim", "POST", {
          entryId: entry.entryId,
          manifestHash: journal.manifestHash,
          sha256: entry.sha256,
          clientBuild: journal.clientBuild,
          observedState: "session_absent",
        }),
        journal,
        entry,
        undefined,
        "session_absent",
      );
      // This records observed Chrome session expiry, never a fabricated intent
      // to delete a source that was already absent before our action.
      intent = { permit, storageKey: entry.storageKey, observedAbsent: true };
      journal.intents ||= {};
      journal.intents[entry.entryId] = intent;
      await save(journal);
    }
    if (!intent) throw failure("migration_source_changed");
    if (
      entry.pointer &&
      (await fingerprint(current.container)).sha256 !== intent.afterHash
    )
      throw failure("migration_source_changed");
  } else {
    if (current.sha256 !== entry.sha256 || current.size !== entry.size)
      throw failure("migration_source_changed");
    const beforeHash = entry.pointer
      ? (await fingerprint(current.container)).sha256
      : undefined;
    const replacement = entry.pointer
      ? removePointer(current.container, entry.pointer)
      : undefined;
    const afterHash = entry.pointer
      ? (await fingerprint(replacement)).sha256
      : undefined;
    const permit = assertPermit(
      await request("/cleanup-claim", "POST", {
        entryId: entry.entryId,
        manifestHash: journal.manifestHash,
        sha256: entry.sha256,
        clientBuild: journal.clientBuild,
        observedState: "present",
        ...(beforeHash ? { containerBeforeSha256: beforeHash } : {}),
      }),
      journal,
      entry,
      beforeHash,
    );
    intent = {
      permit,
      storageKey: entry.storageKey,
      ...(beforeHash ? { beforeHash, afterHash } : {}),
    };
    journal.intents ||= {};
    journal.intents[entry.entryId] = intent;
    journal.phase = "cleaning";
    await save(journal);
    await quiesce();
    // A permit never substitutes for the last local compare before mutation.
    await verifyInventory(storage, journal, session.cleaned);
    current = await readEntry(storage, entry);
    if (
      !current.found ||
      current.sha256 !== entry.sha256 ||
      (entry.pointer &&
        (await fingerprint(current.container)).sha256 !== beforeHash)
    )
      throw failure("migration_source_changed");
    assertPermit(permit, journal, entry, beforeHash);
    if (entry.pointer)
      await storage[entry.storageArea].set({ [entry.storageKey]: replacement });
    else await storage[entry.storageArea].remove(entry.storageKey);
    const after = await readEntry(storage, entry);
    if (
      after.found ||
      (entry.pointer &&
        (await fingerprint(after.container)).sha256 !== afterHash)
    )
      throw failure("migration_source_changed");
  }
  if (entry.pointer) {
    journal.containers ||= {};
    journal.containers[entry.storageKey] = intent.afterHash;
  }
  // A missing session can reappear while the claim request is in flight. The
  // absence receipt must describe the current source, not a stale observation.
  await quiesce();
  await verifyInventory(storage, journal, session.cleaned);
  const observedAfter = await readEntry(storage, entry);
  if (
    observedAfter.found ||
    (entry.pointer &&
      (await fingerprint(observedAfter.container)).sha256 !== intent.afterHash)
  )
    throw failure("migration_source_changed");
  await save(journal);
  const acknowledged = assertSession(
    await request("/cleanup-ack", "POST", {
      entryId: entry.entryId,
      permitId: intent.permit.permitId,
      manifestHash: journal.manifestHash,
      result: intent.observedAbsent
        ? "session_expired"
        : entry.pointer
          ? "path_absent"
          : "absent",
      ...(entry.pointer ? { containerAfterSha256: intent.afterHash } : {}),
    }),
    journal,
  );
  if (!acknowledged.cleaned.includes(entry.entryId))
    throw failure("migration_ack_conflict");
  journal.cleaned = acknowledged.cleaned;
  await save(journal);
  return acknowledged;
}
