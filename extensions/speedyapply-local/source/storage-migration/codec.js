import { JobsStorageMigrationPolicy as policy } from "../../src/custom/storage-migration-policy.js";
export const shaPattern = /^[a-f0-9]{64}$/;
export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function failure(
  code,
  message = "迁移核验未通过，未核验的资料不会被清理",
) {
  return Object.assign(Error(message), { code });
}
export async function hashText(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
export function encodeValue(value) {
  const pending = [{ value, depth: 0 }],
    seen = new WeakSet();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (
      ++nodes > policy.limits.maxJsonNodes ||
      item.depth > policy.limits.maxJsonDepth
    )
      throw failure("migration_limit", "旧资料超出安全处理范围，原资料已保留");
    if (
      item.value === null ||
      ["string", "boolean"].includes(typeof item.value)
    )
      continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (!item.value || typeof item.value !== "object" || seen.has(item.value))
      throw failure("migration_invalid_source");
    seen.add(item.value);
    if (
      !Array.isArray(item.value) &&
      Object.getPrototypeOf(item.value) !== Object.prototype
    )
      throw failure("migration_invalid_source");
    for (const child of Object.values(item.value))
      pending.push({ value: child, depth: item.depth + 1 });
  }
  const jsonText = JSON.stringify(value),
    size = new TextEncoder().encode(jsonText).length;
  if (size > policy.limits.maxEntryBytes)
    throw failure("migration_limit", "单项旧资料过大，原资料已保留");
  return { jsonText, size, nodes };
}
export async function fingerprint(value) {
  const result = encodeValue(value);
  return { ...result, sha256: await hashText(result.jsonText) };
}
export function pointerValue(value, pointer) {
  let current = value;
  for (const key of pointer.slice(1).split("/")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      return { found: false };
    current = current[key];
  }
  return { found: true, value: current };
}
export function removePointer(value, pointer) {
  if (!/^\/(?:\d+\/)?premiumSettings\/responseContext$/.test(pointer))
    throw failure("migration_invalid_source");
  const next = structuredClone(value),
    keys = pointer.slice(1).split("/");
  let parent = next;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
      throw failure("migration_source_changed");
    parent = parent[key];
  }
  if (!Object.hasOwn(parent, keys.at(-1)))
    throw failure("migration_source_changed");
  delete parent[keys.at(-1)];
  return next;
}
