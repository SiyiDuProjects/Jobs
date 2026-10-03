import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
const scripts = await Promise.all(
  ["private-session", "job-match", "management-model", "tab-profiles"].map(
    (n) =>
      readModule(
        new URL("../src/custom/" + n + ".js", import.meta.url),
        "utf8",
      ),
  ),
);
const matchRules = JSON.parse(
  await readModule(
    new URL(
      "../../../services/jobs-radar/jobs_radar/job_match_rules.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const profileReader = await readModule(
  new URL("../source/content/shared/profiles.js", import.meta.url),
  "utf8",
);
const contract = await readModule(
  new URL("../src/custom/profile-contract.js", import.meta.url),
  "utf8",
);
const minimalProfile = {
  nameData: {},
  addressData: {},
  contactData: {},
  jobData: [],
  educationData: [],
  languageData: [],
  resumeData: {},
  websiteData: {},
  employmentData: {},
  skillsData: [],
};
test("the actual adapter Profile reader starts a fresh round, validates facts and stops on sync errors", async () => {
  const profile = {
    ...minimalProfile,
    profileName: "Intern",
    applicationData: {
      aiNotes: "Confirmed facts",
      hasRelatedPeopleAtWork: false,
    },
  };
  let response = {
      data: { id: "intern", revision: "2026-09-20T01:00:00Z", profile },
    },
    sent = [],
    logged = [];
  const ctx = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    TextEncoder,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          return response;
        },
      },
    },
    JobsDiagnostics: { profile: (value) => logged.push(value) },
  });
  vm.runInContext(contract + "\n" + profileReader, ctx);
  assert.equal(await ctx.jobsGetProfile(), profile);
  assert.equal(sent[0].refresh, true);
  assert.equal(sent[0].type, "jobs:tab-profile");
  assert.equal(logged[0].profile.applicationData.aiNotes, "Confirmed facts");
  assert.equal(logged[0].revision, response.data.revision);
  response = { error: "无法获取最新 Profile" };
  await assert.rejects(ctx.jobsGetProfile(), /无法获取最新 Profile/);
  assert.equal(logged.length, 1);
  response = {
    data: { profile: { ...profile, employmentData: { sponsorship: "No" } } },
  };
  await assert.rejects(ctx.jobsGetProfile(), /employmentData.sponsorship/);
  assert.equal(logged.length, 1);
});
function setup(seed = {}, sessionSeed = {}, serverSeed = []) {
  const ng = {
      id: "ng",
      profile: {
        ...minimalProfile,
        profileName: "Newgrad",
        employmentData: { sponsorship: true },
      },
      last_sync: "2026-09-20T01:00:00Z",
    },
    intern = {
      id: "intern",
      profile: {
        ...minimalProfile,
        profileName: "Intern",
        employmentData: { sponsorship: false },
      },
      last_sync: "2026-09-20T01:00:00Z",
    };
  const seeded = structuredClone(seed),
    cache = seeded.jobsProfilesCache || { ng, intern },
    list = seeded.jobsProfilesList || [
      { id: "ng", profileName: "Newgrad" },
      { id: "intern", profileName: "Intern" },
    ];
  delete seeded.jobsProfilesCache;
  delete seeded.jobsProfilesList;
  const data = {
    jobsManualProfileDefault: { id: "ng", at: Date.now() },
    ...seeded,
  };
  const session = {
      jobsProfilesList: structuredClone(list),
      ...structuredClone(sessionSeed),
    },
    tabs = new Map([
      [1, { id: 1, url: "https://jobs.siyidu.com/", active: true }],
    ]),
    messages = [],
    updates = [],
    removed = [],
    created = [],
    activated = [],
    reloaded = [];
  let next = 2;
  const server = structuredClone(serverSeed);
  const area = (s) => ({
    getKeys: async () => Object.keys(s),
    get: async (keys) =>
      structuredClone(
        keys === null
          ? s
          : Object.fromEntries([keys].flat().map((k) => [k, s[k]])),
      ),
    set: async (v) => Object.assign(s, structuredClone(v)),
    remove: async (key) => {
      for (const k of [key].flat()) delete s[k];
    },
  });
  const chrome = {
    storage: { local: area(data), session: area(session) },
    runtime: {
      id: "jobs",
      getURL: (path) => "chrome-extension://jobs/" + path,
      onMessage: { addListener: (f) => messages.push(f) },
    },
    tabs: {
      get: async (id) => tabs.get(id),
      reload: async (id) => reloaded.push(id),
      create: async () => {
        throw Error("extension must not create navigation tabs");
      },
      update: async () => {
        throw Error("extension must not navigate tabs");
      },
      onActivated: { addListener: (f) => activated.push(f) },
      onUpdated: { addListener: (f) => updates.push(f) },
      onRemoved: { addListener: (f) => removed.push(f) },
      onCreated: { addListener: (f) => created.push(f) },
    },
  };
  const refresh = {
    profiles: async () => {
      session.jobsProfilesList = structuredClone(list);
      return session.jobsProfilesList;
    },
  };
  const cloud = structuredClone(cache),
    reads = [];
  const sync = {
    profileRequest: async ({ path }) => {
      assert.match(path, /^\/api\/extension\/profiles\/[^/]+$/);
      const id = decodeURIComponent(path.split("/").pop());
      reads.push(id);
      return structuredClone(cloud[id] || {});
    },
    resolveJob: async (url) => {
      const row = server.find((row) => c.JobsJobMatch.same(row.url, url));
      return row
        ? {
            state: "matched",
            job_id: row.jobId,
            kinds: row.kinds || [row.kind],
          }
        : { state: "unmatched" };
    },
  };
  const c = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    chrome,
    URL,
    URLSearchParams,
    Date,
    structuredClone,
    console,
    crypto: webcrypto,
    TextEncoder,
    JobsManagementSync: refresh,
    JobsSync: sync,
    JobsMatchRules: matchRules,
  });
  scripts.forEach((s) => vm.runInContext(s, c));
  const request = (m) => {
    if (m.type === "jobs:site-links")
      for (const row of m.links) server.push(structuredClone(row));
    return new Promise((resolve) =>
      messages[0](
        m,
        {
          id: "jobs",
          url: "https://jobs.siyidu.com/",
          tab: { id: 1 },
          frameId: 0,
        },
        resolve,
      ),
    );
  };
  return {
    data,
    session,
    server,
    tabs,
    chrome,
    cloud,
    reads,
    sync,
    scope: c.JobsTabProfiles,
    privateSession: c.JobsPrivateSession,
    updates,
    removed,
    created,
    refresh,
    reloaded,
    request,
    launch: async (m) => {
      await request({ type: "jobs:site-links", links: [m] });
      const tab = { id: next++, url: m.url, active: m.active !== false };
      if (tab.active)
        for (const existing of tabs.values()) existing.active = false;
      tabs.set(tab.id, tab);
      await created[0](tab);
      try {
        await c.JobsTabProfiles.ensure({ tab });
        return { data: { ok: true } };
      } catch (error) {
        return { error: error.message };
      }
    },
    activate: async (id) => {
      for (const tab of tabs.values()) tab.active = tab.id === id;
      for (const callback of activated) await callback({ tabId: id });
    },
    popup: (
      m,
      sender = { id: "jobs", url: "chrome-extension://jobs/popup.html" },
    ) =>
      new Promise((resolve) =>
        messages[0]({ type: "jobs:popup-profile", ...m }, sender, resolve),
      ),
  };
}

