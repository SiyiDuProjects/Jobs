import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const scripts = await Promise.all(
  [
    "private-session",
    "response-contract",
    "document-store",
    "management-model",
    "option-match",
    "profile-answers",
    "management-sync",
  ].map((n) =>
    readModule(new URL("../src/custom/" + n + ".js", import.meta.url), "utf8"),
  ),
);
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  intern = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const row = (title) => ({
  jobTitle: title,
  jobLink: "https://jobs.test/" + title,
  date: "2026-09-17",
  companyName: "Example",
  companyLink: "",
  status: "applied",
  profileName: "Newgrad",
});
function harness(initial = {}, remote = {}, profileById = {}) {
  const ephemeral = (k) =>
    k.startsWith("jobsResponses:") || k === "jobsManagementBaseV1";
  const durable = structuredClone(
    Object.fromEntries(
      Object.entries(initial).filter(([key]) => !ephemeral(key)),
    ),
  );
  const transient = structuredClone(
    Object.fromEntries(
      Object.entries(initial).filter(([key]) => ephemeral(key)),
    ),
  );
  transient.profile_1 = { id, profile: { profileName: "Newgrad" } };
  transient.profile_2 = { id: intern, profile: { profileName: "Intern" } };
  const listeners = [];
  let offline = false,
    race;
  const server = structuredClone(remote),
    requests = [];
  const storage = (data, name) => ({
    getKeys: async () => Object.keys(data),
    remove: async (keys) => {
      for (const key of [keys].flat()) delete data[key];
    },
    get: async (keys) =>
      keys == null
        ? structuredClone(data)
        : Object.fromEntries(
            [keys].flat().map((k) => [k, structuredClone(data[k])]),
          ),
    set: async (v) => {
      const changes = {};
      for (const [k, value] of Object.entries(v)) {
        changes[k] = { oldValue: data[k], newValue: value };
        data[k] = structuredClone(value);
      }
      listeners.forEach((f) => f(changes, name));
    },
  });
  const local = storage(durable, "local"),
    session = storage(transient, "session");
  const area = {
    set: async (values) => {
      await local.set(
        Object.fromEntries(
          Object.entries(values).filter(([key]) => !ephemeral(key)),
        ),
      );
      await session.set(
        Object.fromEntries(
          Object.entries(values).filter(([key]) => ephemeral(key)),
        ),
      );
    },
  };
  const c = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    chrome: {
      storage: {
        local,
        session,
        onChanged: { addListener: (f) => listeners.push(f) },
      },
      runtime: { id: "jobs", onMessage: { addListener() {} } },
      alarms: { onAlarm: { addListener() {} } },
    },
    console,
    URLSearchParams,
    Date,
    structuredClone,
    setTimeout: () => 0,
    clearTimeout() {},
    JobsResponseScope: { ready: Promise.resolve() },
    JobsSync: {
      ready: Promise.resolve(),
      profileRequest: async ({ path }) =>
        path === "/api/extension/profiles"
          ? [
              { id, profileName: "Newgrad" },
              { id: intern, profileName: "Intern" },
            ]
          : {
              id: path.includes(intern) ? intern : id,
              profile: profileById[path.includes(intern) ? intern : id] || {
                profileName: path.includes(intern) ? "Intern" : "Newgrad",
              },
              last_sync: "2026-09-17T00:00:00Z",
            },
      managementRequest: async (method, body) => {
        if (offline) throw Error("offline");
        requests.push({ method, body: structuredClone(body) });
        if (method === "POST") {
          for (const item of body.changes) {
            if ((server[item.key]?.revision || 0) !== item.revision)
              throw Error("Conflict");
            server[item.key] = {
              value: structuredClone(item.value),
              revision: item.revision + 1,
            };
          }
          if (race) {
            const f = race;
            race = undefined;
            await f(area);
          }
        }
        return structuredClone(server);
      },
    },
  });
  scripts.forEach((s) => vm.runInContext(s, c));
  return {
    get data() {
      return { ...durable, ...transient };
    },
    local: durable,
    session: transient,
    server,
    requests,
    area,
    sync: c.JobsManagementSync.sync,
    profiles: c.JobsManagementSync.profiles,
    forProfile: c.JobsManagementSync.forProfile,
    sessionArea: session,
    prune: c.JobsDocumentStore.pruneResponses,
    commit: c.JobsDocumentStore.commit,
    pending: c.JobsDocumentStore.hasPendingResponses,
    prepareConnectionChange: c.JobsManagementSync.prepareConnectionChange,
    privateSession: c.JobsPrivateSession,
    transport: c.JobsSync,
    offline: (v) => {
      offline = v;
    },
    race: (f) => {
      race = f;
    },
  };
}
const saved = (key, response) => ({
  key,
  keywords: [key.toLowerCase()],
  appearances: 1,
  fromAutofill: false,
  response,
});

