import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { readModule } from "./helpers/module-source.mjs";
const source = Object.fromEntries(
  await Promise.all(
    ["storage-upgrade", "document-store", "tab-profiles", "sync"].map(
      async (name) => [
        name,
        await readModule(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        ),
      ],
    ),
  ),
);
const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/storage-upgrade.json", import.meta.url),
    "utf8",
  ),
);
function harness(initial = {}, options = {}) {
  const data = structuredClone(initial),
    session = {},
    changes = [],
    messages = [],
    writes = [],
    reads = [],
    network = [];
  const noop = { addListener() {} };
  let enumerations = 0;
  const local = {
    getKeys: async () => {
      enumerations++;
      const keys = Object.keys(data);
      await options.enumerate?.();
      return keys;
    },
    getBytesInUse: async (key) =>
      Buffer.byteLength(JSON.stringify({ [key]: data[key] })),
    get: async (keys) => {
      reads.push(structuredClone(keys));
      if (keys == null) throw Error("Unbounded durable read");
      if (
        [keys]
          .flat()
          .some(
            (key) =>
              ![
                "settings",
                "configList",
                "jobsKindProfiles",
                "jobsSyncV1",
                "jobsStorageMigrationV1",
              ].includes(key),
          )
      )
        throw Error("Legacy value read");
      return Object.fromEntries(
        [keys]
          .flat()
          .filter((k) => k in data)
          .map((k) => [k, structuredClone(data[k])]),
      );
    },
    set: async (value) => {
      writes.push(structuredClone(value));
      Object.assign(data, structuredClone(value));
    },
    remove: async () => {
      throw Error("Deletion is not implemented or authorized");
    },
    clear: async () => {
      throw Error("Deletion is not implemented or authorized");
    },
  };
  const c = vm.createContext({
    chrome: {
      storage: {
        local,
        session: {
          getKeys: async () => Object.keys(session),
          get: async () => structuredClone(session),
          set: async (values) =>
            Object.assign(session, structuredClone(values)),
          remove: async () => {},
        },
        onChanged: { addListener: (f) => changes.push(f) },
      },
      runtime: {
        id: "fixture",
        getURL: (path) => "chrome-extension://fixture/" + path,
        onMessage: { addListener: (f) => messages.push(f) },
        onInstalled: noop,
        onStartup: noop,
      },
      tabs: {
        onCreated: noop,
        onUpdated: noop,
        onRemoved: noop,
        query: async () => [],
        sendMessage: async () => {},
      },
      alarms: { create() {}, onAlarm: noop },
    },
    fetch: async (url) => {
      network.push(url);
      throw Error("Synthetic offline server");
    },
    URL,
    TextEncoder,
    Uint8Array,
    AbortSignal,
    crypto: webcrypto,
    Date,
    console,
    structuredClone,
  });
  vm.runInContext(source["storage-upgrade"], c);
  return {
    c,
    data,
    session,
    local,
    reads,
    writes,
    network,
    messages,
    get enumerations() {
      return enumerations;
    },
    change(key, value) {
      data[key] = value;
      for (const fn of changes) fn({ [key]: { newValue: value } }, "local");
    },
  };
}
test("fresh installation checks metadata and bounded legacy settings presence, accepting identity/connection records", async () => {
  const keep = Object.fromEntries(
    fixture.expected.preserve.map((key) => [key, fixture.local[key]]),
  );
  const h = harness({
    ...keep,
    jobsTabProfileRecoveryV2: { 7: { id: fixture.profileId } },
    lastSyncProfile: { id: fixture.profileId },
    jobsProfilesList: [{ id: fixture.profileId }],
  });
  assert.equal((await h.c.JobsStorageUpgrade.inspect()).state, "ready");
  await h.c.JobsStorageUpgrade.assertReady();
  assert.deepEqual(h.reads, ["settings"]);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.network, []);
  assert.equal(h.enumerations, 1);
});
test("all confirmed legacy key classes stop filling without reading their values", async () => {
  const keys = [
    "profile",
    "jobsProfilesCache",
    "jobsProfileBeforeMigration",
    "jobsProfilePending",
    "responseList",
    "jobsResponsesLegacyBackup",
    "jobsManagementBaseV1",
    "jobsManagementBeforeMigrationV1",
    "jobsTabProfileRecoveryV1",
    "appliedList",
    "jobsResponses:local-default",
    "jobsResponses:" + fixture.profileId,
  ];
  for (const key of keys) {
    const h = harness({
      [key]: { secretSyntheticFact: "must never reach inventory" },
    });
    const status = await h.c.JobsStorageUpgrade.inspect();
    assert.equal(status.state, "needs_migration", key);
    assert.deepEqual(Object.keys(status.entries[0]).sort(), [
      "bytes",
      "key",
      "kind",
    ]);
    assert.equal(status.entries[0].key, key);
    assert.ok(status.entries[0].bytes > 0);
    assert.ok(!JSON.stringify(status).includes("must never reach inventory"));
    await assert.rejects(
      h.c.JobsStorageUpgrade.assertReady(),
      (e) => e.code === "storage_upgrade_required",
    );
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.network, []);
  }
});
test("concurrent inspection cannot return ready after a legacy write invalidates enumeration", async () => {
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  const h = harness({}, { enumerate: () => barrier });
  const first = h.c.JobsStorageUpgrade.inspect(),
    second = h.c.JobsStorageUpgrade.inspect();
  h.change("profile", { profileName: "Synthetic late old value" });
  release();
  for (const value of await Promise.all([first, second]))
    assert.equal(value.state, "needs_migration");
  assert.equal(h.enumerations, 2);
  await assert.rejects(h.c.JobsStorageUpgrade.assertReady(), /受控迁移/);
});
test("missing metadata API fails closed without falling back to reading the store", async () => {
  const h = harness(
    {},
    {
      enumerate: async () => {
        throw Error("metadata unavailable");
      },
    },
  );
  assert.equal((await h.c.JobsStorageUpgrade.inspect()).state, "unavailable");
  delete h.local.getKeys;
  await assert.rejects(h.c.JobsStorageUpgrade.assertReady(), /更新 Chrome/);
  assert.equal(h.c.JobsStorageUpgrade.peek().state, "unavailable");
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.writes, []);
});
test("offline differences and unacknowledged answers remain blocked with all durable data intact", async () => {
  const h = harness(fixture.local);
  const before = structuredClone(h.data),
    server = structuredClone(fixture.server);
  assert.notDeepEqual(before.profile, server.profile);
  assert.notDeepEqual(
    before["jobsResponses:" + fixture.profileId],
    server.responses,
  );
  const status = await h.c.JobsStorageUpgrade.inspect();
  assert.equal(status.state, fixture.expected.state);
  assert.deepEqual(h.data, before);
  assert.deepEqual(fixture.server, server);
  assert.deepEqual(h.network, []);
  assert.deepEqual(h.reads, ["settings"]);
  assert.deepEqual(h.writes, []);
});
test("metadata status is available only to packaged extension pages", async () => {
  const h = harness({ profile: {} }),
    request = { type: "jobs:storage-upgrade-status" };
  for (const sender of [
    { id: "other", url: "chrome-extension://fixture/popup.html" },
    { id: "fixture", url: "https://jobs.example.test" },
  ]) {
    let result;
    h.messages[0](request, sender, (value) => (result = value));
    assert.match(result.error, /Private extension/);
  }
  const result = await new Promise((resolve) =>
    h.messages[0](
      request,
      { id: "fixture", url: "chrome-extension://fixture/popup.html" },
      resolve,
    ),
  );
  assert.equal(result.data.state, "needs_migration");
});
test("DocumentStore reads only durable settings plus transient answer documents", async () => {
  const h = harness(fixture.local);
  const key = "jobsResponses:" + fixture.profileId;
  h.session[key] = [
    { question: "Current synthetic question", response: "Current answer" },
  ];
  h.session.profile_7 = { profile: { profileName: "Not a document" } };
  vm.runInContext(source["document-store"], h.c);
  let result;
  await h.c.JobsDocumentStore.commit((current) => {
    result = structuredClone(current);
    return null;
  });
  assert.deepEqual(h.reads, [
    "jobsStorageMigrationV1",
    ["settings", "jobsKindProfiles"],
    "settings",
  ]);
  assert.deepEqual(
    Object.keys(result).sort(),
    [key, "jobsKindProfiles", "settings"].sort(),
  );
  assert.deepEqual(result[key], h.session[key]);
  assert.deepEqual(h.data, fixture.local);
});
test("real tab Profile and HTTP Profile entry points reject before reading legacy facts or network", async () => {
  const h = harness(fixture.local);
  vm.runInContext(source["tab-profiles"], h.c);
  const sender = {
    id: "fixture",
    url: "https://jobs.example.test/form",
    tab: { id: 7, url: "https://jobs.example.test/form" },
  };
  await assert.rejects(h.c.JobsTabProfiles.ensure(sender), /受控迁移/);
  await assert.rejects(
    h.c.JobsTabProfiles.context(sender, { refresh: true }),
    /受控迁移/,
  );
  await assert.rejects(h.c.JobsTabProfiles.verify(sender), /受控迁移/);
  await assert.rejects(
    h.c.JobsTabProfiles.bind(7, { id: fixture.profileId, profile: {} }),
    /受控迁移/,
  );
  vm.runInContext(source.sync, h.c);
  await h.c.JobsSync.ready;
  await assert.rejects(
    h.c.JobsSync.profileRequest({ path: "/api/extension/profiles" }),
    /受控迁移/,
  );
  assert.deepEqual(h.network, []);
  assert.deepEqual(h.session, {});
});

