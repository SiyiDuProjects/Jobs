import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
const source = await readModule(
  new URL("../src/custom/runtime-version.js", import.meta.url),
  "utf8",
);
test("running, disk and UI versions remain distinguishable without reloading pages", async () => {
  let disk = "current";
  const context = vm.createContext({
    JobsBuildInfo: { id: "current" },
    chrome: {
      runtime: {
        getURL: () => "extension://manifest.json",
        onMessage: { addListener() {} },
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ version_name: disk }),
    }),
  });
  vm.runInContext(source, context);
  assert.equal((await context.runtimeVersion("current")).reloadRequired, false);
  disk = "new";
  const result = await context.runtimeVersion("current");
  assert.equal(result.running, "current");
  assert.equal(result.installed, "new");
  assert.equal(result.reloadRequired, true);
  disk = "current";
  assert.equal((await context.runtimeVersion("other")).reloadRequired, true);
});