test("many tabs share one resume, retain exact versions, and release it with the last binding", async () => {
  const h = setup();
  const resume = "A".repeat(600000);
  h.cloud.ng.profile.resumeData = {
    resumeBase64: resume,
    fileName: "synthetic.pdf",
  };
  for (let id = 2; id <= 25; id++) {
    h.tabs.set(id, { id, url: "https://jobs.example/role/" + id });
    await h.scope.select(id, h.cloud.ng);
  }
  assert(Buffer.byteLength(JSON.stringify(h.session)) < 1000000);
  assert.equal(
    (await h.scope.selected(25)).profile.resumeData.resumeBase64,
    resume,
  );
  const opening = h.privateSession.readTab(25);
  await h.scope.releasePage(25);
  assert.equal(
    (await opening).profile_25.profile.resumeData.resumeBase64,
    resume,
  );
  await h.scope.select(25, h.cloud.ng);
  h.cloud.ng.profile.resumeData.resumeBase64 = "B".repeat(600000);
  h.cloud.ng.last_sync = "2026-09-30T01:00:00Z";
  await h.scope.select(2, h.cloud.ng);
  assert.equal(
    (await h.scope.selected(2)).profile.resumeData.resumeBase64,
    h.cloud.ng.profile.resumeData.resumeBase64,
  );
  assert.equal(
    (await h.scope.selected(25)).profile.resumeData.resumeBase64,
    resume,
  );
  for (let id = 3; id <= 25; id++) await h.scope.releasePage(id);
  assert(!JSON.stringify(h.session).includes(resume));
  assert.equal(
    (await h.scope.selected(2)).profile.resumeData.resumeBase64,
    h.cloud.ng.profile.resumeData.resumeBase64,
  );
  await h.scope.releasePage(2);
  assert(
    !JSON.stringify(h.session).includes(
      h.cloud.ng.profile.resumeData.resumeBase64,
    ),
  );
  assert(!JSON.stringify(h.data).includes("resumeBase64"));
});

test("a new run exposes its shared attachment identity and refuses a missing attachment", async () => {
  const h = setup();
  h.cloud.ng.profile.resumeData = { resumeBase64: "synthetic-resume" };
  const tab = { id: 2, url: "https://jobs.example/role" };
  h.tabs.set(2, tab);
  const value = await h.scope.context({ tab }, { refresh: true });
  assert(value.resumeRef);
  assert.equal(value.profile.resumeData.resumeBase64, "synthetic-resume");
  delete h.session.jobsSessionResumesV1;
  await assert.rejects(h.scope.selected(2), /简历缓存不可用/);
});

test("tab removal releases full facts and a late binding cannot repopulate a closed tab", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/private",
  });
  assert(h.session.profile_2.profile);
  h.tabs.delete(2);
  await h.removed[0](2, {});
  assert.equal(h.session.profile_2, undefined);
  assert.equal(h.session.jobsProfilesCache, undefined);
  h.tabs.set(8, { id: 8, url: "https://jobs.example/late" });
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const called = new Promise((resolve) => {
    started = resolve;
  });
  h.sync.profileRequest = async () => {
    started();
    return held;
  };
  const pending = h.scope.ensure({ tab: { id: 8 } });
  await called;
  h.tabs.delete(8);
  const closed = h.removed[0](8, {});
  release(h.cloud.ng);
  await assert.rejects(pending, /已关闭/);
  await closed;
  assert.equal(h.session.profile_8, undefined);
});

