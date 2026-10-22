import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
const source = await readModule(
  new URL("../src/custom/reconnect-background.js", import.meta.url),
  "utf8",
);
function harness({
  disabled = false,
  frames = [
    { frameId: 0, result: true },
    { frameId: 7, result: false },
  ],
} = {}) {
  const calls = [],
    reads = [],
    event = { addListener() {} };
  const chrome = {
    runtime: {
      onInstalled: event,
      onStartup: event,
      getManifest: () => ({
        content_scripts: [
          {
            js: ["custom/runtime-bundle.js"],
            matches: ["https://*.example.test/*"],
            all_frames: true,
          },
        ],
      }),
    },
    alarms: { onAlarm: event },
    storage: {
      local: {
        get: async (keys) => {
          reads.push(keys);
          const data = {
            jobsSyncV1: { profileToken: "synthetic", disabled },
            "jobsReconnectTab:2": "https://custom.test",
          };
          assert.notEqual(
            keys,
            null,
            "reconnect must not read diagnostic payloads",
          );
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              data[key],
            ]),
          );
        },
        remove: async () => {},
      },
    },
    tabs: {
      query: async (filter) =>
        filter.url
          ? [{ id: 1, status: "complete" }]
          : [
              { id: 1, status: "complete" },
              { id: 2, url: "https://custom.test/job", status: "complete" },
            ],
      get: async () => ({
        id: 2,
        url: "https://custom.test/job",
        status: "complete",
      }),
    },
    scripting: {
      executeScript: async (request) => {
        calls.push(request);
        return request.target.allFrames ? frames : [];
      },
    },
  };
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(source, context);
  return { calls, reads, run: () => context.reconnectPages() };
}
test("reconnect inspects every frame and injects only missing receivers, including retained custom hosts", async () => {
  const h = harness();
  await Promise.all([h.run(), h.run()]);
  assert.equal(h.calls.length, 6);
  assert.deepEqual(Array.from(h.reads[1]), [
    "jobsReconnectTab:1",
    "jobsReconnectTab:2",
  ]);
  assert.deepEqual(
    h.calls.filter((c) => c.files).map((c) => Array.from(c.target.frameIds)),
    [[7], [7]],
  );
  assert(
    h.calls
      .filter((c) => c.files)
      .every((c) => c.files[0] === "custom/runtime-bundle.js"),
  );
});
test("healthy frames and disconnected installations never restart filling", async () => {
  const h = harness({ frames: [{ frameId: 0, result: true }] });
  await h.run();
  assert.equal(h.calls.filter((c) => c.files).length, 0);
  const disabled = harness({ disabled: true });
  await disabled.run();
  assert.equal(disabled.calls.length, 0);
});
