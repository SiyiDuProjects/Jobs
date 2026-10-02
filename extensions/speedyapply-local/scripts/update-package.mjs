import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateContracts } from "./generate-contracts.mjs";
import { buildPackage } from "./build.mjs";
import { publishPackage } from "./publish-package.mjs";
import {
  sourceFingerprint,
  installedFingerprint,
  receiptName,
  requiredChecks,
  discardCandidate,
} from "./package-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
export async function assertPrimaryCheckout(directory) {
  const { stdout } = await execute(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: directory },
  );
  const primary = path.join(
    path.dirname(stdout.trim()),
    "extensions",
    "speedyapply-local",
  );
  if ((await fs.realpath(directory)) !== (await fs.realpath(primary)))
    throw Error(
      "Integrate worktree changes into the primary checkout before npm run update",
    );
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `Check failed (${signal || code}); installed extension unchanged`,
            ),
          ),
    );
  });
}
async function check(name) {
  console.log(`Checking ${name}...`);
  if (name === "test") {
    const files = (await fs.readdir(path.join(root, "tests")))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort();
    await run([
      "--test",
      "--test-concurrency=4",
      ...files.map((file) => `tests/${file}`),
    ]);
  } else if (name === "typecheck")
    await run([
      "node_modules/typescript/bin/tsc",
      "--project",
      "jsconfig.json",
    ]);
  else await run(["scripts/check-source-size.mjs"]);
}

// Injectable operations let tests exercise failures without touching real dist.
export async function updateInstalled(options = {}) {
  const directory = options.root || root;
  const primary = options.assertPrimary || assertPrimaryCheckout;
  const generate = options.generate || generateContracts;
  const build = options.build || buildPackage;
  const runCheck = options.check || check;
  const publish = options.publish || publishPackage;
  await primary(directory);
  const lockPath = path.join(directory, ".build-update.lock");
  const lock = await fs.open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST")
      throw Error(
        "Another update is running. Wait for its result; do not remove its lock",
      );
    throw error;
  });
  let candidate;
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await generate();
    const sourceHash = await sourceFingerprint(directory);
    const baseHash = await installedFingerprint(directory);
    for (const name of requiredChecks) {
      await runCheck(name);
      if ((await sourceFingerprint(directory)) !== sourceHash)
        throw Error(
          "Source changed during checks; rerun npm run update after edits settle",
        );
    }
    candidate = await build({ personal: true });
    if (candidate.sourceHash !== sourceHash || candidate.baseHash !== baseHash)
      throw Error(
        "Source or installation changed during update; rerun npm run update",
      );
    const receiptPath = path.join(candidate.stage, receiptName);
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.checks = requiredChecks;
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    const result = await publish(directory, candidate.stage);
    return {
      ...result,
      buildId: candidate.buildId,
      published: true,
      browserReloadRequired: true,
    };
  } finally {
    try {
      if (candidate) await discardCandidate(directory, candidate.stage);
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    console.log(JSON.stringify(await updateInstalled()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
