import fs from "node:fs/promises";
import path from "node:path";
import {
  sourceFingerprint,
  installedFingerprint,
  packageFingerprint,
  receiptName,
  requiredChecks,
} from "./package-state.mjs";

// Publish a verified package at the one path Chrome already knows. All build
// work happens elsewhere; a failed directory switch restores the previous one.
export async function publishPackage(root, staging, io = fs) {
  root = await io.realpath(root);
  staging = await io.realpath(staging);
  if (
    path.dirname(staging) !== root ||
    !path.basename(staging).startsWith(".build-")
  )
    throw Error("Invalid package staging path");
  const installed = path.join(root, "dist"),
    artifacts = path.join(root, "artifacts"),
    backup = path.join(artifacts, "previous-dist");
  const lockPath = path.join(root, ".build-publish.lock");
  const lock = await io.open(lockPath, "wx");
  let moved = false;
  try {
    const next = JSON.parse(
      await io.readFile(path.join(staging, "manifest.json"), "utf8"),
    );
    if (next.manifest_version !== 3 || !next.key)
      throw Error("Invalid staged extension identity");
    const current = await io.lstat(installed).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (current) {
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        (await io.realpath(installed)) !== installed
      )
        throw Error("Unsafe installed extension path");
      const previous = JSON.parse(
        await io.readFile(path.join(installed, "manifest.json"), "utf8"),
      );
      if (next.key !== previous.key)
        throw Error(
          "Extension identity changed; existing records must be preserved",
        );
    }
    const receipt = JSON.parse(
      await io
        .readFile(path.join(staging, receiptName), "utf8")
        .catch((error) => {
          if (error.code === "ENOENT")
            throw Error("Unverified candidate; use npm run update");
          throw error;
        }),
    );
    if (
      receipt.version !== 1 ||
      receipt.root !== root ||
      receipt.personal !== true ||
      !requiredChecks.every((check) => receipt.checks?.includes(check)) ||
      receipt.buildId !== next.version_name ||
      receipt.sourceHash?.slice(0, 16) !== receipt.buildId
    )
      throw Error("Unverified candidate; use npm run update");
    if ((await packageFingerprint(staging, io)) !== receipt.packageHash)
      throw Error("Candidate changed after checks; rerun npm run update");
    if ((await sourceFingerprint(root, io)) !== receipt.sourceHash)
      throw Error("Stale candidate: source changed; rerun npm run update");
    if ((await installedFingerprint(root, io)) !== receipt.baseHash)
      throw Error(
        "Installed package changed: another update won; rerun npm run update",
      );
    await io.mkdir(artifacts, { recursive: true });
    if ((await io.realpath(artifacts)) !== artifacts)
      throw Error("Unsafe package backup parent");
    const saved = await io.lstat(backup).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (saved) {
      if (
        saved.isSymbolicLink() ||
        !saved.isDirectory() ||
        (await io.realpath(backup)) !== backup
      )
        throw Error("Unsafe package backup path");
      await io.rm(backup, { recursive: true });
    }
    // Recheck after backup preparation, immediately before replacing dist.
    if (
      (await sourceFingerprint(root, io)) !== receipt.sourceHash ||
      (await installedFingerprint(root, io)) !== receipt.baseHash
    )
      throw Error(
        "Workspace or installation changed before switch; rerun npm run update",
      );
    if (current) {
      await io.rename(installed, backup);
      moved = true;
    }
    try {
      await io.rename(staging, installed);
      if ((await packageFingerprint(installed, io)) !== receipt.packageHash)
        throw Error("Installed package verification failed");
    } catch (error) {
      if (await io.lstat(installed).catch(() => null))
        await io.rename(installed, staging);
      if (moved) await io.rename(backup, installed);
      throw error;
    }
    return { installed, backup: moved ? backup : null };
  } finally {
    await lock.close();
    await io.unlink(lockPath);
  }
}
