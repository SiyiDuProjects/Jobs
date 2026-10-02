import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const receiptName = ".build-receipt.json";
export const requiredChecks = ["test", "typecheck", "check:structure"];
// Include generators and their authoritative inputs, not only emitted JS.
export const sourceInputs = [
  "source",
  "src",
  "scripts",
  "tests",
  "package.json",
  "package-lock.json",
  "jsconfig.json",
  "../../services/jobs-radar/config/brand.json",
  "../../services/jobs-radar/scripts/build-profile-contract.mjs",
  "../../services/jobs-radar/web/scripts/build-response-contract.mjs",
  "../../services/jobs-radar/contracts/profile-runtime.js",
  "../../services/jobs-radar/contracts/response-contract.js",
  ...[
    "profile.schema",
    "answer-policy",
    "saved_response_contract",
    "storage-migration-contract",
    "job_match_rules",
  ].map((name) => `../../services/jobs-radar/jobs_radar/${name}.json`),
];

export async function fingerprint(root, inputs, io = fs, exclude = []) {
  const hash = createHash("sha256");
  async function visit(relative) {
    if (exclude.includes(relative)) return;
    const file = path.resolve(root, relative);
    const stat = await io.lstat(file);
    if (stat.isSymbolicLink())
      throw Error("Package inputs may not use symlinks");
    if (stat.isDirectory()) {
      for (const name of (await io.readdir(file)).sort())
        await visit(relative === "." ? name : `${relative}/${name}`);
    } else if (stat.isFile()) {
      const content = await io.readFile(file);
      hash.update(JSON.stringify([relative, content.length]));
      hash.update(content);
    } else throw Error("Unsupported package input");
  }
  for (const input of inputs) await visit(input);
  return hash.digest("hex");
}

export const sourceFingerprint = (root, io = fs) =>
  fingerprint(root, sourceInputs, io);
export const packageFingerprint = (directory, io = fs) =>
  fingerprint(directory, ["."], io, [receiptName]);
export async function installedFingerprint(root, io = fs) {
  const directory = path.join(root, "dist");
  try {
    await io.lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return packageFingerprint(directory, io);
}

// Remove only the caller's own candidate; never sweep another agent's work.
export async function discardCandidate(root, candidate) {
  root = await fs.realpath(root);
  const resolved = await fs.realpath(candidate).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!resolved) return;
  if (
    path.dirname(resolved) !== root ||
    !path.basename(resolved).startsWith(".build-")
  )
    throw Error("Unsafe candidate cleanup path");
  if ((await fs.lstat(candidate)).isSymbolicLink())
    throw Error("Unsafe candidate link");
  await fs.rm(resolved, { recursive: true });
}
