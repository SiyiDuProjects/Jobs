import test from "node:test";
import assert from "node:assert/strict";
import { createMigration } from "../source/storage-migration/worker.js";
import {
  fingerprint,
  hashText,
  removePointer,
} from "../source/storage-migration/codec.js";
import { quiesce } from "../source/storage-migration/contexts.js";
import { MIGRATION_JOURNAL } from "../src/custom/migration-maintenance.js";
import { JobsStorageMigrationPolicy as policy } from "../src/custom/storage-migration-policy.js";
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  key = "jobsResponses:" + id;
const sender = {
  id: "fixture",
  url: "chrome-extension://fixture/migration.html",
  tab: { id: 4 },
  frameId: 0,
  documentId: "document-4",
};
function storageArea(initial = {}) {
  const values = structuredClone(initial),
    operations = [];
  return {
    values,
    operations,
    getKeys: async () => Object.keys(values),
    getBytesInUse: async (keys) =>
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            [keys]
              .flat()
              .filter((name) => Object.hasOwn(values, name))
              .map((name) => [name, values[name]]),
          ),
        ),
      ).length,
    async get(keys) {
      assert.notEqual(
        keys,
        null,
        "migration does not read an unbounded storage area",
      );
      operations.push(["get", keys]);
      return structuredClone(
        Object.fromEntries(
          [keys]
            .flat()
            .filter((name) => Object.hasOwn(values, name))
            .map((name) => [name, values[name]]),
        ),
      );
    },
    async set(update) {
      operations.push(["set", Object.keys(update)]);
      Object.assign(values, structuredClone(update));
    },
    async remove(keys) {
      operations.push(["remove", keys]);
      for (const name of [keys].flat()) delete values[name];
    },
    async clear() {
      throw Error("Whole-storage clear is prohibited");
    },
  };
}
function fixture(options = {}) {
  const operational = {
    jobsSyncV1: {
      deviceId: "synthetic-device",
      outbox: [{ event_id: "same-event", proof: "submit_attempt" }],
      token: "SYNTHETIC-DO-NOT-UPLOAD",
    },
    jobsSubmissionGuardsV1: { job: { state: "uncertain" } },
    autofillAccount: { accountPassword: "SYNTHETIC-DO-NOT-UPLOAD" },
  };
  const local = storageArea({
    ...operational,
    profile: {
      profileName: "Synthetic",
      applicationData: { aiNotes: "PRIVATE SOURCE VALUE" },
    },
    ...options.local,
  });
  const session = storageArea(options.session),
    calls = [],
    uploads = new Map();
  let server,
    manifest,
    online = true,
    activeUploads = 0,
    maxUploads = 0,
    views = 2,
    lostAck = false,
    backupCorrupt = false,
    freeze = false;
  const permits = new Map();
  const makeSession = () => structuredClone(server);
  const makePlan = () => ({
    migrationId: server.migrationId,
    manifestHash: server.manifestHash,
    revision: 1,
    phase: options.conflict ? "required_input" : "ready_to_apply",
    conflicts: options.conflict
      ? [
          {
            id: "fact",
            kind: "profile_fact",
            entryIds: [manifest.entries[0].entryId],
            title: "请选择现行事实",
            detail: "两处内容不同",
            choices: [{ id: "keep-source", label: "采用本地事实" }],
          },
        ]
      : [],
    operations: [],
  });
  const remote = async (path, method = "GET", body) => {
    calls.push({ path, method, body: structuredClone(body) });
    if (!online) throw Error("Synthetic offline");
    if (path === policy.prefix) {
      const incoming = JSON.parse(body.manifestText);
      assert.equal(body.manifestHash, await hashText(body.manifestText));
      assert.equal(body.protocolVersion, policy.version);
      assert.equal(incoming.inventoryVersion, policy.version);
      if (server) {
        assert.equal(body.manifestHash, server.manifestHash);
        return makeSession();
      }
      manifest = incoming;
      server = {
        migrationId: incoming.migrationId,
        deviceId: "synthetic-device",
        manifestHash: body.manifestHash,
        clientBuild: incoming.clientBuild,
        phase: "receiving",
        uploaded: [],
        cleaned: [],
      };
      return makeSession();
    }
    const suffix = path.slice(
      (policy.prefix + "/" + server.migrationId).length,
    );
    if (!suffix) return makeSession();
    if (suffix.startsWith("/entries/")) {
      activeUploads++;
      maxUploads = Math.max(maxUploads, activeUploads);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const entryId = suffix.split("/").at(-1),
          entry = manifest.entries.find((item) => item.entryId === entryId);
        assert.equal(body.sha256, await hashText(body.jsonText));
        assert.equal(body.sha256, entry.sha256);
        uploads.set(entryId, structuredClone(body));
        server.uploaded.push(entryId);
        return {
          migrationId: server.migrationId,
          entryId,
          sha256: body.sha256,
          size: body.size,
          stored: true,
        };
      } finally {
        activeUploads--;
      }
    }
    if (suffix === "/seal") {
      assert.equal(uploads.size, manifest.entries.length);
      server.phase = options.conflict ? "required_input" : "ready_to_apply";
      server.backup = {
        backupId: "backup-1",
        migrationId: server.migrationId,
        deviceId: server.deviceId,
        manifestHash: server.manifestHash,
        serverManifestHash: "c".repeat(64),
        durable: true,
        restoreVerified: !backupCorrupt,
        entries: manifest.entries.map(({ entryId, size, sha256 }) => ({
          entryId,
          size,
          sha256,
        })),
        serverEntries: [],
      };
      return makeSession();
    }
    if (suffix === "/plan") return makePlan();
    if (suffix === "/resolve") {
      assert.equal(body.planRevision, 1);
      assert.equal(body.choiceId, "keep-source");
      options.conflict = false;
      server.phase = "ready_to_apply";
      return makePlan();
    }
    if (suffix === "/apply") {
      assert.ok(!options.conflict);
      server.phase = "applying";
      server.planRevision = 1;
      if (options.loseApply) {
        options.loseApply = false;
        throw Error("Synthetic lost apply reply");
      }
      return makeSession();
    }
    if (suffix === "/verify") {
      server.phase = "ready_to_clean";
      return makeSession();
    }
    if (suffix === "/cleanup-claim") {
      assert.ok(["ready_to_clean", "cleaning"].includes(server.phase));
      const entry = manifest.entries.find(
        (item) => item.entryId === body.entryId,
      );
      if (body.observedState === "session_absent")
        assert.equal(entry.storageArea, "session");
      const permit = {
        ...structuredClone(server),
        permitId: "permit-" + entry.entryId,
        backupId: server.backup.backupId,
        entryId: entry.entryId,
        selector: entry.selector,
        sha256: entry.sha256,
        disposition: entry.disposition,
        observedState: body.observedState,
        expiresAt: Date.now() + 60000,
        ...(entry.pointer
          ? { containerBeforeSha256: body.containerBeforeSha256 }
          : {}),
      };
      delete permit.backup;
      delete permit.uploaded;
      delete permit.cleaned;
      permits.set(permit.permitId, permit);
      return permit;
    }
    if (suffix === "/cleanup-ack") {
      assert.ok(permits.has(body.permitId));
      if (lostAck) {
        lostAck = false;
        throw Error("Synthetic lost acknowledgement");
      }
      if (!server.cleaned.includes(body.entryId))
        server.cleaned.push(body.entryId);
      server.phase = "cleaning";
      return makeSession();
    }
    if (suffix === "/complete") {
      assert.equal(
        server.cleaned.length,
        manifest.entries.filter(
          (entry) => entry.disposition !== "retain_identity",
        ).length,
      );
      server.phase = "complete";
      return makeSession();
    }
    if (suffix === "/supersede") {
      server.phase = "superseded";
      return makeSession();
    }
    throw Error("Unexpected synthetic route " + suffix);
  };
  const dependencies = {
    storage: { local, session },
    build: "1234567890abcdef",
    identity: async () => ({ deviceId: "synthetic-device" }),
    remote: async (...args) => {
      const result = await remote(...args);
      await options.afterRemote?.(...args);
      return result;
    },
    maintenance: {
      async freeze() {
        freeze = true;
      },
      async finish() {
        freeze = false;
      },
    },
    stopPages: async () => {},
    pendingSnapshot: async () => structuredClone(options.pending || {}),
    quiesce: async () => {
      if (views !== 2)
        throw Object.assign(Error("Writer active"), {
          code: "migration_writer_active",
        });
    },
  };
  let worker = createMigration(dependencies);
  return {
    local,
    session,
    calls,
    uploads,
    operational,
    dependencies,
    handle: (...args) => worker.handle(...args),
    restart: () => {
      worker = createMigration(dependencies);
    },
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
    setViews: (value) => {
      views = value;
    },
    loseAck: () => {
      lostAck = true;
    },
    corruptBackup: () => {
      backupCorrupt = true;
    },
    get frozen() {
      return freeze;
    },
    get maxUploads() {
      return maxUploads;
    },
    get manifest() {
      return manifest;
    },
    get server() {
      return server;
    },
  };
}
async function ready(h) {
  await h.handle("start", sender);
  await h.handle("apply", sender, { planRevision: 1 });
}
async function finish(h) {
  for (let index = 0; index < 30; index++) {
    const result = await h.handle("cleanup", sender);
    if (result.status.phase === "complete") return;
  }
  throw Error("Migration did not complete");
}