test("profile synchronization prefetches identity metadata without downloading full facts or retaining the old global cache", async () => {
  const h = harness();
  h.session.jobsProfilesCache = {
    [id]: { profile: { resumeData: { resumeBase64: "PRIVATE" } } },
  };
  const paths = [];
  h.transport.profileRequest = async ({ path }) => {
    paths.push(path);
    assert.equal(path, "/api/extension/profiles");
    return [{ id, profileName: "Newgrad", last_sync: "version" }];
  };
  await h.profiles();
  assert.deepEqual(paths, ["/api/extension/profiles"]);
  assert.equal(h.session.jobsProfilesCache, undefined);
  assert.equal(h.session.jobsProfilesList[0].id, id);
  assert(!JSON.stringify(h.session).includes("PRIVATE"));
});

test("a late Profile list or saved-answer sync cannot restore session facts after connection reset", async () => {
  for (const source of ["profiles", "answers"]) {
    const h = harness();
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const called = new Promise((resolve) => {
      started = resolve;
    });
    if (source === "profiles")
      h.transport.profileRequest = async () => {
        started();
        return held;
      };
    else
      h.transport.managementRequest = async () => {
        started();
        return held;
      };
    const pending = source === "profiles" ? h.profiles() : h.sync();
    await called;
    await h.privateSession.clear();
    release(
      source === "profiles"
        ? [{ id, profileName: "Old connection" }]
        : {
            ["jobsResponses:" + id]: {
              value: [saved("Private question", "PRIVATE")],
              revision: 1,
            },
          },
    );
    if (source === "profiles") await assert.rejects(pending, /连接已改变/);
    else assert.equal((await pending).ok, false);
    assert.equal(h.session.jobsProfilesList, undefined);
    assert.equal(h.session.jobsManagementBaseV1, undefined);
    assert.equal(h.session["jobsResponses:" + id], undefined);
  }
});

test("confirmed answers and their baselines are retained only while a Profile has active pages", async () => {
  const key = "jobsResponses:" + id,
    other = "jobsResponses:" + intern;
  const h = harness(
    {},
    {
      [key]: { value: [saved("First", "Private first")], revision: 1 },
      [other]: { value: [saved("Second", "Private second")], revision: 1 },
    },
  );
  await h.sync();
  assert(h.session[key] && h.session[other]);
  delete h.session.profile_1;
  await h.prune();
  assert.equal(h.session[key], undefined);
  assert.equal(h.session.jobsManagementBaseV1[key], undefined);
  assert(h.session[other]);
  delete h.session.profile_2;
  await h.prune();
  assert.equal(h.session[other], undefined);
  assert.equal(h.session.jobsManagementBaseV1[other], undefined);
});