test("a late tab Profile response cannot rebind facts after a connection reset", async () => {
  const h = setup();
  h.tabs.set(8, { id: 8, url: "https://jobs.example/late" });
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const called = new Promise((resolve) => {
    started = resolve;
  });
  h.sync.profileRequest = async () => {
    started();
    return held;
  };
  const pending = h.scope.ensure({ tab: { id: 8 } });
  await called;
  await h.privateSession.clear();
  release(h.cloud.ng);
  await assert.rejects(pending, /连接已改变/);
  assert.equal(h.session.profile_8, undefined);
  assert.equal(h.data.jobsTabProfileRecoveryV2, undefined);
});

test("same-tab known job changes rebind identity and responses, while same-job manual overrides survive", async () => {
  const h = setup(),
    a = "a".repeat(24),
    b = "b".repeat(24),
    urlA = "https://ats.example/intern",
    urlB = "https://ats.example/newgrad";
  await h.launch({ kind: "intern", jobId: a, url: urlA });
  await h.request({
    type: "jobs:site-links",
    links: [{ kind: "newgrad", jobId: b, url: urlB }],
  });
  const tab = h.tabs.get(2);
  tab.url = urlB;
  await h.updates[0](2, { url: urlB }, tab);
  assert.equal((await h.scope.context({ tab }, { refresh: true })).id, "ng");
  assert.equal(h.session["jobsTabBinding:2"].websiteJobId, b);
  assert.equal(h.session["jobsResponseTab:2"], "ng");
  await h.scope.select(2, h.cloud.intern);
  assert.equal(
    (await h.scope.ensure({ tab })).id,
    "intern",
    "manual choice within B remains",
  );
  tab.url = "https://login.example/redirect";
  await h.updates[0](2, { url: tab.url }, tab);
  assert.equal(h.session.profile_2.id, "intern");
  assert.equal(h.session["jobsTabBinding:2"].websiteJobId, b);
  tab.url = urlA;
  await h.updates[0](2, { url: urlA }, tab);
  assert.equal(h.session["jobsTabBinding:2"].websiteJobId, a);
  tab.url = urlB;
  await h.updates[0](2, { url: urlB }, tab);
  assert.equal(
    h.session.profile_2.id,
    "ng",
    "return to a different job uses that job pool",
  );
});

test("the manual default persists while known jobs keep their independent bound Profiles", async () => {
  const h = setup();
  await h.popup({
    action: "select",
    kind: "intern",
    tabId: 1,
    url: h.tabs.get(1).url,
  });
  assert.equal(h.data.jobsManualProfileDefault.id, "intern");
  assert.equal(h.reloaded.length, 0);
  await h.launch({
    kind: "newgrad",
    jobId: "a".repeat(24),
    url: "https://ats.example/ng",
    active: false,
  });
  assert.equal(
    h.data.jobsManualProfileDefault.id,
    "intern",
    "background batch launch does not move the switch",
  );
  await h.activate(2);
  assert.equal(h.data.jobsManualProfileDefault.id, "intern");
  assert.equal(
    (await h.popup({ action: "read", tabId: 2 })).data.source,
    "resolved",
  );
  await h.activate(1);
  assert.equal(
    h.data.jobsManualProfileDefault.id,
    "intern",
    "the manual default is independent of active job tabs",
  );
  h.tabs.set(50, { id: 50, url: "https://ats.example/unknown" });
  await h.scope.ensure({ tab: { id: 50 } });
  await h.popup({
    action: "select",
    kind: "intern",
    tabId: 1,
    url: h.tabs.get(1).url,
  });
  await h.activate(50);
  assert.equal(
    h.data.jobsManualProfileDefault.id,
    "intern",
    "old default snapshots are not automatic conditions",
  );
  // An unknown page takes the last MANUAL choice (Intern), not the job tab viewed last.
  assert.equal(h.session.profile_50.id, "intern");
  assert.equal(h.session.profile_2.id, "ng");
  const view = await h.popup({ action: "read", tabId: 50 });
  assert.equal(view.data.kind, "intern", "popup shows the current tab binding");
});

test("popup does not claim an unsupported page uses the global default Profile", async () => {
  const h = setup({
    jobsManualProfileDefault: { id: "intern", at: Date.now() },
  });
  h.tabs.set(20, {
    id: 20,
    url: "https://account.amazon.jobs/en-US/applicant/jobs/10560727/apply",
  });
  const view = await h.popup({ action: "read", tabId: 20 });
  assert.equal(view.data.kind, "intern");
  assert.equal(view.data.bound, false);
  assert.equal(h.session.profile_20, undefined);
  await h.launch({
    kind: "newgrad",
    jobId: "a".repeat(24),
    url: "https://ats.example/newgrad",
  });
  const actual = await h.popup({ action: "read", tabId: 2 });
  assert.equal(actual.data.bound, true);
  assert.equal(actual.data.kind, "newgrad");
  assert.equal(h.data.jobsManualProfileDefault.id, "intern");
});

for (const url of [
  "https://account.amazon.jobs/en-US/applicant/jobs/10560727/apply",
  "https://jobs.smartrecruiters.com/oneclick-ui/company/CityAndCountyOfSanFrancisco1/publication/561ac7c2-45ee-4963-b795-eff748c72891/screening",
]) {
  test(
    "popup matches the listed job pool without an adapter: " +
      new URL(url).hostname,
    async () => {
      const job = "b".repeat(24);
      const h = setup(
        { jobsManualProfileDefault: { id: "intern", at: Date.now() } },
        {},
        [{ jobId: job, kind: "newgrad", url }],
      );
      h.tabs.set(20, { id: 20, url });
      // No content script or tab-created event has run (e.g. extension reload).
      const view = await h.popup({ action: "read", tabId: 20 });
      assert.equal(view.data.bound, true);
      assert.equal(view.data.kind, "newgrad");
      assert.equal(view.data.source, "resolved");
      assert.equal(h.session["jobsTabBinding:20"].websiteJobId, job);
      assert.equal(h.data.jobsManualProfileDefault.id, "intern");
      assert.deepEqual(h.reloaded, [], "matching never restarts the live form");
    },
  );
}

