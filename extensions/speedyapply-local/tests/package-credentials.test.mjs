import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage } from "../scripts/build.mjs";
import { discardCandidate } from "../scripts/package-state.mjs";

test("personal installation builds without opening the private credential store", async (t) => {
  const read = fs.readFile;
  let candidate;
  t.mock.method(fs, "readFile", (file, ...args) => {
    const name = file instanceof URL ? fileURLToPath(file) : String(file);
    assert(
      !name.split(path.sep).includes(".private"),
      "Pairing credentials must never enter a build",
    );
    return read(file, ...args);
  });
  try {
    candidate = await buildPackage({ personal: true });
    assert.equal(
      JSON.parse(
        await read(path.join(candidate.stage, ".build-receipt.json"), "utf8"),
      ).personal,
      true,
    );
    const worker = await read(
      path.join(candidate.stage, "background.js"),
      "utf8",
    );
    assert(!worker.includes("JobsPrivateConnection"));
  } finally {
    if (candidate)
      await discardCandidate(
        fileURLToPath(new URL("../", import.meta.url)),
        candidate.stage,
      );
  }
});
