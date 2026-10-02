import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {
  sourceInputs,
  sourceFingerprint,
  installedFingerprint,
  packageFingerprint,
  receiptName,
  requiredChecks,
} from "../../scripts/package-state.mjs";

export async function packageFixture() {
  const base = path.resolve(".qa");
  await fs.mkdir(base, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(base, "publish-test-"));
  const root = path.join(temporary, "repo/extensions/speedyapply-local");
  await fs.mkdir(root, { recursive: true });
  for (const input of sourceInputs) {
    const file = path.resolve(
      root,
      ["source", "src", "scripts", "tests"].includes(input)
        ? `${input}/fixture.js`
        : input,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "synthetic");
  }
  const write = async (
    name,
    value,
    key = "same-extension",
    checks = requiredChecks,
  ) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const sourceHash = await sourceFingerprint(root),
      buildId = sourceHash.slice(0, 16);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, key, version_name: buildId }),
    );
    await fs.writeFile(path.join(dir, "code.js"), value);
    if (name.startsWith(".build-"))
      await fs.writeFile(
        path.join(dir, receiptName),
        JSON.stringify({
          version: 1,
          root: await fs.realpath(root),
          sourceHash,
          buildId,
          baseHash: await installedFingerprint(root),
          packageHash: await packageFingerprint(dir),
          personal: true,
          checks,
        }),
      );
    return dir;
  };
  await write("dist", "old");
  const staging = await write(".build-next", "new");
  return {
    root,
    staging,
    write,
    code: (relative) =>
      fs.readFile(path.join(root, relative, "code.js"), "utf8"),
    receipt: async (stage = staging) =>
      JSON.parse(await fs.readFile(path.join(stage, receiptName), "utf8")),
    build: async () => {
      const stage = await write(
        ".build-update",
        "combined",
        "same-extension",
        [],
      );
      return {
        stage,
        ...(await JSON.parse(
          await fs.readFile(path.join(stage, receiptName), "utf8"),
        )),
      };
    },
    close: async () => {
      assert.equal(
        path.dirname(await fs.realpath(temporary)),
        await fs.realpath(base),
      );
      await fs.rm(temporary, { recursive: true });
    },
  };
}