test("pending migration snapshot reads only response documents and their base, never full session Profiles", async () => {
  const h = harness({}),
    key = "jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  h.session[key] = [{ question: "Synthetic", response: "Unsent" }];
  h.session.jobsManagementBaseV1 = { [key]: { value: [], revision: 2 } };
  h.session.profile_7 = { profile: { secret: "MUST NOT READ" } };
  h.session.jobsDiagnosticsV1 = { raw: "MUST NOT READ" };
  const selected = [];
  h.c.chrome.storage.session.get = async (keys) => {
    assert.ok(Array.isArray(keys));
    assert.ok(
      keys.every((name) => name === key || name === "jobsManagementBaseV1"),
    );
    selected.push(...keys);
    return Object.fromEntries(
      keys.map((name) => [name, structuredClone(h.session[name])]),
    );
  };
  for (const name of ["response-contract", "management-model"])
    vm.runInContext(
      await readModule(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
      h.c,
    );
  vm.runInContext(source["document-store"], h.c);
  const result = await h.c.JobsDocumentStore.pendingSnapshot();
  assert.deepEqual([...selected].sort(), [key, "jobsManagementBaseV1"].sort());
  assert.equal(result[key][0].response, "Unsent");
  assert.ok(!JSON.stringify(result).includes("MUST NOT READ"));
  assert.equal(h.reads.length, 0);
});
test("blocked upgrade preserves receipt identity and allows its existing offline outbox retry", async () => {
  const h = harness(fixture.local);
  vm.runInContext(source.sync, h.c);
  await h.c.JobsSync.ready;
  const original = structuredClone(h.data.jobsSyncV1.outbox[0].payload);
  await h.c.JobsSync.flush();
  assert.deepEqual(h.data.jobsSyncV1.outbox[0].payload, original);
  assert.ok(h.network.length > 0);
  assert.ok(h.network.every((url) => url.endsWith("/api/extension/events")));
  for (const key of fixture.expected.preserve.filter(
    (key) => key !== "jobsSyncV1",
  ))
    assert.deepEqual(h.data[key], fixture.local[key]);
  for (const key of Object.keys(fixture.local).filter(
    (key) => !fixture.expected.preserve.includes(key),
  ))
    assert.deepEqual(h.data[key], fixture.local[key]);
});