test("popup retries a failed job lookup and upgrades a default binding when the server recovers", async () => {
  const h = setup({
    jobsManualProfileDefault: { id: "intern", at: Date.now() },
  });
  const tab = {
    id: 20,
    url: "https://account.amazon.jobs/en-US/applicant/jobs/10560727/apply",
  };
  h.tabs.set(20, tab);
  h.sync.resolveJob = async () => {
    throw Error("offline");
  };
  await h.scope.ensure({ tab });
  assert.equal(h.session.profile_20.id, "intern");
  h.sync.resolveJob = async () => ({
    state: "matched",
    job_id: "b".repeat(24),
    kinds: ["newgrad"],
  });
  const view = await h.popup({ action: "read", tabId: 20 });
  assert.equal(view.data.kind, "newgrad");
  assert.equal(view.data.source, "resolved");
  assert.deepEqual(h.reloaded, []);
});

test("native context-menu open and a destination racing metadata registration select the right cached Profile without navigation APIs", async () => {
  const h = setup();
  const registering = h.request({
    type: "jobs:site-links",
    links: [
      {
        kind: "intern",
        jobId: "c".repeat(24),
        url: "https://ats.example/native",
      },
    ],
  });
  const tab = {
    id: 80,
    url: "about:blank",
    pendingUrl: "https://ats.example/native",
    active: false,
  };
  h.tabs.set(80, tab);
  await Promise.all([registering, h.created[0](tab)]);
  assert.equal(h.session.profile_80.id, "intern");
  assert.equal(h.data.jobsManualProfileDefault.id, "ng");
  tab.url = "https://different-ats.example/apply";
  delete tab.pendingUrl;
  await h.updates[0](80, { url: tab.url }, tab);
  assert.equal(h.session.profile_80.id, "intern");
  assert.equal(h.session["jobsTabBinding:80"].websiteJobId, "c".repeat(24));
});

test("manual current-application selection updates only that binding without reloading the form", async () => {
  const h = setup();
  await h.launch({
    kind: "newgrad",
    jobId: "a".repeat(24),
    url: "https://ats.example/ng",
  });
  const result = await h.popup({
    action: "select",
    kind: "intern",
    tabId: 2,
    url: h.tabs.get(2).url,
  });
  assert.equal(result.data.kind, "intern");
  assert.equal(h.session.profile_2.id, "intern");
  assert.deepEqual(h.reloaded, []);
  h.tabs.get(2).url = "https://ats.example/application";
  await h.updates[0](2, { url: h.tabs.get(2).url }, h.tabs.get(2));
  assert.equal(h.data.jobsManualProfileDefault.id, "intern");
  const denied = await h.popup(
    { action: "select", kind: "newgrad" },
    { id: "jobs", tab: { id: 2 }, url: "https://ats.example/application" },
  );
  assert.match(denied.error, /Invalid popup/);
  assert.equal(h.data.jobsManualProfileDefault.id, "intern");
  h.tabs.set(9, { id: 9, url: "chrome://extensions/" });
  assert.equal(
    (await h.popup({ action: "read", tabId: 9 })).data.kind,
    "intern",
  );
});
test("17 simultaneous newgrad tabs plus internships stay bound across refresh/cross-domain redirects and global switches", async () => {
  const h = setup();
  const outcomes = await Promise.all(
    Array.from({ length: 17 }, (_, i) =>
      h.launch({
        jobId: i.toString(16).padStart(24, "0"),
        kind: "newgrad",
        url: "https://jobs.example/job/" + i,
        active: false,
      }),
    ),
  );
  assert(outcomes.every((r) => r.data?.ok));
  await h.launch({
    jobId: "f".repeat(24),
    kind: "intern",
    url: "https://jobs.example/intern",
  });
  h.data.jobsManualProfileDefault = { id: "intern", at: Date.now() };
  for (let id = 2; id < 19; id++) {
    h.tabs.get(id).url = "https://other-ats.example/application/" + id;
    const p = await h.scope.ensure({ tab: { id }, url: h.tabs.get(id).url });
    assert.equal(p.id, "ng");
    assert.equal(p.profile.employmentData.sponsorship, true);
  }
  assert.equal((await h.scope.ensure({ tab: { id: 19 } })).id, "intern");
});
test("Apply child tab inherits its Profile identity before first fill; worker restart keeps the binding", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/1",
  });
  h.tabs.set(90, {
    id: 90,
    openerTabId: 2,
    url: "https://other-ats.example/apply",
  });
  assert.equal((await h.scope.ensure({ tab: { id: 90 } })).id, "intern");
  const restart = setup(h.data, h.session, h.server);
  restart.tabs.set(90, h.tabs.get(90));
  assert.equal((await restart.scope.ensure({ tab: { id: 90 } })).id, "intern");
});

