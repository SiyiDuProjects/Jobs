// One-time explicit migration workflow. This module is never initialized by
// normal autofill and never retries migration work from an alarm/startup event.
import { JobsStorageMigrationPolicy as policy } from "../../src/custom/storage-migration-policy.js";
import { createJournal } from "./journal.js";
import { captureInventory, readEntry, currentSelectors } from "./inventory.js";
import { failure, hashText } from "./codec.js";
import { assertSession, assertBackup } from "./proofs.js";
import { cleanupStep } from "./cleanup.js";

export function createMigration(dependencies) {
  const {
    storage,
    build,
    identity,
    remote,
    maintenance,
    stopPages,
    pendingSnapshot,
    quiesce,
  } = dependencies;
  const journalStore = createJournal(storage.local, build);
  let queue = Promise.resolve();
  const api = (journal, suffix = "", method = "GET", body = undefined) =>
    remote(policy.prefix + "/" + journal.migrationId + suffix, method, body);
  async function current(allowBuildChange = false) {
    const journal = await journalStore.read();
    if (!journal)
      throw failure("migration_invalid_source", "请先开始备份并核对旧资料");
    if ((await identity()).deviceId !== journal.deviceId)
      throw failure("migration_owner_mismatch");
    if (!allowBuildChange && journal.clientBuild !== build)
      throw failure(
        "migration_source_changed",
        "插件版本已改变，请保留原备份并重新核对来源",
      );
    return journal;
  }
  async function prepare(sender) {
    await maintenance.freeze();
    await quiesce(sender);
  }
  async function plan(journal) {
    const value = await api(journal, "/plan");
    if (
      value.migrationId !== journal.migrationId ||
      value.manifestHash !== journal.manifestHash ||
      !Number.isSafeInteger(value.revision)
    )
      throw failure("migration_plan_stale");
    // The private page alone receives these diffs. Never save them to local.
    return value;
  }
  async function status() {
    const journal = await journalStore.read();
    if (!journal) return { phase: "not_started" };
    // Completion belongs to its exact inventory. If an old writer later
    // recreates a local legacy key, expose a new explicit migration entry.
    if (
      journal.phase === "complete" &&
      (await currentSelectors(storage)).some(
        (selector) => !selector.startsWith("session:"),
      )
    )
      return { phase: "not_started", previousMigrationId: journal.migrationId };
    return {
      phase: journal.phase,
      migrationId: journal.migrationId,
      entries: journal.entries?.length || 0,
      cleaned: journal.cleaned?.length || 0,
      backupVerified: journal.backup?.restoreVerified === true,
      buildChanged: journal.clientBuild !== build,
    };
  }
  async function start(sender) {
    let journal = await journalStore.read();
    await maintenance.freeze();
    const device = await identity();
    if (
      journal &&
      journal.phase !== "complete" &&
      journal.deviceId !== device.deviceId
    )
      throw failure("migration_owner_mismatch");
    if (
      journal &&
      journal.phase !== "complete" &&
      journal.clientBuild !== build
    )
      throw failure(
        "migration_source_changed",
        "插件版本已改变，请保留原备份并重新核对来源",
      );
    if (!journal || journal.phase === "complete") {
      journal = {
        version: 1,
        migrationId: crypto.randomUUID(),
        clientBuild: build,
        deviceId: device.deviceId,
        phase: "maintenance",
        intents: {},
        containers: {},
        cleaned: [],
      };
      await journalStore.save(journal);
    }
    await quiesce(sender);
    // Release confirmed private caches, retaining precisely the current pending
    // responses. The following capture compares that subset with actual storage.
    if (!journal.manifestText) {
      await stopPages();
      const entries = await captureInventory(storage, await pendingSnapshot());
      const manifestText = JSON.stringify({
        version: policy.version,
        migrationId: journal.migrationId,
        clientBuild: build,
        inventoryVersion: policy.version,
        entries,
      });
      if (
        new TextEncoder().encode(manifestText).length >
        policy.limits.maxManifestBytes
      )
        throw failure("migration_limit");
      journal = {
        ...journal,
        entries,
        manifestText,
        manifestHash: await hashText(manifestText),
        phase: "receiving",
      };
      await journalStore.save(journal);
    }
    return upload(sender, journal);
  }
  async function upload(sender, initial = undefined) {
    const journal = initial || (await current());
    await prepare(sender);
    if (!journal.manifestText) return start(sender);
    const session = assertSession(
      await remote(policy.prefix, "POST", {
        protocolVersion: policy.version,
        manifestText: journal.manifestText,
        manifestHash: journal.manifestHash,
      }),
      journal,
    );
    if (session.phase !== "receiving") {
      // A lost reply may leave only some operations applied. Resume the same
      // server-owned idempotent plan before checking domain completion.
      if (session.phase === "applying")
        return apply(sender, { planRevision: session.planRevision });
      journal.backup = assertBackup(session.backup, journal);
      journal.phase = session.phase;
      journal.cleaned = session.cleaned;
      await journalStore.save(journal);
      if (session.phase === "complete") await maintenance.finish();
      return {
        status: await status(),
        ...(["backed_up", "required_input", "ready_to_apply"].includes(
          session.phase,
        )
          ? { plan: await plan(journal) }
          : {}),
      };
    }
    // One source at a time: an 8 MiB item is not multiplied by an unbounded
    // parallel read/upload. Values leave memory when its iteration completes.
    for (const entry of journal.entries) {
      if (session.uploaded.includes(entry.entryId)) continue;
      await quiesce(sender);
      const value = await readEntry(storage, entry);
      if (
        !value.found ||
        value.sha256 !== entry.sha256 ||
        value.size !== entry.size
      )
        throw failure(
          "migration_source_changed",
          "待保存的原资料已变化或缺失，请核对；本次不会清理其他资料",
        );
      const ack = await api(journal, "/entries/" + entry.entryId, "PUT", {
        jsonText: value.jsonText,
        size: value.size,
        sha256: value.sha256,
      });
      if (
        ack.migrationId !== journal.migrationId ||
        ack.entryId !== entry.entryId ||
        ack.sha256 !== entry.sha256 ||
        ack.size !== entry.size ||
        ack.stored !== true
      )
        throw failure("migration_incomplete_backup");
    }
    const sealed = assertSession(
      await api(journal, "/seal", "POST", {
        manifestHash: journal.manifestHash,
      }),
      journal,
    );
    journal.backup = assertBackup(sealed.backup, journal);
    journal.phase = sealed.phase;
    await journalStore.save(journal);
    return { status: await status(), plan: await plan(journal) };
  }
  async function resolve(sender, input) {
    const journal = await current();
    await prepare(sender);
    if (
      !Number.isSafeInteger(input.planRevision) ||
      typeof input.conflictId !== "string" ||
      typeof input.choiceId !== "string"
    )
      throw failure("migration_plan_stale");
    const result = await api(journal, "/resolve", "POST", {
      planRevision: input.planRevision,
      conflictId: input.conflictId,
      choiceId: input.choiceId,
      ...(input.previewId ? { previewId: input.previewId } : {}),
    });
    if (
      result.migrationId !== journal.migrationId ||
      result.manifestHash !== journal.manifestHash
    )
      throw failure("migration_plan_stale");
    journal.phase = result.phase;
    await journalStore.save(journal);
    return { status: await status(), plan: result };
  }
  async function preview(sender, input) {
    const journal = await current();
    await prepare(sender);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.conflictId) ||
      !/^[A-Za-z0-9_:-]{1,128}$/.test(input.choiceId) ||
      (input.cursor !== undefined &&
        !/^[A-Za-z0-9_-]{1,256}$/.test(input.cursor))
    )
      throw failure("migration_plan_stale");
    const value = await api(
      journal,
      "/conflicts/" +
        input.conflictId +
        "/preview?choiceId=" +
        encodeURIComponent(input.choiceId) +
        (input.cursor !== undefined ? "&cursor=" + input.cursor : ""),
    );
    if (
      value.planRevision !== input.planRevision ||
      value.conflictId !== input.conflictId ||
      value.choiceId !== input.choiceId ||
      !Array.isArray(value.rows) ||
      value.rows.length > policy.limits.maxPreviewPageRows ||
      new TextEncoder().encode(JSON.stringify(value)).length >
        policy.limits.maxPreviewPageBytes ||
      typeof value.complete !== "boolean" ||
      (value.complete && !value.previewId)
    )
      throw failure("migration_plan_stale");
    return { preview: value };
  }
  async function apply(sender, input) {
    const journal = await current();
    await prepare(sender);
    if (!Number.isSafeInteger(input.planRevision))
      throw failure("migration_plan_stale");
    const result = assertSession(
      await api(journal, "/apply", "POST", {
        planRevision: input.planRevision,
        manifestHash: journal.manifestHash,
      }),
      journal,
    );
    if (result.phase === "required_input") {
      journal.phase = result.phase;
      await journalStore.save(journal);
      return { status: await status(), plan: await plan(journal) };
    }
    return verify(journal);
  }
  async function verify(journal) {
    const verified = assertSession(
      await api(journal, "/verify", "POST", {
        manifestHash: journal.manifestHash,
      }),
      journal,
    );
    journal.backup = assertBackup(verified.backup, journal);
    journal.phase = verified.phase;
    await journalStore.save(journal);
    return {
      status: await status(),
      ...(verified.phase === "required_input"
        ? { plan: await plan(journal) }
        : {}),
    };
  }
  async function cleanup(sender) {
    const journal = await current();
    await prepare(sender);
    const result = await cleanupStep({
      storage,
      journal,
      save: journalStore.save,
      request: (suffix, method, body) => api(journal, suffix, method, body),
      quiesce: () => quiesce(sender),
    });
    if (result.phase === "complete") await maintenance.finish();
    return { status: await status() };
  }
  async function supersede(sender) {
    const journal = await current(true);
    await prepare(sender);
    const replacementMigrationId = crypto.randomUUID();
    if (journal.manifestText) {
      const reply = assertSession(
        await api(journal, "/supersede", "POST", {
          manifestHash: journal.manifestHash,
          replacementMigrationId,
        }),
        journal,
      );
      if (reply.phase !== "superseded")
        throw failure("migration_manifest_conflict");
    }
    await journalStore.save({
      version: 1,
      migrationId: replacementMigrationId,
      clientBuild: build,
      deviceId: journal.deviceId,
      phase: "maintenance",
      intents: {},
      containers: {},
      cleaned: [],
    });
    return { status: await status() };
  }
  return {
    handle(action, sender, input = {}) {
      const operations = {
        status: () => status(),
        start: () => start(sender),
        resume: () => upload(sender),
        preview: () => preview(sender, input),
        resolve: () => resolve(sender, input),
        apply: () => apply(sender, input),
        cleanup: () => cleanup(sender),
        supersede: () => supersede(sender),
      };
      if (!Object.hasOwn(operations, action))
        return Promise.reject(failure("migration_invalid_source"));
      const task = queue.then(operations[action]);
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    },
  };
}
