import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { updateInstalled } from "../scripts/update-package.mjs";
import { requiredChecks, receiptName } from "../scripts/package-state.mjs";
import { packageFixture } from "./helpers/package-fixture.mjs";

function options(f, extra = {}) {
  return {
    root: f.root,
    assertPrimary: async () => {},
    generate: async () => {},
    build: f.build,
    check: async () => {},
    ...extra,
  };
}
test("one update checks the combined source then installs and reports reload required", async () => {
  const f = await packageFixture(),
    checks = [];
  try {
    const result = await updateInstalled(
      options(f, { check: async (name) => checks.push(name) }),
    );
    assert.deepEqual(checks, requiredChecks);
    assert.equal(result.published, true);
    assert.equal(result.browserReloadRequired, true);
    assert.equal(await f.code("dist"), "combined");
    assert.equal(await f.code("artifacts/previous-dist"), "old");
    const receipt = JSON.parse(
      await fs.readFile(path.join(f.root, "dist", receiptName), "utf8"),
    );
    assert.deepEqual(receipt.checks, requiredChecks);
    assert(!(await fs.readdir(f.root)).includes(".build-update.lock"));
    assert(!(await fs.readdir(f.root)).includes(".build-update"));
  } finally {
    await f.close();
  }
});
test("a failed check never builds or changes the installation", async () => {
  const f = await packageFixture();
  try {
    await assert.rejects(
      updateInstalled(
        options(f, {
          check: async () => {
            throw Error("regression");
          },
          build: async () => {
            assert.fail("must not build");
          },
        }),
      ),
      /regression/,
    );
    assert.equal(await f.code("dist"), "old");
    assert(!(await fs.readdir(f.root)).includes(".build-update.lock"));
  } finally {
    await f.close();
  }
});
test("edits during validation prevent publication", async () => {
  const f = await packageFixture();
  try {
    await assert.rejects(
      updateInstalled(
        options(f, {
          check: async () =>
            fs.writeFile(path.join(f.root, "src/fixture.js"), "in-progress"),
        }),
      ),
      /Source changed during checks/,
    );
    assert.equal(await f.code("dist"), "old");
  } finally {
    await f.close();
  }
});
test("update lock covers validation and rejects a second updater without removing its lock", async () => {
  const f = await packageFixture();
  try {
    let attempted = false;
    await updateInstalled(
      options(f, {
        check: async () => {
          if (attempted) return;
          attempted = true;
          await assert.rejects(
            updateInstalled(options(f)),
            /Another update is running/,
          );
          assert((await fs.readdir(f.root)).includes(".build-update.lock"));
        },
      }),
    );
    assert.equal(await f.code("dist"), "combined");
  } finally {
    await f.close();
  }
});
test("an installation change during checks is preserved and own candidate is cleaned", async () => {
  const f = await packageFixture();
  try {
    await assert.rejects(
      updateInstalled(
        options(f, {
          check: async () => {
            await f.write("dist", "other-publisher");
          },
        }),
      ),
      /installation changed during update/,
    );
    assert.equal(await f.code("dist"), "other-publisher");
    assert(!(await fs.readdir(f.root)).includes(".build-update"));
    assert((await fs.readdir(f.root)).includes(".build-next"));
  } finally {
    await f.close();
  }
});
test("publication failure cleans only this update's candidate and keeps original installation", async () => {
  const f = await packageFixture();
  try {
    await assert.rejects(
      updateInstalled(
        options(f, {
          publish: async () => {
            throw Error("switch unavailable");
          },
        }),
      ),
      /switch unavailable/,
    );
    assert.equal(await f.code("dist"), "old");
    assert(!(await fs.readdir(f.root)).includes(".build-update"));
    assert((await fs.readdir(f.root)).includes(".build-next"));
  } finally {
    await f.close();
  }
});