test("an Apply child's first filling round refreshes inherited facts and revision from the cloud", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/inherited-facts",
  });
  const parent = await h.scope.selected(2);
  const readsBefore = h.reads.length;
  h.cloud.intern.profile.profileName = "Updated synthetic intern profile";
  h.cloud.intern.last_sync = "2026-09-20T02:00:00Z";
  const tab = {
    id: 90,
    openerTabId: 2,
    url: "https://other-ats.example/apply",
  };
  h.tabs.set(tab.id, tab);

  const current = await h.scope.context({ tab }, { refresh: true });

  assert.equal(current.id, "intern");
  assert.equal(current.profileName, h.cloud.intern.profile.profileName);
  assert.equal(current.revision, h.cloud.intern.last_sync);
  assert.equal(h.reads.length, readsBefore + 1);
  assert.equal(h.session["jobsTabBinding:90"].websiteJobId, "a".repeat(24));
  assert.equal((await h.scope.selected(2)).profileName, parent.profileName);
  assert.equal((await h.scope.selected(2)).lastSync, parent.lastSync);
});

test("an Apply child's first filling round rejects inherited facts when its cloud Profile is unavailable", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/inherited-offline",
  });
  const tab = {
    id: 90,
    openerTabId: 2,
    url: "https://other-ats.example/apply",
  };
  h.tabs.set(tab.id, tab);
  h.sync.profileRequest = async () => {
    throw Error("offline");
  };

  await assert.rejects(
    h.scope.context({ tab }, { refresh: true }),
    /无法获取最新 Profile/,
  );
  await assert.rejects(h.scope.context({ tab }), /尚未核对/);
});

test("an Apply child recovers its restored opener before the opener content script starts", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/restore-parent",
  });
  const restart = setup(h.data, {}, h.server);
  restart.tabs.set(80, { id: 80, url: "https://jobs.example/restore-parent" });
  restart.tabs.set(81, {
    id: 81,
    openerTabId: 80,
    url: "https://other-ats.example/application/unknown",
  });
  assert.equal((await restart.scope.ensure({ tab: { id: 81 } })).id, "intern");
  assert.equal(restart.session.profile_80.id, "intern");
  assert.equal(
    restart.session["jobsTabBinding:81"].websiteJobId,
    "a".repeat(24),
  );
});

test("parallel first-frame requests and an explicit override commit in order within one tab", async () => {
  const h = setup();
  h.tabs.set(30, { id: 30, url: "https://jobs.example/concurrent" });
  const original = h.chrome.storage.local.get;
  let release, started;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    blocked = new Promise((resolve) => {
      started = resolve;
    });
  let first = true;
  h.chrome.storage.local.get = async (keys) => {
    const value = await original(keys);
    if (
      first &&
      Array.isArray(keys) &&
      keys.includes("jobsManualProfileDefault")
    ) {
      first = false;
      started();
      await waiting;
    }
    return value;
  };
  const firstRead = h.scope.ensure({ tab: { id: 30 } });
  await blocked;
  const override = h.scope.select(30, h.cloud.intern);
  const frames = Array.from({ length: 8 }, () =>
    h.scope.ensure({ tab: { id: 30 } }),
  );
  release();
  assert.equal((await firstRead).id, "ng");
  await override;
  assert((await Promise.all(frames)).every((value) => value.id === "intern"));
  assert.equal(h.session.profile_30.id, "intern");
  assert.equal(h.data.jobsTabProfileRecoveryV2[30].id, "intern");
});

test("reused browser tab IDs never relabel a different old application URL", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/old-intern",
  });
  const restart = setup(h.data, {}, h.server);
  await restart.launch({
    kind: "newgrad",
    jobId: "b".repeat(24),
    url: "https://jobs.example/new-role",
  });
  assert.deepEqual(restart.data.jobsTabProfileRecoveryV2[2].urls, [
    "sha256:" +
      createHash("sha256")
        .update("https://jobs.example/new-role")
        .digest("hex"),
  ]);
  assert.equal(restart.data.jobsTabProfileRecoveryV2[2].id, "ng");
});
test("browser-restored exact URL recovers identity; ambiguous profiles stop rather than guess", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "b".repeat(24),
    url: "https://jobs.example/restore",
  });
  const restart = setup(h.data, {}, h.server);
  restart.tabs.set(80, { id: 80, url: "https://jobs.example/restore" });
  assert.equal((await restart.scope.ensure({ tab: { id: 80 } })).id, "intern");
  const records = structuredClone(h.data);
  records.jobsTabProfileRecoveryV2[4] = {
    ...records.jobsTabProfileRecoveryV2[2],
    id: "ng",
    profile: { profileName: "Newgrad" },
  };
  // Website links persist for 14 days; this case is a page whose link expired.
  delete records.jobsWebsiteLinksV2;
  const conflict = setup(records);
  conflict.tabs.set(80, { id: 80, url: "https://jobs.example/restore" });
  await assert.rejects(
    conflict.scope.ensure({ tab: { id: 80 } }),
    /多个资料身份/,
  );
});

test("new tabs fetch facts by pinned ID and share one current snapshot throughout a round", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/fresh",
  });
  const sender = { tab: { id: 2 } };
  const facts = {
    willingToRelocate: true,
    willingToWorkOnsite: true,
    hasRelatedPeopleAtWork: false,
    aiNotes: "Confirmed fixture facts",
  };
  h.cloud.intern.profile.applicationData = facts;
  const result = await h.scope.context(sender, { refresh: true });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.profile.applicationData)),
    facts,
  );
  assert.equal(result.id, "intern");
  assert.equal(result.revision, h.cloud.intern.last_sync);
  h.data.jobsManualProfileDefault = { id: "ng", at: Date.now() };
  const readsBeforeFields = [...h.reads];
  for (let i = 0; i < 5; i++)
    assert.equal((await h.scope.context(sender)).id, "intern");
  assert.deepEqual(
    h.reads,
    readsBeforeFields,
    "ordinary field reads reuse the round, not the network",
  );
  assert.equal(
    h.data.jobsTabProfileRecoveryV2[2].profile,
    undefined,
    "durable recovery stores no old content",
  );
  assert.equal(h.reloaded.length, 0);
});