test("explicit migration uploads serial exact bytes, never operational credentials, then cleans only proved sources", async () => {
  const h = fixture({
    local: {
      [key]: [{ question: "Synthetic", response: "Unacknowledged answer" }],
    },
  });
  await ready(h);
  assert.equal(h.maxUploads, 1);
  assert.ok(
    h.local.values.profile,
    "a verified backup alone does not delete a source",
  );
  assert.ok(!JSON.stringify(h.calls).includes("SYNTHETIC-DO-NOT-UPLOAD"));
  assert.ok(
    !JSON.stringify(h.local.values[MIGRATION_JOURNAL]).includes(
      "PRIVATE SOURCE VALUE",
    ),
  );
  await finish(h);
  assert.equal(h.local.values.profile, undefined);
  assert.equal(h.local.values[key], undefined);
  for (const [name, value] of Object.entries(h.operational))
    assert.deepEqual(h.local.values[name], value);
  assert.equal(h.frozen, false);
});
test("offline and failed restore leave all source values in place", async () => {
  for (const failure of ["offline", "corruptBackup"]) {
    const h = fixture();
    h[failure]();
    await assert.rejects(h.handle("start", sender));
    assert.equal(
      h.local.values.profile.applicationData.aiNotes,
      "PRIVATE SOURCE VALUE",
    );
    assert.ok(!h.local.operations.some(([action]) => action === "remove"));
  }
});
test("uncertain source facts require server-issued decisions before apply/cleanup", async () => {
  const h = fixture({ conflict: true });
  const result = await h.handle("start", sender);
  assert.equal(result.plan.phase, "required_input");
  await assert.rejects(
    h.handle("cleanup", sender),
    (error) => error.code === "migration_required_input",
  );
  assert.ok(h.local.values.profile);
  const resolved = await h.handle("resolve", sender, {
    planRevision: 1,
    conflictId: "fact",
    choiceId: "keep-source",
  });
  assert.equal(resolved.plan.phase, "ready_to_apply");
  await h.handle("apply", sender, { planRevision: 1 });
  await finish(h);
});
test("cleanup resumes after source removal and lost acknowledgement without replaying deletion", async () => {
  const h = fixture();
  await ready(h);
  h.loseAck();
  await assert.rejects(h.handle("cleanup", sender), /lost acknowledgement/);
  assert.equal(h.local.values.profile, undefined);
  const removals = h.local.operations.filter(
    ([action]) => action === "remove",
  ).length;
  h.restart();
  await finish(h);
  assert.equal(
    h.local.operations.filter(([action]) => action === "remove").length,
    removals,
  );
});
test("a changed/new local source or another trusted view prevents cleanup", async () => {
  for (const mode of ["changed", "new", "view"]) {
    const h = fixture();
    await ready(h);
    if (mode === "changed")
      h.local.values.profile.applicationData.aiNotes = "Newer fact";
    if (mode === "new") h.local.values.responseList = ["New answer"];
    if (mode === "view") h.setViews(3);
    await assert.rejects(h.handle("cleanup", sender));
    assert.ok(h.local.values.profile);
    assert.ok(!h.local.operations.some(([action]) => action === "remove"));
  }
});
test("settings and each preset remove only the approved path with chained whole-container hashes", async () => {
  const settings = {
    autofillSettings: { autoSubmit: false },
    premiumSettings: { responseContext: "Local notes", other: 7 },
  };
  const configList = [
    { configName: "A", ...structuredClone(settings) },
    {
      configName: "B",
      premiumSettings: { responseContext: "Other notes", enabled: true },
    },
  ];
  const h = fixture({ local: { settings, configList } });
  await ready(h);
  await finish(h);
  assert.deepEqual(
    h.local.values.settings,
    removePointer(settings, "/premiumSettings/responseContext"),
  );
  assert.deepEqual(
    h.local.values.configList,
    removePointer(
      removePointer(configList, "/0/premiumSettings/responseContext"),
      "/1/premiumSettings/responseContext",
    ),
  );
  const claims = h.calls.filter((call) => call.path.endsWith("/cleanup-claim"));
  const configEntries = h.manifest.entries.filter(
    (entry) => entry.storageKey === "configList",
  );
  const first = claims.find(
      (call) => call.body.entryId === configEntries[0].entryId,
    ),
    second = claims.find(
      (call) => call.body.entryId === configEntries[1].entryId,
    );
  assert.notEqual(
    first.body.containerBeforeSha256,
    second.body.containerBeforeSha256,
  );
});
test("same-named local/session responses remain distinct and session facts never enter local journal", async () => {
  const pending = {
    [key]: [{ question: "Pending", response: "SESSION PRIVATE" }],
    jobsManagementBaseV1: { [key]: { revision: 1, value: [] } },
  };
  const h = fixture({
    local: { [key]: [{ question: "Old", response: "LOCAL PRIVATE" }] },
    session: pending,
    pending,
  });
  await ready(h);
  assert.equal(
    h.manifest.entries.filter((entry) => entry.storageKey === key).length,
    2,
  );
  assert.ok(
    !JSON.stringify(h.local.values[MIGRATION_JOURNAL]).includes(
      "SESSION PRIVATE",
    ),
  );
  await finish(h);
  assert.equal(h.local.values[key], undefined);
  assert.equal(h.session.values[key], undefined);
  assert.equal(h.session.values.jobsManagementBaseV1, undefined);
});
test("Chrome-expired session sources use a distinct absence receipt only after backup and domain proof", async () => {
  const pending = {
    [key]: [{ question: "Pending", response: "SESSION PRIVATE" }],
  };
  const h = fixture({ session: pending, pending });
  await ready(h);
  delete h.session.values[key];
  h.restart();
  await finish(h);
  const receipt = h.calls.find(
    (call) =>
      call.path.endsWith("/cleanup-ack") &&
      call.body.result === "session_expired",
  );
  assert.ok(receipt);
  assert.ok(!h.session.operations.some(([action]) => action === "remove"));
});
test("session disappearance before durable upload is not a successful save", async () => {
  const pending = {
    [key]: [{ question: "Pending", response: "SESSION PRIVATE" }],
  };
  const h = fixture({ session: pending, pending });
  h.offline();
  await assert.rejects(h.handle("start", sender));
  delete h.session.values[key];
  h.online();
  h.restart();
  await assert.rejects(
    h.handle("resume", sender),
    (error) => error.code === "migration_source_changed",
  );
  assert.ok(h.local.values.profile);
  assert.ok(!h.calls.some((call) => call.path.endsWith("/cleanup-claim")));
});
test("an oversized or non-JSON value never obtains an upload/cleanup permission", async () => {
  await assert.rejects(
    fingerprint({ unsupported: Infinity }),
    (error) => error.code === "migration_invalid_source",
  );
  const value = {};
  value.loop = value;
  await assert.rejects(
    fingerprint(value),
    (error) => error.code === "migration_invalid_source",
  );
});
test("context enumeration treats TRUSTED_CONTEXTS as only one prerequisite", async () => {
  const worker = {
    contextType: "BACKGROUND",
    contextId: "worker",
    tabId: -1,
    frameId: -1,
    incognito: false,
  };
  const page = {
    contextType: "TAB",
    contextId: "page",
    documentId: sender.documentId,
    documentUrl: sender.url,
    tabId: sender.tab.id,
    frameId: 0,
    incognito: false,
  };
  let contexts = [worker, page],
    accesses = 0;
  const browser = {
    runtime: {
      id: "fixture",
      getURL: (path) => "chrome-extension://fixture/" + path,
      getContexts: async () => contexts,
    },
    storage: {
      local: {
        setAccessLevel: async ({ accessLevel }) => {
          assert.equal(accessLevel, "TRUSTED_CONTEXTS");
          accesses++;
        },
      },
    },
  };
  await quiesce(browser, sender);
  for (const type of [
    "POPUP",
    "OFFSCREEN_DOCUMENT",
    "DEVTOOLS",
    "SIDE_PANEL",
    "TAB",
  ]) {
    contexts = [
      worker,
      page,
      { contextType: type, contextId: "old", tabId: 9 },
    ];
    await assert.rejects(
      quiesce(browser, sender),
      (error) => error.code === "migration_writer_active",
    );
  }
  assert.equal(accesses, 6);
  contexts = [worker, page];
  await quiesce(browser, sender);
});