test("closing an offline page preserves unacknowledged edits, prevents silent disconnect loss and releases them after acknowledgement", async () => {
  const key = "jobsResponses:" + id,
    original = saved("Question", "Old confirmed"),
    edited = saved("Question", "New draft");
  const h = harness(
    {
      [key]: [original],
      jobsManagementBaseV1: { [key]: { value: [original], revision: 1 } },
    },
    { [key]: { value: [original], revision: 1 } },
  );
  await h.area.set({ [key]: [edited] });
  delete h.session.profile_1;
  h.offline(true);
  await h.prune();
  assert.deepEqual(h.session[key], [edited]);
  assert.equal(await h.pending(), true);
  await assert.rejects(h.prepareConnectionChange(), /尚未同步/);
  assert.deepEqual(h.session[key], [edited]);
  h.offline(false);
  await h.prepareConnectionChange();
  assert.deepEqual(h.server[key].value, [edited]);
  assert.equal(h.session[key], undefined);
  assert.equal(h.session.jobsManagementBaseV1[key], undefined);
  assert.equal(await h.pending(), false);
});

test("a newer edit arriving during acknowledgement survives inactive-page cleanup until its own upload", async () => {
  const key = "jobsResponses:" + id,
    first = saved("Question", "First draft"),
    later = saved("Question", "Later draft");
  const h = harness({ [key]: [first] });
  delete h.session.profile_1;
  h.race((area) => area.set({ [key]: [later] }));
  assert.equal((await h.sync()).pending, true);
  assert.deepEqual(h.session[key], [later]);
  assert.deepEqual(h.server[key].value, [first]);
  await h.sync();
  assert.deepEqual(h.server[key].value, [later]);
  assert.equal(h.session[key], undefined);
});

test("idle synchronization does not materialize personal answers for inactive Profiles", async () => {
  const key = "jobsResponses:" + id;
  const h = harness(
    {},
    {
      [key]: {
        value: [saved("question", "Confirmed private answer")],
        revision: 1,
      },
    },
  );
  delete h.session.profile_1;
  delete h.session.profile_2;
  await h.sync();
  assert.equal(h.session[key], undefined);
  assert.equal(h.session.jobsManagementBaseV1[key], undefined);
  assert.equal(await h.pending(), false);
});

test("a tab binding created after an in-flight sync selected its scopes obtains saved answers before filling", async () => {
  const key = "jobsResponses:" + id;
  const h = harness(
    {},
    {
      [key]: {
        value: [saved("question", "Confirmed private answer")],
        revision: 1,
      },
    },
  );
  delete h.session.profile_1;
  delete h.session.profile_2;
  const originalSet = h.sessionArea.set;
  let release, reached;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const barrier = new Promise((resolve) => {
    reached = resolve;
  });
  let first = true;
  h.sessionArea.set = async (values) => {
    if (first && values.jobsManagementBaseV1) {
      first = false;
      reached();
      await held;
    }
    return originalSet(values);
  };
  const existing = h.sync();
  await barrier;
  h.session.profile_4 = { id, profile: {} };
  const binding = h.forProfile(id);
  release();
  await existing;
  assert.equal((await binding).ok, true);
  assert.equal(h.session[key][0].response, "Confirmed private answer");
  assert.equal(h.requests.filter((row) => row.method === "GET").length, 2);
});
test("sync publishes current documents without uploading credentials or rewriting retired application lists", async () => {
  const initial = [row("Software Intern"), row("Software Engineer")],
    key = "jobsResponses:" + id;
  const h = harness({
    appliedList: initial,
    [key]: [saved("team", "Fixture team")],
    jobsSyncV1: { token: "PRIVATE" },
    autofillAccount: { accountPassword: "PRIVATE" },
  });
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.data.appliedList, initial);
  assert.equal(h.server.appliedList, undefined);
  assert.equal(h.data.jobsManagementBeforeMigrationV1, undefined);
  assert.deepEqual(h.server[key].value, [saved("team", "Fixture team")]);
  assert.equal(h.local[key], undefined);
  assert.equal(h.local.jobsManagementBaseV1, undefined);
  assert.deepEqual(h.session[key], h.server[key].value);
  assert(!JSON.stringify(h.requests).includes("PRIVATE"));
});

