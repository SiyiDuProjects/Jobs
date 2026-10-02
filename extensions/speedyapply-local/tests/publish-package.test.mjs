import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { publishPackage } from "../scripts/publish-package.mjs";
import { packageFixture as fixture } from "./helpers/package-fixture.mjs";
import { receiptName } from "../scripts/package-state.mjs";
test("successful builds keep the same installed directory and only one previous package", async () => {
  const f = await fixture();
  try {
    const first = await publishPackage(f.root, f.staging);
    assert.equal(first.installed, path.join(f.root, "dist"));
    assert.equal(await f.code("dist"), "new");
    assert.equal(await f.code("artifacts/previous-dist"), "old");
    const third = await f.write(".build-third", "third");
    await publishPackage(f.root, third);
    assert.equal(await f.code("dist"), "third");
    assert.equal(await f.code("artifacts/previous-dist"), "new");
    assert.deepEqual(await fs.readdir(path.join(f.root, "artifacts")), [
      "previous-dist",
    ]);
    assert.equal(
      (await fs.readdir(f.root)).includes(".build-publish.lock"),
      false,
    );
  } finally {
    await f.close();
  }
});
test("a different extension identity never replaces the existing installation", async () => {
  const f = await fixture();
  try {
    await f.write(".build-next", "wrong", "different");
    await assert.rejects(publishPackage(f.root, f.staging), /identity changed/);
    assert.equal(await f.code("dist"), "old");
  } finally {
    await f.close();
  }
});
test("a failed package switch restores the previous installed directory", async () => {
  const f = await fixture();
  try {
    const io = {
      ...fs,
      rename: async (from, to) => {
        if (from === f.staging) throw Error("Simulated locked directory");
        return fs.rename(from, to);
      },
    };
    await assert.rejects(
      publishPackage(f.root, f.staging, io),
      /locked directory/,
    );
    assert.equal(await f.code("dist"), "old");
    assert.equal(await f.code(".build-next"), "new");
  } finally {
    await f.close();
  }
});
test("concurrent publishing is rejected before changing either package", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.root, ".build-publish.lock"),
      "other publisher",
    );
    await assert.rejects(publishPackage(f.root, f.staging), { code: "EEXIST" });
    assert.equal(await f.code("dist"), "old");
    assert.equal(await f.code(".build-next"), "new");
  } finally {
    await f.close();
  }
});
test("an unexpected backup location is never removed", async () => {
  const f = await fixture();
  try {
    const io = {
      ...fs,
      realpath: async (file) =>
        file === path.join(f.root, "artifacts")
          ? path.join(f.root, "unexpected")
          : fs.realpath(file),
    };
    await assert.rejects(
      publishPackage(f.root, f.staging, io),
      /Unsafe package backup parent/,
    );
    assert.equal(await f.code("dist"), "old");
  } finally {
    await f.close();
  }
});

test("an older agent cannot overwrite another agent's installed package", async () => {
  const f = await fixture();
  try {
    const newer = await f.write(".build-newer", "both-fixes");
    await publishPackage(f.root, newer);
    await assert.rejects(
      publishPackage(f.root, f.staging),
      /another update won/,
    );
    assert.equal(await f.code("dist"), "both-fixes");
    assert.equal(await f.code("artifacts/previous-dist"), "old");
  } finally {
    await f.close();
  }
});

for (const input of [
  "src/fixture.js",
  "scripts/fixture.js",
  "tests/fixture.js",
  "../../services/jobs-radar/jobs_radar/answer-policy.json",
]) {
  test(`rejects a candidate after ${input} changes`, async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.resolve(f.root, input), "another-fix");
      await assert.rejects(
        publishPackage(f.root, f.staging),
        /Stale candidate/,
      );
      assert.equal(await f.code("dist"), "old");
    } finally {
      await f.close();
    }
  });
}

test("changed output and candidates without completed checks never reach dist", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.staging, "code.js"), "altered");
    await assert.rejects(
      publishPackage(f.root, f.staging),
      /Candidate changed/,
    );
    await f.write(".build-next", "new", "same-extension", []);
    await assert.rejects(
      publishPackage(f.root, f.staging),
      /Unverified candidate/,
    );
    await fs.unlink(path.join(f.staging, receiptName));
    await assert.rejects(
      publishPackage(f.root, f.staging),
      /Unverified candidate/,
    );
    assert.equal(await f.code("dist"), "old");
  } finally {
    await f.close();
  }
});

test("failed readback restores old installation", async () => {
  const f = await fixture();
  try {
    const io = {
      ...fs,
      rename: async (from, to) => {
        await fs.rename(from, to);
        if (from === f.staging)
          await fs.writeFile(path.join(to, "code.js"), "damaged");
      },
    };
    await assert.rejects(
      publishPackage(f.root, f.staging, io),
      /verification failed/,
    );
    assert.equal(await f.code("dist"), "old");
    assert.equal(await f.code(".build-next"), "damaged");
  } finally {
    await f.close();
  }
});