test("resume recovers interruption before manifest creation and after an applied change lost its reply", async () => {
  const h = fixture({ loseApply: true });
  h.setViews(3);
  await assert.rejects(h.handle("start", sender));
  assert.equal(h.local.values[MIGRATION_JOURNAL].phase, "maintenance");
  h.setViews(2);
  h.restart();
  await h.handle("resume", sender);
  await assert.rejects(
    h.handle("apply", sender, { planRevision: 1 }),
    /lost apply reply/,
  );
  assert.equal(h.server.phase, "applying");
  h.restart();
  const recovered = await h.handle("resume", sender);
  assert.equal(recovered.status.phase, "ready_to_clean");
  await finish(h);
});

test("a changed build can inspect and explicitly supersede but cannot clean with old permits", async () => {
  const h = fixture();
  await ready(h);
  h.dependencies.build = "fedcba0987654321";
  h.restart();
  assert.equal((await h.handle("status", sender)).buildChanged, true);
  await assert.rejects(
    h.handle("cleanup", sender),
    (error) => error.code === "migration_source_changed",
  );
  assert.ok(h.local.values.profile);
  await h.handle("supersede", sender);
  assert.equal(
    h.local.values[MIGRATION_JOURNAL].clientBuild,
    h.dependencies.build,
  );
  assert.equal(h.local.values[MIGRATION_JOURNAL].phase, "maintenance");
});