test("offline edit survives worker restart and merges independent website edits without deletion", async () => {
  const key = "jobsResponses:" + id,
    first = saved("a", "First"),
    local = saved("local", "Local"),
    website = saved("website", "Website");
  const h = harness({ [key]: [first] });
  await h.sync();
  h.offline(true);
  await h.area.set({ [key]: [first, local] });
  const failed = await h.sync();
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "offline");
  assert.equal(h.data.jobsManagementStatus.state, "error");
  const remote = structuredClone(h.server);
  remote[key].value.push(website);
  remote[key].revision++;
  const restart = harness(h.data, remote);
  await restart.sync();
  assert.equal(restart.data[key].length, 3);
  assert.equal(restart.server[key].value.length, 3);
  assert.equal(restart.local[key], undefined);
});

test("new answers learned during upload survive and are sent in the next exchange", async () => {
  const key = "jobsResponses:" + id,
    first = {
      key: "a",
      keywords: ["a"],
      appearances: 1,
      fromAutofill: false,
      response: "First",
    };
  const h = harness({ [key]: [first] });
  h.race((area) =>
    area.set({
      [key]: [
        first,
        {
          key: "b",
          keywords: ["b"],
          appearances: 1,
          fromAutofill: false,
          response: "Second",
        },
      ],
    }),
  );
  await h.sync();
  assert.equal(h.data[key].length, 2);
  assert.equal(h.data.jobsManagementStatus.state, "pending");
  await h.sync();
  assert.equal(h.server[key].value.length, 2);
});
test("conflicting same-answer edits preserve local, remote and last acknowledged state", async () => {
  const key = "jobsResponses:" + id;
  const h = harness({
    [key]: [
      {
        key: "a",
        response: "Before",
        keywords: ["a"],
        appearances: 1,
        fromAutofill: false,
      },
    ],
  });
  await h.sync();
  await h.area.set({
    [key]: [
      {
        key: "a",
        response: "Local",
        keywords: ["a"],
        appearances: 1,
        fromAutofill: false,
      },
    ],
  });
  h.server[key].value[0].response = "Remote";
  h.server[key].revision++;
  await h.sync();
  assert.equal(h.data.jobsManagementStatus.state, "error");
  assert.equal(h.data[key][0].response, "Local");
  assert.equal(h.server[key].value[0].response, "Remote");
});

test("answers learned during upload retain concurrent website additions in both copies", async () => {
  const key = "jobsResponses:" + id,
    a = {
      key: "a",
      keywords: ["a"],
      appearances: 1,
      fromAutofill: false,
      response: "Original",
    },
    local = {
      key: "local",
      keywords: ["local"],
      appearances: 1,
      fromAutofill: false,
      response: "Local",
    },
    remote = {
      key: "remote",
      keywords: ["remote"],
      appearances: 1,
      fromAutofill: false,
      response: "Website",
    },
    during = {
      key: "during",
      keywords: ["during"],
      appearances: 1,
      fromAutofill: false,
      response: "During upload",
    };
  const h = harness({ [key]: [a] });
  await h.sync();
  h.server[key].value.push(remote);
  h.server[key].revision++;
  await h.area.set({ [key]: [a, local] });
  h.race((area) => area.set({ [key]: [a, local, during] }));
  await h.sync();
  assert.deepEqual(
    new Set(h.data[key].map((r) => r.key)),
    new Set(["a", "local", "remote", "during"]),
  );
  assert.equal(h.data.jobsManagementStatus.state, "pending");
  await h.sync();
  assert.deepEqual(
    new Set(h.server[key].value.map((r) => r.key)),
    new Set(["a", "local", "remote", "during"]),
  );
});