test("legacy same-URL journals with different content restore one identity and fetch new cloud facts", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/legacy",
  });
  const old = h.data.jobsTabProfileRecoveryV2[2];
  old.profile = { profileName: "Intern" };
  h.data.jobsTabProfileRecoveryV2[3] = {
    ...structuredClone(old),
    profile: {
      profileName: "Intern",
      applicationData: { aiNotes: "outdated" },
    },
  };
  const restart = setup(h.data, {}, h.server);
  restart.tabs.set(80, { id: 80, url: "https://jobs.example/legacy" });
  restart.cloud.intern.profile.applicationData = {
    aiNotes: "Current complete notes",
  };
  const result = await restart.scope.context(
    { tab: { id: 80 } },
    { refresh: true },
  );
  assert.equal(result.id, "intern");
  assert.equal(
    result.profile.applicationData.aiNotes,
    "Current complete notes",
  );
  assert(
    Object.values(restart.data.jobsTabProfileRecoveryV2).every(
      (row) => !("profile" in row),
    ),
  );
  assert.equal(restart.reloaded.length, 0);
});

test("a cloud update stops the current round; an explicit new round uses the new facts without changing profile type", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/update",
  });
  const sender = { tab: { id: 2 } };
  await h.scope.context(sender, { refresh: true });
  const initial = structuredClone(h.session.profile_2.profile);
  h.cloud.intern.profile.applicationData = { willingToWorkOnsite: true };
  h.cloud.intern.last_sync = "2026-09-20T02:00:00Z";
  await assert.rejects(h.scope.verify(sender), /Profile 已更新/);
  assert.deepEqual(
    h.session.profile_2.profile,
    initial,
    "verification never swaps content during a round",
  );
  h.session.jobsProfilesList.find((row) => row.id === "intern").last_sync =
    h.cloud.intern.last_sync;
  await assert.rejects(h.scope.context(sender), /Profile 已更新/);
  const next = await h.scope.context(sender, { refresh: true });
  assert.equal(next.profile.applicationData.willingToWorkOnsite, true);
  assert.equal((await h.scope.verify(sender)).id, "intern");
  assert.equal(h.reloaded.length, 0);
});

test("offline and deleted Profiles never fall back to old cached or recovered answers", async () => {
  for (const offline of [true, false]) {
    const h = setup();
    await h.launch({
      kind: "intern",
      jobId: "a".repeat(24),
      url: "https://jobs.example/unavailable",
    });
    const sender = { tab: { id: 2 } };
    if (offline)
      h.sync.profileRequest = async () => {
        throw Error("offline");
      };
    else delete h.cloud.intern;
    await assert.rejects(
      h.scope.context(sender, { refresh: true }),
      offline ? /无法获取最新 Profile/ : /已删除或不可用/,
    );
    await assert.rejects(h.scope.context(sender), /尚未核对/);
    assert.equal(h.reloaded.length, 0);
  }
});

test("new round checks cannot overwrite a concurrent manual Profile identity change", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/race",
  });
  let release, entered;
  const started = new Promise((r) => (entered = r)),
    waiting = new Promise((r) => (release = r));
  const original = h.sync.profileRequest;
  h.sync.profileRequest = async (args) => {
    entered();
    await waiting;
    return original(args);
  };
  const fresh = h.scope.context({ tab: { id: 2 } }, { refresh: true });
  await started;
  const override = h.scope.select(2, h.cloud.ng);
  release();
  assert.equal((await fresh).id, "intern");
  await override;
  assert.equal(h.session.profile_2.id, "ng");
  assert.equal(h.data.jobsTabProfileRecoveryV2[2].id, "ng");
});
test("ordinary browsing is not pinned; missing mapping stops autofill but never native navigation", async () => {
  const h = setup({ jobsProfilesList: [{ id: "ng", profileName: "Renamed" }] });
  await h.scope.ensure({ tab: { id: 1 } }, false);
  assert.equal(h.session.profile_1, undefined);
  assert.equal(h.data.jobsTabProfileRecoveryV2, undefined);
  const result = await h.launch({
    jobId: "c".repeat(24),
    kind: "intern",
    url: "https://jobs.example/1",
  });
  assert.match(result.error, /未找到/);
  assert.equal(h.tabs.size, 2);
  assert.equal(h.tabs.get(2).url, "https://jobs.example/1");
  assert.equal(h.session.profile_2, undefined);
});

test("website list refresh cannot mutate an active tab; a failed list refresh preserves native links and fresh tab reads", async () => {
  const h = setup();
  await h.launch({
    jobId: "d".repeat(24),
    kind: "intern",
    url: "https://jobs.example/1",
  });
  h.refresh.profiles = async () => {
    h.cloud.intern.profile.employmentData.sponsorship = true;
    return h.session.jobsProfilesList;
  };
  await h.launch({
    jobId: "e".repeat(24),
    kind: "intern",
    url: "https://jobs.example/2",
  });
  assert.equal(h.session.profile_2.profile.employmentData.sponsorship, false);
  assert.equal(h.session.profile_3.profile.employmentData.sponsorship, true);
  h.refresh.profiles = async () => {
    throw Error("Server unavailable");
  };
  const result = await h.launch({
    jobId: "f".repeat(24),
    kind: "intern",
    url: "https://jobs.example/3",
  });
  assert.equal(result.data.ok, true);
  assert.equal(h.tabs.size, 4);
  assert.equal(h.session.profile_4.profile.employmentData.sponsorship, true);
});

