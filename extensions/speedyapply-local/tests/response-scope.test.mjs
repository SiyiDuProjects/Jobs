import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
const scripts = await Promise.all(
  [
    "response-contract",
    "document-store",
    "response-scope",
    "answer-resolver",
  ].map((name) =>
    readModule(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const writer = await readModule(
  new URL("../source/saved-responses.js", import.meta.url),
  "utf8",
);
const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  question = "Are you willing to work in this office?";
function setup(local = {}, session = {}) {
  const bound = new Map([
      [1, { id: A }],
      [2, { id: B }],
    ]),
    listeners = [];
  let sender = { id: "extension", tab: { id: 1 } };
  const area = (store) => ({
    getKeys: async () => Object.keys(store),
    get: async () => structuredClone(store),
    set: async (update) => Object.assign(store, structuredClone(update)),
  });
  const c = vm.createContext({
    console,
    location: { href: "https://jobs.ashbyhq.com/example/role/application" },
    JobsJobMatch: {
      key: () => "fixture-job",
      companyFromKey: () => "fixture-company",
    },
    structuredClone,
    readOperator: async () => ({ mode: "person", epoch: "fixture" }),
    chrome: {
      storage: { local: area(local), session: area(session) },
      runtime: {
        id: "extension",
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (message) =>
          new Promise((resolve) =>
            listeners.forEach((fn) => fn(message, sender, resolve)),
          ),
      },
    },
    JobsTabProfiles: { ensure: async (from) => bound.get(from.tab.id) },
  });
  for (const source of scripts) vm.runInContext(source, c);
  vm.runInContext(writer, c);
  const readSaved = async () => {
    const reply = await c.chrome.runtime.sendMessage({
      type: "jobs:responses-read",
    });
    if (reply.error) throw Error(reply.error);
    return reply.data;
  };
  return {
    readSaved,
    c,
    local,
    session,
    bound,
    scope: c.JobsResponseScope,
    save: (response, tab = 1) =>
      c.saveResponses(
        [
          {
            question,
            response,
            jobKey: "fixture-job",
            origin: "person",
            operatorEpoch: "fixture",
          },
        ],
        { id: "extension", tab: { id: tab } },
      ),
    sendAs: (value) => (sender = value),
    storedAnswer: async () =>
      (await readSaved()).find((row) => row.question === question)?.response ??
      null,
  };
}
test("retired global answers are never migrated or used as a new source of personal facts", async () => {
  const local = {
      lastSyncProfile: { id: A },
      responseList: [{ question, response: "Old private answer" }],
    },
    h = setup(local);
  await h.scope.ready;
  assert.deepEqual(h.session, {});
  assert.equal(await h.storedAnswer(), null);
  assert.deepEqual(Object.keys(local), ["lastSyncProfile", "responseList"]);
});
test("opposite answers remain separated by the active tab Profile and session-only cache", async () => {
  const h = setup();
  await h.save("Yes", 1);
  await h.save("No", 2);
  assert.equal(await h.storedAnswer(), "Yes");
  h.sendAs({ id: "extension", tab: { id: 2 } });
  assert.equal(await h.storedAnswer(), "No");
  assert.deepEqual(h.local, {});
  assert.equal(h.session["jobsResponses:" + A][0].response, "Yes");
  assert.equal(h.session["jobsResponses:" + B][0].response, "No");
  h.session["jobsResponses:" + B] = [];
  assert.equal(await h.storedAnswer(), null);
  h.sendAs({ id: "extension", tab: { id: 1 } });
  assert.equal(await h.storedAnswer(), "Yes");
});
test("switching one tab changes only that tab saved-answer scope", async () => {
  const h = setup();
  await h.save("Original", 1);
  h.bound.set(1, { id: B });
  await h.save("New selection", 1);
  assert.equal(h.session["jobsResponses:" + A][0].response, "Original");
  assert.equal(h.session["jobsResponses:" + B][0].response, "New selection");
  await assert.rejects(h.scope.scopeFor({ tab: { id: 99 } }), /Profile/);
  await assert.rejects(h.scope.storageKey(), /Profile/);
});
test("concurrent saves in separate Profiles do not overwrite each other and foreign callers cannot read", async () => {
  const h = setup();
  await Promise.all([h.save("Alpha", 1), h.save("Beta", 2)]);
  assert.equal(h.session["jobsResponses:" + A][0].response, "Alpha");
  assert.equal(h.session["jobsResponses:" + B][0].response, "Beta");
  h.sendAs({ id: "other-extension", tab: { id: 1 } });
  await assert.rejects(h.readSaved(), /Invalid response caller/);
});

test("operator changes while a save waits for its Profile cannot promote stale input", async () => {
  const h = setup(),
    reached = Promise.withResolvers(),
    release = Promise.withResolvers();
  const original = h.c.JobsResponseScope;
  h.c.JobsResponseScope = {
    ...original,
    storageKey: async (...args) => {
      reached.resolve();
      await release.promise;
      return original.storageKey(...args);
    },
  };
  const pending = h.save("Stale input");
  await reached.promise;
  h.c.readOperator = async () => ({ mode: "agent", epoch: "changed" });
  release.resolve();
  const result = await pending;
  assert.equal(result.saved, 0);
  assert.equal(h.session["jobsResponses:" + A], undefined);
});
