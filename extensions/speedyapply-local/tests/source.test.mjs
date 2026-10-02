import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { nativePackage } from "./helpers/native-package.mjs";
test("native package preserves the installed public identity and contains only maintained code plus npm modules", async () => {
  const prior = JSON.parse(
    await fs.readFile(new URL("../upstream.json", import.meta.url), "utf8"),
  );
  const result = await nativePackage(),
    manifest = JSON.parse(
      await fs.readFile(result.stage + "/manifest.json", "utf8"),
    );
  const id = [
    ...createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
  assert.equal(id, prior.developmentExtensionId);
  assert.equal(manifest.update_url, undefined);
  assert.deepEqual(manifest.permissions, [
    "storage",
    "unlimitedStorage",
    "tabs",
    "alarms",
    "scripting",
  ]);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.options_ui, undefined);
  assert.equal(manifest.side_panel, undefined);
  for (const entry of ["content", "background"])
    for (const input of JSON.parse(
      await fs.readFile(result.stage + "/" + entry + "-modules.json", "utf8"),
    )) {
      assert(
        /^(source\/|src\/custom\/|node_modules\/date-fns\/)/.test(input),
        input,
      );
      assert(!/vendor|runtime\.template|src\/chunks/.test(input));
    }
  const names = await fs.readdir(result.stage);
  assert(!names.includes("chunks"));
  assert(!names.includes("options.html"));
  assert(!names.includes("sidepanel.html"));
});
