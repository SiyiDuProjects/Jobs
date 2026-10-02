import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import { nativePackage } from "./helpers/native-package.mjs";
test("packaged services use explicit ES imports and exports without a global service registry", async () => {
  const result = await nativePackage();
  const files = new Set([
    ...JSON.parse(
      await fs.readFile(
        path.join(result.stage, "content-modules.json"),
        "utf8",
      ),
    ),
    ...JSON.parse(
      await fs.readFile(
        path.join(result.stage, "background-modules.json"),
        "utf8",
      ),
    ),
  ]);
  for (const name of files) {
    if (name.startsWith("node_modules/")) continue;
    const source = await fs.readFile(
      new URL("../" + name, import.meta.url),
      "utf8",
    );
    parse(source, { sourceType: "module" });
    assert(!/globalThis\.Jobs\w+\s*=/.test(source), name);
  }
  const config = JSON.parse(
    await fs.readFile(new URL("../jsconfig.json", import.meta.url), "utf8"),
  );
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.noEmit, true);
});