test("browser shutdown retains recovery and an explicit tab override updates it immediately", async () => {
  const h = setup();
  await h.launch({
    jobId: "d".repeat(24),
    kind: "intern",
    url: "https://jobs.example/restore",
  });
  await h.scope.select(2, {
    id: "ng",
    profile: h.cloud.ng.profile,
  });
  await h.removed[0](2, { isWindowClosing: true });
  const restart = setup(h.data, {}, h.server);
  restart.tabs.set(50, { id: 50, url: "https://jobs.example/restore" });
  assert.equal((await restart.scope.ensure({ tab: { id: 50 } })).id, "ng");
  assert.equal(
    restart.session["jobsTabBinding:50"].websiteJobId,
    "d".repeat(24),
  );
  await restart.removed[0](50, { isWindowClosing: false });
  assert.equal(restart.data.jobsTabProfileRecoveryV2[50], undefined);
});

test("restoration distinguishes job query and hash routes, while ignoring tracking tags and retaining no raw tokens", async () => {
  for (const [internUrl, ngUrl] of [
    [
      "https://ats.example/careers?job=intern&token=PRIVATE_LOGIN",
      "https://ats.example/careers?job=ng&token=PRIVATE_LOGIN",
    ],
    ["https://ats.example/careers#/intern", "https://ats.example/careers#/ng"],
  ]) {
    const h = setup();
    await h.launch({ kind: "intern", jobId: "a".repeat(24), url: internUrl });
    await h.launch({ kind: "newgrad", jobId: "b".repeat(24), url: ngUrl });
    const restart = setup(h.data, {}, h.server);
    const tracked = new URL(internUrl);
    tracked.searchParams.set("utm_source", "test");
    restart.tabs.set(80, { id: 80, url: tracked.href });
    restart.tabs.set(81, { id: 81, url: ngUrl });
    assert.equal(
      (await restart.scope.ensure({ tab: { id: 80 } })).id,
      "intern",
    );
    assert.equal((await restart.scope.ensure({ tab: { id: 81 } })).id, "ng");
    assert(
      !JSON.stringify(h.data.jobsTabProfileRecoveryV2).includes(
        "PRIVATE_LOGIN",
      ),
    );
  }
});

test("Apply child captures its parent before first fill even when the parent closes, and an explicit website launch wins", async () => {
  const h = setup();
  await h.launch({
    kind: "intern",
    jobId: "a".repeat(24),
    url: "https://jobs.example/1",
  });
  const child = { id: 90, openerTabId: 2, url: "about:blank" };
  h.tabs.set(90, child);
  const capture = h.created[0](child);
  h.tabs.delete(2);
  await h.removed[0](2, { isWindowClosing: false });
  await capture;
  child.url = "https://ats.example/application";
  assert.equal((await h.scope.ensure({ tab: { id: 90 } })).id, "intern");
  assert.equal(h.session["jobsTabBinding:90"].websiteJobId, "a".repeat(24));
  await h.scope.select(1, h.cloud.ng);
  await h.launch({
    kind: "intern",
    jobId: "b".repeat(24),
    url: "https://jobs.example/2",
  });
  assert.equal(h.session.profile_3.id, "intern");
});

test("website links survive an extension reload and cover later steps of the same posting", async () => {
  const h = setup(),
    job = "e".repeat(24);
  await h.request({
    type: "jobs:site-links",
    links: [
      {
        kind: "intern",
        jobId: job,
        url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Seattle/Engineer_R-55555",
      },
    ],
  });
  // Reloading the extension clears session storage, never the website links.
  for (const key of Object.keys(h.session)) delete h.session[key];
  const tab = {
    id: 70,
    url: "https://acme.wd5.myworkdayjobs.com/Careers/job/Seattle-WA/Engineer_R-55555/apply/applyManually",
    active: true,
  };
  h.tabs.set(70, tab);
  const value = await h.scope.ensure({ tab });
  assert.equal(value.id, "intern");
  assert.equal(value.selectionSource, "resolved");
  assert.equal(h.session["jobsTabBinding:70"].websiteJobId, job);
});

test("a page opened outside the website asks the server once and binds that job pool", async () => {
  const h = setup(),
    job = "f".repeat(24),
    calls = [];
  await h.popup({
    action: "select",
    kind: "newgrad",
    tabId: 1,
    url: h.tabs.get(1).url,
  });
  h.sync.resolveJob = async (url, hint) => {
    calls.push([url, hint]);
    return { state: "matched", job_id: job, kinds: ["intern"] };
  };
  const tab = {
    id: 71,
    url: "https://job-boards.greenhouse.io/acme/jobs/4455667",
    active: false,
  };
  h.tabs.set(71, tab);
  const value = await h.scope.ensure({ tab }, false);
  assert.equal(
    calls.length,
    1,
    "an identified application asks the server once",
  );
  assert.equal(value.id, "intern");
  assert.equal(value.selectionSource, "resolved");
  assert.equal(h.session["jobsTabBinding:71"].websiteJobId, job);
  const other = {
    id: 72,
    url: "https://job-boards.greenhouse.io/acme/jobs/4455667?gh_src=agent",
  };
  h.tabs.set(72, other);
  await h.scope.ensure({ tab: other });
  assert.equal(calls.length, 1, "one lookup per job identity");
});