test("session absence is rechecked after claiming and cannot conceal a new pending answer", async () => {
  const pending = {
    [key]: [{ question: "Pending", response: "SESSION PRIVATE" }],
  };
  const options = { session: pending, pending };
  const h = fixture(options);
  await ready(h);
  delete h.session.values[key];
  options.afterRemote = async (path, method, body) => {
    if (
      path.endsWith("/cleanup-claim") &&
      body.observedState === "session_absent"
    )
      h.session.values[key] = structuredClone(pending[key]);
  };
  await assert.rejects(
    finish(h),
    (error) => error.code === "migration_source_changed",
  );
  assert.ok(h.session.values[key]);
  assert.ok(
    !h.calls.some(
      (call) =>
        call.path.endsWith("/cleanup-ack") &&
        call.body.result === "session_expired",
    ),
  );
});

test("Chrome storage property reordering preserves exact manifest bytes and recovery authority", async () => {
  const h = fixture();
  h.offline();
  await assert.rejects(h.handle("start", sender));
  const state = h.local.values[MIGRATION_JOURNAL],
    exact = state.manifestText;
  state.entries = state.entries.map((entry) =>
    Object.fromEntries(
      Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  h.online();
  h.restart();
  await h.handle("resume", sender);
  assert.equal(h.calls.at(1).body.manifestText, exact);
  await h.handle("apply", sender, { planRevision: 1 });
  await finish(h);
});

test("a completed migration cannot hide newly recreated local legacy facts or strand the explicit entry", async () => {
  const h = fixture();
  await ready(h);
  await finish(h);
  h.session.values.jobsManagementBaseV1 = {};
  assert.equal(
    (await h.handle("status", sender)).phase,
    "complete",
    "ordinary current session caches are not old local sources",
  );
  h.local.values.profile = { profileName: "New synthetic legacy fact" };
  assert.equal((await h.handle("status", sender)).phase, "not_started");
});