test("fresh website values returned by an upload are pulled instead of becoming accidental local edits", async () => {
  const key = "jobsResponses:" + id,
    a = saved("a", "First"),
    b = saved("b", "Second");
  const h = harness({ [key]: [a], settings: { enabled: true } });
  await h.sync();
  await h.area.set({ [key]: [a, b] });
  h.race(() => {
    h.server.settings = {
      value: { enabled: false },
      revision: h.server.settings.revision + 1,
    };
  });
  await h.sync();
  assert.deepEqual(h.data.settings, { enabled: false });
  await h.sync();
  assert.deepEqual(h.server.settings.value, { enabled: false });
});

test("a response first learned during another document upload is reported as pending", async () => {
  const key = "jobsResponses:" + id,
    answer = {
      key: "new",
      keywords: ["new"],
      appearances: 1,
      fromAutofill: false,
      response: "New",
    };
  const h = harness({ settings: { enabled: true } });
  h.race((area) => area.set({ [key]: [answer] }));
  await h.sync();
  assert.equal(h.data.jobsManagementStatus.state, "pending");
  await h.sync();
  assert.deepEqual(h.server[key].value, [answer]);
});

test("repeated Profile refreshes retain matching and conflicting saved answers in their original scopes", async () => {
  const ngKey = "jobsResponses:" + id,
    internKey = "jobsResponses:" + intern;
  const response = (key, question, value) => ({
    key,
    question,
    response: value,
    keywords: [key.toLowerCase()],
    appearances: 1,
    fromAutofill: false,
  });
  const ng = [
    response("sponsorship", "Will you require sponsorship?", "No"),
    response("year", "Graduation year", "2028"),
    response("month", "Graduation month", "December"),
    response("day", "Graduation date (MM/DD/YYYY)", "05/18/2027"),
    response("matching", "Email", "newgrad@example.test"),
  ];
  const summer = [
    response("sponsorship", "Will you require sponsorship?", "Yes"),
    response("year", "Graduation year", "2027"),
    response("matching", "Email", "intern@example.test"),
  ];
  const profileById = {
    [id]: {
      profileName: "Newgrad",
      addressData: { country: "United States" },
      employmentData: { sponsorship: true },
      educationData: [{ endDate: "2027-05" }],
      contactData: { email: "newgrad@example.test" },
    },
    [intern]: {
      profileName: "Intern",
      addressData: { country: "United States" },
      employmentData: { sponsorship: false },
      educationData: [{ endDate: "2028-12" }],
      contactData: { email: "intern@example.test" },
    },
  };
  const legacyBackup = { untouched: ["previous migration backup"] };
  const h = harness(
    {
      [ngKey]: ng,
      [internKey]: summer,
      jobsResponsesBeforeProfileAdapterV1: legacyBackup,
    },
    {},
    profileById,
  );
  for (let pass = 0; pass < 3; pass++) assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.data[ngKey], ng);
  assert.deepEqual(h.server[ngKey].value, ng);
  assert.deepEqual(h.data[internKey], summer);
  assert.deepEqual(h.server[internKey].value, summer);
  assert.deepEqual(h.data.jobsResponsesBeforeProfileAdapterV1, legacyBackup);
  assert.equal(
    h.data.jobsManagementBeforeMigrationV1,
    undefined,
    "routine refresh creates no second personal-data backup",
  );
  assert.equal(h.local[ngKey], undefined);
  const restart = harness(h.data, h.server, profileById);
  assert.equal((await restart.sync()).ok, true);
  assert.deepEqual(restart.data[ngKey], ng);
  assert.deepEqual(restart.server[internKey].value, summer);
});

test("a newly mapped Profile field does not erase an existing cloud-only answer", async () => {
  const key = "jobsResponses:" + id,
    answer = {
      key: "start",
      question: "Earliest start date",
      response: "2027-06-01",
      keywords: ["start"],
      appearances: 2,
    };
  const h = harness(
    {},
    { [key]: { value: [answer], revision: 7 } },
    {
      [id]: {
        profileName: "Newgrad",
        applicationData: { earliestStartDate: "2027-05-17" },
      },
    },
  );
  assert.equal((await h.sync()).ok, true);
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.data[key], [answer]);
  assert.deepEqual(h.server[key].value, [answer]);
  assert.equal(
    h.server[key].revision,
    7,
    "normal refresh does not issue a deletion or rewrite",
  );
});

