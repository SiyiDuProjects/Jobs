import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await readModule(
  new URL("../src/custom/automatic-background.js", import.meta.url),
  "utf8",
);
const matchCode = (
  await Promise.all(
    ["job-match-rules", "job-match"].map((name) =>
      readModule(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");

for (const timing of ["before", "during"])
  test(`a live ATS document can finish AI when observation registration is missing ${timing} the request`, async () => {
    const url = "https://job-boards.greenhouse.io/example/jobs/123",
      profile = { profileName: "Newgrad" },
      bound = { id: "ng", profile };
    let listener,
      registered = timing !== "before",
      calls = 0,
      probes = 0;
    const chrome = {
      runtime: {
        id: "jobs",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      tabs: {
        get: async () => ({ id: 1, url }),
        sendMessage: async (id, message, target) => {
          assert.equal(id, 1);
          assert.equal(target.documentId, "same-document");
          assert.equal(message.type, "jobs:document-check");
          probes++;
          return { active: true, url };
        },
      },
      storage: {
        session: {
          get: async () => ({
            jobsBrowserControlV1: {
              frames: registered
                ? { "1:0": { browserDocumentId: "same-document" } }
                : {},
            },
          }),
        },
      },
    };
    const ctx = vm.createContext({
      chrome,
      URL,
      setTimeout,
      clearTimeout,
      JobsProfileAnswers: { signature: JSON.stringify },
      JobsTabProfiles: { verify: async () => bound },
      JobsSync: {
        generateAnswer: async () => {
          calls++;
          registered = false;
          return { answers: [{ value: "Confirmed fixture answer" }] };
        },
      },
    });
    vm.runInContext(matchCode + "\n" + source, ctx);
    const result = await new Promise((resolve) =>
      listener(
        {
          type: "jobs:auto-answers",
          profileStamp: JSON.stringify(profile),
          fields: [],
        },
        {
          id: "jobs",
          tab: { id: 1, url },
          url,
          frameId: 0,
          documentId: "same-document",
        },
        resolve,
      ),
    );
    assert.equal(result.error, undefined);
    assert.equal(result.data.answers.length, 1);
    assert.equal(calls, 1);
    assert.equal(probes, 2);
  });

for (const change of ["url", "document"])
  test(`a changed ${change} while AI is pending cannot return an answer to the old form`, async () => {
    const url = "https://jobs.ashbyhq.com/company/role/application",
      profile = { profileName: "Intern" },
      bound = { id: "intern", profile };
    let listener,
      currentUrl = url,
      documentId = "before";
    const chrome = {
      runtime: {
        id: "jobs",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      tabs: {
        get: async () => ({ id: 1, url: currentUrl }),
        sendMessage: async (_, message, target) => {
          assert.equal(message.type, "jobs:document-check");
          if (target.documentId !== documentId) throw Error("No document");
          return { active: true, url: currentUrl };
        },
      },
      storage: {
        session: {
          get: async () => ({
            jobsBrowserControlV1: {
              frames: { "1:0": { browserDocumentId: documentId } },
            },
          }),
        },
      },
    };
    const ctx = vm.createContext({
      chrome,
      URL,
      setTimeout,
      clearTimeout,
      JobsProfileAnswers: { signature: JSON.stringify },
      JobsTabProfiles: { verify: async () => bound },
      JobsSync: {
        generateAnswer: async () => {
          if (change === "url") currentUrl = url.replace("/role/", "/another/");
          else documentId = "after";
          return { answers: [{ value: "Old answer" }] };
        },
      },
    });
    vm.runInContext(matchCode + "\n" + source, ctx);
    const result = await new Promise((resolve) =>
      listener(
        {
          type: "jobs:auto-answers",
          profileStamp: JSON.stringify(profile),
          fields: [],
        },
        {
          id: "jobs",
          tab: { id: 1, url },
          url,
          frameId: 0,
          documentId: "before",
        },
        resolve,
      ),
    );
    assert.match(result.error, /已变化/);
    assert.equal(result.data, undefined);
  });

test("reusing a tab for a new job cannot send the previous employer context to AI", async () => {
  const url = "https://jobs.ashbyhq.com/new-company/new-role/application",
    profile = { profileName: "Intern" },
    bound = { id: "intern", profile };
  let listener, payload;
  const storage = {
    job_1: {
      appUrl: "https://jobs.ashbyhq.com/old-company/old-role",
      title: "Old company title",
      description: "Old company private application context",
    },
  };
  const chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    tabs: { get: async () => ({ id: 1, url }) },
    storage: { session: { get: async () => storage } },
  };
  const ctx = vm.createContext({
    chrome,
    URL,
    JobsProfileAnswers: { signature: JSON.stringify },
    JobsTabProfiles: { verify: async () => bound },
    JobsSync: {
      generateAnswer: async (data) => {
        payload = data;
        return { answers: [] };
      },
    },
  });
  vm.runInContext(matchCode + "\n" + source, ctx);
  const result = await new Promise((resolve) =>
    listener(
      {
        type: "jobs:auto-answers",
        profileStamp: JSON.stringify(profile),
        fields: [],
        jobTitle: "Current company title",
      },
      { id: "jobs", tab: { id: 1, url }, url, frameId: 0 },
      resolve,
    ),
  );
  assert(result.data);
  assert.equal(payload.jobTitle, "Current company title");
  assert.equal(payload.jobDescription, "");
});
test("Luna accepts an active ATS iframe without observation registration and rejects unrelated frames", async () => {
  const profile = { profileName: "Intern" },
    bound = { id: "intern", profile };
  let listener,
    calls = 0;
  const chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    tabs: {
      get: async () => ({
        id: 1,
        url: "https://example.icims.com/jobs/1/questions",
      }),
      sendMessage: async (_, message, target) => ({
        active: target.documentId === "doc-frame",
        url: "https://example.icims.com/jobs/1/questions?in_iframe=1",
      }),
    },
    storage: { session: { get: async () => ({}) } },
  };
  const ctx = vm.createContext({
    chrome,
    URL,
    setTimeout,
    clearTimeout,
    JobsProfileAnswers: { signature: JSON.stringify },
    JobsTabProfiles: { verify: async () => bound },
    JobsSync: {
      generateAnswer: async (payload) => {
        calls++;
        assert.equal(payload.profileId, bound.id);
        assert.equal(payload.profile, undefined);
        return { answers: [] };
      },
    },
  });
  vm.runInContext(source, ctx);
  const ask = (sender) =>
    new Promise((resolve) =>
      listener(
        {
          type: "jobs:auto-answers",
          profileStamp: JSON.stringify(profile),
          fields: [],
        },
        sender,
        resolve,
      ),
    );
  const tab = { id: 1, url: "https://example.icims.com/jobs/1/questions" };
  assert(
    (
      await ask({
        id: "jobs",
        tab,
        frameId: 4,
        documentId: "doc-frame",
        url: tab.url + "?in_iframe=1",
      })
    ).data,
  );
  assert(
    (
      await ask({
        id: "jobs",
        tab,
        frameId: 5,
        url: "https://thirdparty.example/form",
      })
    ).error,
  );
  assert(
    (
      await ask({
        id: "jobs",
        tab,
        frameId: 5,
        documentId: "unrelated-frame",
        url: "https://thirdparty.example/form",
      })
    ).error,
  );
  assert(
    (
      await ask({
        id: "jobs",
        tab: { id: 1, url: "https://example.com" },
        frameId: 5,
        url: "https://example.com/form",
      })
    ).error,
  );
  assert.equal(calls, 1);
});

test("a stale matching registration cannot authorize an inactive document", async () => {
  const url = "https://jobs.ashbyhq.com/company/role/application",
    profile = { profileName: "Newgrad" };
  let listener,
    calls = 0;
  const chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    tabs: {
      get: async () => ({ id: 1, url }),
      sendMessage: async () => ({ active: false, url }),
    },
    storage: {
      session: {
        get: async () => ({
          jobsBrowserControlV1: {
            frames: { "1:0": { browserDocumentId: "old" } },
          },
        }),
      },
    },
  };
  const ctx = vm.createContext({
    chrome,
    URL,
    setTimeout,
    clearTimeout,
    JobsProfileAnswers: { signature: JSON.stringify },
    JobsTabProfiles: { verify: async () => ({ id: "ng", profile }) },
    JobsSync: {
      generateAnswer: async () => {
        calls++;
        return { answers: [] };
      },
    },
  });
  vm.runInContext(source, ctx);
  const result = await new Promise((resolve) =>
    listener(
      {
        type: "jobs:auto-answers",
        profileStamp: JSON.stringify(profile),
        fields: [],
      },
      { id: "jobs", tab: { id: 1, url }, url, frameId: 0, documentId: "old" },
      resolve,
    ),
  );
  assert.match(result.error, /文档已变化/);
  assert.equal(calls, 0);
});

for (const when of ["before", "during"])
  test(`a Profile update ${when} AI blocks stale answers`, async () => {
    const profile = {
        profileName: "Intern",
        applicationData: { willingToWorkOnsite: true },
      },
      bound = { id: "intern", profile };
    let listener,
      calls = 0,
      verifications = 0;
    const chrome = {
      runtime: {
        id: "jobs",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      tabs: {
        get: async () => ({
          id: 1,
          url: "https://jobs.ashbyhq.com/example/role",
        }),
      },
      storage: { session: { get: async () => ({}) } },
    };
    const ctx = vm.createContext({
      chrome,
      URL,
      JobsProfileAnswers: { signature: JSON.stringify },
      JobsTabProfiles: {
        verify: async () => {
          verifications++;
          if (when === "before" || verifications === 2)
            throw Error("Profile 已更新");
          return bound;
        },
      },
      JobsSync: {
        generateAnswer: async () => {
          calls++;
          return { answers: [{ value: "Old answer" }] };
        },
      },
    });
    vm.runInContext(source, ctx);
    const result = await new Promise((resolve) =>
      listener(
        {
          type: "jobs:auto-answers",
          profileStamp: JSON.stringify(profile),
          fields: [],
        },
        { id: "jobs", tab: { id: 1 }, frameId: 0 },
        resolve,
      ),
    );
    assert.match(result.error, /Profile 已更新/);
    assert.equal(result.data, undefined);
    assert.equal(calls, when === "before" ? 0 : 1);
  });

test("a single-page ATS that moved from Overview to Application keeps its document and may ask AI", async () => {
  // Ashby: sender.url is the URL the document was created with; the document and
  // tab report the live /application location (live G2 case, 2026-09-23).
  const overview =
      "https://jobs.ashbyhq.com/g2/64dcc04a-a0e7-493b-b899-dd4c56e561fd",
    application = overview + "/application",
    profile = { profileName: "Intern" };
  for (const [tabUrl, expectError] of [
    [application, false],
    [overview + "/other", true],
  ]) {
    let listener,
      calls = 0;
    const chrome = {
      runtime: {
        id: "jobs",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      tabs: {
        get: async () => ({ id: 1, url: tabUrl }),
        sendMessage: async (_, message, target) => ({
          active: target.documentId === "spa",
          url: application,
        }),
      },
      storage: { session: { get: async () => ({}) } },
    };
    const ctx = vm.createContext({
      chrome,
      URL,
      setTimeout,
      clearTimeout,
      JobsJobMatch: { same: () => false },
      JobsProfileAnswers: { signature: JSON.stringify },
      JobsTabProfiles: { verify: async () => ({ id: "intern", profile }) },
      JobsSync: {
        generateAnswer: async () => {
          calls++;
          return { answers: [] };
        },
      },
    });
    vm.runInContext(source, ctx);
    const result = await new Promise((resolve) =>
      listener(
        {
          type: "jobs:auto-answers",
          profileStamp: JSON.stringify(profile),
          fields: [],
        },
        {
          id: "jobs",
          tab: { id: 1, url: tabUrl },
          url: overview,
          frameId: 0,
          documentId: "spa",
        },
        resolve,
      ),
    );
    if (expectError) {
      assert.match(result.error, /页面已变化/);
      assert.equal(calls, 0);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(calls, 1);
    }
  }
});
