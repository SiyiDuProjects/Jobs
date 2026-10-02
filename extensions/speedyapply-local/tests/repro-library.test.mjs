import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { replayCase } from "../scripts/repro-runner.mjs";
const directory = new URL("./fixtures/repro/", import.meta.url);
const files = await fs.readdir(directory).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
test("saved reproduction cases keep their explicitly recorded reader observations", async (t) => {
  for (const name of files.filter((f) => f.endsWith(".json")).sort())
    await t.test(name, async () => {
      const value = JSON.parse(
        await readModule(new URL(name, directory), "utf8"),
      );
      for (const result of replayCase(value))
        assert.deepEqual(
          result.actual,
          result.expected,
          `${name}/${result.id}: component reading changed; review the case rather than silently refreshing its baseline`,
        );
    });
});