test("one damaged historical response cannot block valid answers or unrelated document sync", async () => {
  const key = "jobsResponses:" + id,
    good = {
      key: "name",
      keywords: ["全名"],
      appearances: 1,
      response: "Fixture",
      fromAutofill: false,
    };
  const bad = {
    key: "broken",
    keywords: [""],
    appearances: 1,
    response: "Old mistaken answer",
  };
  const h = harness({ [key]: [bad, null, good], settings: { fixture: 13 } });
  const result = await h.sync();
  assert.equal(result.ok, true);
  assert.equal(result.invalidResponses, 2);
  assert.deepEqual(h.server[key].value, [good]);
  assert.equal(h.server.settings.value.fixture, 13);
  assert.deepEqual(h.data[key], [good, bad, null]);
  assert.equal(h.local[key], undefined);
  assert.equal(h.data.jobsManagementBeforeMigrationV1, undefined);
  assert.equal((await h.sync()).ok, true);
  assert.equal(h.server[key].revision, 1);
  assert.equal(h.data.jobsManagementStatus.invalidResponses, 2);
});

test("cloud damaged entries remain in revisioned storage while valid local additions sync", async () => {
  const key = "jobsResponses:" + id,
    bad = {
      key: "damaged",
      keywords: [""],
      appearances: 1,
      response: "Legacy",
    };
  const good = {
    key: "valid",
    keywords: ["valid"],
    appearances: 1,
    response: "Valid",
    fromAutofill: false,
  };
  const h = harness({}, { [key]: { value: [bad], revision: 4 } });
  await h.sync();
  await h.area.set({ [key]: [bad, good] });
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.server[key].value, [good, bad]);
  assert.deepEqual(h.data[key], [good, bad]);
  assert.equal((await h.sync()).ok, true);
  assert.equal(h.server[key].revision, 5);
});

test("explicit removal of quarantined cloud history propagates and is not resurrected", async () => {
  const key = "jobsResponses:" + id,
    bad = {
      key: "damaged",
      keywords: [""],
      appearances: 1,
      response: "Legacy",
    };
  const h = harness({}, { [key]: { value: [bad], revision: 4 } });
  await h.sync();
  await h.area.set({ [key]: [] });
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.server[key].value, []);
  assert.deepEqual(h.data[key], []);
  assert.equal((await h.sync()).ok, true);
  assert.equal(h.server[key].revision, 5);
});

test("removing damaged history during another upload remains pending until the deletion is acknowledged", async () => {
  const key = "jobsResponses:" + id,
    bad = {
      key: "damaged",
      keywords: [""],
      appearances: 1,
      response: "Legacy",
    };
  const h = harness({}, { [key]: { value: [bad], revision: 4 } });
  await h.sync();
  await h.area.set({ settings: { fixture: 15 } });
  h.race((area) => area.set({ [key]: [] }));
  assert.equal((await h.sync()).pending, true);
  assert.deepEqual(h.data[key], []);
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.server[key].value, []);
});

test("a corrupt list container is preserved and cannot erase the cloud list or block other documents", async () => {
  const key = "jobsResponses:" + id,
    broken = { unexpected: "legacy format" },
    good = {
      key: "valid",
      keywords: ["valid"],
      appearances: 1,
      response: "Valid",
      fromAutofill: false,
    };
  const h = harness(
    { [key]: broken, settings: { fixture: 17 } },
    { [key]: { value: [good], revision: 4 } },
  );
  assert.equal((await h.sync()).ok, true);
  assert.deepEqual(h.data[key], broken);
  assert.deepEqual(h.server[key].value, [good]);
  assert.equal(h.server[key].revision, 4);
  assert.equal(h.server.settings.value.fixture, 17);
});
