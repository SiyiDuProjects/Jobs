import { JobsStorageMigrationPolicy as policy } from "../../src/custom/storage-migration-policy.js";
import { legacyStorageKind } from "../../src/custom/storage-upgrade.js";
import { contextPointers } from "../../src/custom/migration-context-fields.js";
import { failure, fingerprint, pointerValue } from "./codec.js";

/** @param {chrome.storage.LocalStorageArea} storage @param {string} key */
export async function readKey(storage, key) {
  // Chrome cannot read only a nested property. Bound the whole container before
  // loading it, and keep its contents only for this serial operation.
  if ((await storage.getBytesInUse(key)) > policy.limits.maxEntryBytes + 4096)
    throw failure("migration_limit", "旧资料容器过大，原资料已保留");
  const values = await storage.get(key);
  return Object.hasOwn(values, key)
    ? { found: true, value: values[key] }
    : { found: false };
}
/** @returns {Promise<{found:false,container?:unknown,jsonText?:never,size?:never,nodes?:never,sha256?:never}|{found:true,container:unknown,jsonText:string,size:number,nodes:number,sha256:string}>} */
export async function readEntry(storage, entry) {
  if (!["local", "session"].includes(entry.storageArea))
    throw failure("migration_invalid_source");
  const container = await readKey(storage[entry.storageArea], entry.storageKey);
  if (!container.found) return { found: false };
  const selected = entry.pointer
    ? pointerValue(container.value, entry.pointer)
    : container;
  if (!selected.found) return { found: false, container: container.value };
  return {
    found: true,
    ...(await fingerprint(selected.value)),
    container: container.value,
  };
}
export async function captureInventory(storage, pending = {}) {
  const keys = (await storage.local.getKeys()).sort(),
    entries = [];
  let totalBytes = 0,
    totalNodes = 0;
  async function add(
    key,
    value,
    kind,
    pointer = undefined,
    containerSha256 = undefined,
    storageArea = "local",
  ) {
    const encoded = await fingerprint(value);
    totalBytes += encoded.size;
    totalNodes += encoded.nodes;
    if (
      totalBytes > policy.limits.maxTotalBytes ||
      totalNodes > policy.limits.maxTotalJsonNodes ||
      entries.length >= policy.limits.maxEntries
    )
      throw failure(
        "migration_limit",
        "旧资料总量超出安全迁移范围，原资料已保留",
      );
    entries.push({
      entryId: crypto.randomUUID(),
      selector:
        (storageArea === "session" ? "session:" : "") +
        key +
        (pointer ? "#" + pointer : ""),
      storageArea,
      storageKey: key,
      ...(pointer ? { pointer } : {}),
      disposition: pointer
        ? "remove_path"
        : kind === "identity"
          ? "retain_identity"
          : "remove_key",
      kind,
      size: encoded.size,
      sha256: encoded.sha256,
      ...(containerSha256 ? { containerSha256 } : {}),
    });
  }
  for (const key of keys) {
    const kind = legacyStorageKind(key);
    if (
      !kind &&
      !policy.sourcePolicy.identityKeys.includes(key) &&
      !["settings", "configList"].includes(key)
    )
      continue;
    const source = await readKey(storage.local, key);
    if (!source.found) throw failure("migration_source_changed");
    if (["settings", "configList"].includes(key)) {
      const pointers = contextPointers(key, source.value);
      if (!pointers.length) continue;
      const containerHash = (await fingerprint(source.value)).sha256;
      for (const pointer of pointers)
        await add(
          key,
          pointerValue(source.value, pointer).value,
          "response_context",
          pointer,
          containerHash,
        );
    } else await add(key, source.value, kind || "identity");
  }
  for (const key of Object.keys(pending).sort()) {
    if (
      key !== "jobsManagementBaseV1" &&
      !/^jobsResponses:[a-f0-9-]{36}$/i.test(key)
    )
      throw failure("migration_invalid_source");
    if (
      key === "jobsManagementBaseV1" &&
      Object.keys(pending[key]).some((item) => !Object.hasOwn(pending, item))
    )
      throw failure("migration_invalid_source");
    const current = await readKey(storage.session, key);
    if (
      !current.found ||
      (await fingerprint(current.value)).sha256 !==
        (await fingerprint(pending[key])).sha256
    )
      throw failure("migration_source_changed");
    await add(
      key,
      current.value,
      key === "jobsManagementBaseV1" ? "merge_baseline" : "answers",
      undefined,
      undefined,
      "session",
    );
  }
  return entries.sort((a, b) =>
    a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
  );
}
export async function currentSelectors(storage) {
  const keys = await storage.local.getKeys(),
    result = keys.filter(legacyStorageKind);
  for (const key of ["settings", "configList"]) {
    if (!keys.includes(key)) continue;
    const source = await readKey(storage.local, key);
    for (const pointer of contextPointers(key, source.value))
      result.push(key + "#" + pointer);
  }
  for (const key of await storage.session.getKeys())
    if (
      key === "jobsManagementBaseV1" ||
      /^jobsResponses:[a-f0-9-]{36}$/i.test(key)
    )
      result.push("session:" + key);
  return result.sort();
}