test("ambiguous or unknown pages use the last manual choice, whatever tab was viewed last", async () => {
  const h = setup();
  h.sync.resolveJob = async () => ({
    state: "matched",
    job_id: "a".repeat(24),
    kinds: ["intern", "newgrad"],
  });
  await h.popup({
    action: "select",
    kind: "intern",
    tabId: 1,
    url: h.tabs.get(1).url,
  });
  await h.launch({
    kind: "newgrad",
    jobId: "b".repeat(24),
    url: "https://ats.example/ng",
  });
  await h.activate(2);
  assert.equal(
    h.data.jobsManualProfileDefault.id,
    "intern",
    "viewing a job never changes the manual default",
  );
  const tab = { id: 73, url: "https://careers.example.com/jobs/1234567" };
  h.tabs.set(73, tab);
  assert.equal((await h.scope.ensure({ tab })).id, "intern");
  h.sync.resolveJob = async () => {
    throw Error("offline");
  };
  const offline = { id: 74, url: "https://careers.example.com/jobs/7654321" };
  h.tabs.set(74, offline);
  assert.equal((await h.scope.ensure({ tab: offline })).id, "intern");
});

test("another listed posting opened in the same tab is rebound when filling starts", async () => {
  const h = setup(),
    first = "a".repeat(24),
    second = "c".repeat(24);
  await h.launch({
    kind: "newgrad",
    jobId: first,
    url: "https://job-boards.greenhouse.io/acme/jobs/1111111",
  });
  h.sync.resolveJob = async (url) =>
    url.includes("2222222")
      ? { state: "matched", job_id: second, kinds: ["intern"] }
      : { state: "unmatched" };
  const tab = h.tabs.get(2);
  tab.url = "https://accounts.example.com/login";
  await h.updates[0](2, { url: tab.url }, tab);
  assert.equal(
    (await h.scope.ensure({ tab })).id,
    "ng",
    "a login page keeps the bound job",
  );
  tab.url = "https://job-boards.greenhouse.io/acme/jobs/2222222";
  await h.updates[0](2, { url: tab.url }, tab);
  const value = await h.scope.ensure({ tab });
  assert.equal(value.id, "intern");
  assert.equal(h.session["jobsTabBinding:2"].websiteJobId, second);
});

test("a first filling round binds once and a later round still fetches fresh facts", async () => {
  const h = setup();
  const tab = {
    id: 91,
    url: "https://job-boards.greenhouse.io/acme/jobs/1111111",
  };
  h.tabs.set(tab.id, tab);
  let lookups = 0,
    syncs = 0;
  h.sync.resolveJob = async () => {
    lookups++;
    return { state: "matched", job_id: "b".repeat(24), kinds: ["newgrad"] };
  };
  h.refresh.forProfile = async () => {
    syncs++;
    return { ok: true };
  };
  const first = await h.scope.context({ tab }, { refresh: true });
  assert.equal(h.reads.length, 1);
  assert.equal(syncs, 1);
  assert.equal(lookups, 1);
  assert.equal(first.revision, h.cloud.ng.last_sync);
  h.cloud.ng.profile.profileName = "Updated synthetic profile";
  h.cloud.ng.last_sync = "2026-09-20T02:00:00Z";
  const second = await h.scope.context({ tab }, { refresh: true });
  assert.equal(h.reads.length, 2);
  assert.equal(syncs, 2);
  assert.equal(second.revision, h.cloud.ng.last_sync);
  assert.equal(h.session.profile_91.profileName, "Updated synthetic profile");
});

test("concurrent filling rounds each verify their own Profile record in order", async () => {
  const h = setup();
  const tab = {
    id: 93,
    url: "https://job-boards.greenhouse.io/acme/jobs/1111111",
  };
  h.tabs.set(tab.id, tab);
  const original = h.sync.profileRequest;
  let entered,
    release,
    syncs = 0;
  const started = new Promise((resolve) => (entered = resolve));
  const waiting = new Promise((resolve) => (release = resolve));
  h.sync.profileRequest = async (args) => {
    const record = await original(args);
    if (h.reads.length === 1) {
      entered();
      await waiting;
    }
    return record;
  };
  h.refresh.forProfile = async () => {
    syncs++;
    return { ok: true };
  };
  const firstRevision = h.cloud.ng.last_sync;
  const first = h.scope.context({ tab }, { refresh: true });
  await started;
  const second = h.scope.context({ tab }, { refresh: true });
  h.cloud.ng.profile.profileName = "Updated synthetic concurrent profile";
  h.cloud.ng.last_sync = "2026-09-20T02:00:00Z";
  release();
  const [before, after] = await Promise.all([first, second]);

  assert.equal(before.revision, firstRevision);
  assert.equal(before.profileName, "Newgrad");
  assert.equal(after.revision, h.cloud.ng.last_sync);
  assert.equal(after.profileName, h.cloud.ng.profile.profileName);
  assert.deepEqual(h.reads, ["ng", "ng"]);
  assert.equal(syncs, 2);
  assert.equal(h.session.profile_93.lastSync, after.revision);
});

test("current status resolution feeds binding without another network lookup", async () => {
  const h = setup(),
    tab = { id: 92, url: "https://job-boards.greenhouse.io/acme/jobs/1111111" };
  h.tabs.set(tab.id, tab);
  await h.scope.rememberResolution(
    tab.url,
    { state: "matched", job_id: "d".repeat(24), kinds: ["newgrad"] },
    h.privateSession.epoch,
  );
  h.sync.resolveJob = async () => {
    throw Error("must reuse the just-verified job identity");
  };
  assert.equal((await h.scope.context({ tab }, { refresh: true })).id, "ng");
  await h.privateSession.clear();
  await assert.rejects(
    h.scope.rememberResolution(
      tab.url,
      { state: "matched", job_id: "d".repeat(24), kinds: ["newgrad"] },
      h.privateSession.epoch - 1,
    ),
    /连接|session|会话/i,
  );
});
