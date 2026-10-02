import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { readModule } from "./helpers/module-source.mjs";
const modules = await Promise.all(
  ["job-match-rules", "job-match", "submission-background"].map((name) =>
    readModule(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const url =
  "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application";
function guardFixture(local = {}, options = {}) {
  let listener;
  const events = [];
  let writeFails = false,
    recordFails = false;
  const chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    storage: {
      local: {
        get: async () => structuredClone(local),
        set: async (value) => {
          if (writeFails) throw Error("Storage unavailable");
          Object.assign(local, structuredClone(value));
        },
      },
    },
    tabs: {
      sendMessage: async () => ({ active: true, url: options.liveUrl || url }),
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: webcrypto,
    URL,
    Date,
    JobsTabProfiles: {
      verify: async () => {
        if (options.profileInvalid) throw Error("Profile changed");
        return { id: "profile-id", profileName: "Profile" };
      },
    },
    JobsSync: {
      resolveJob: async () =>
        options.prior === undefined
          ? { matched: false, application: null }
          : options.prior,
      record: async (app, source) => {
        if (recordFails) throw Error("Event outbox unavailable");
        events.push({ app, source });
      },
    },
  });
  modules.forEach((source) => vm.runInContext(source, context));
  const sender = {
    id: "jobs",
    documentId: "doc-1",
    tab: { id: 1, title: "Engineer" },
    url,
  };
  const request = (type, extra = {}, origin = sender) =>
    new Promise((resolve) =>
      listener({ type, url, ...extra }, origin, resolve),
    );
  return {
    local,
    events,
    request,
    sender,
    writeFails: (value) => (writeFails = value),
    recordFails: (value) => (recordFails = value),
  };
}
test("preparing a submit creates protection but no executed event; duplicate tabs and restart stay blocked", async () => {
  const h = guardFixture(),
    first = await h.request("jobs:submission-prepare");
  assert(first.data.id);
  assert.equal(h.events.length, 0);
  assert.match((await h.request("jobs:submission-prepare")).error, /待核实/);
  assert.match(
    (
      await h.request(
        "jobs:submission-prepare",
        {},
        { ...h.sender, tab: { id: 2 }, documentId: "doc-2" },
      )
    ).error,
    /待核实/,
  );
  const restarted = guardFixture(h.local);
  assert.match(
    (await restarted.request("jobs:submission-prepare")).error,
    /待核实/,
  );
  assert.equal(restarted.events.length, 0);
});
test("simultaneous submit contenders produce one recoverable guard", async () => {
  const h = guardFixture(),
    results = await Promise.all([
      h.request("jobs:submission-prepare"),
      h.request("jobs:submission-prepare"),
    ]);
  assert.equal(results.filter((row) => row.data?.id).length, 1);
  assert.equal(Object.keys(h.local.jobsSubmissionGuardsV1).length, 1);
});
test("attempt and validation error use distinct event IDs; no preparation is misreported as an attempt", async () => {
  const h = guardFixture(),
    id = (await h.request("jobs:submission-prepare")).data.id;
  assert.match(
    (await h.request("jobs:submission-validation-error", { id })).error,
    /No executed/,
  );
  assert.equal(h.events.length, 0);
  assert((await h.request("jobs:submission-attempted", { id })).data.ok);
  assert((await h.request("jobs:submission-validation-error", { id })).data.ok);
  assert.deepEqual(
    h.events.map((row) => row.source.proof),
    ["submit_attempt", "submit_validation_error"],
  );
  assert.notEqual(h.events[0].source.eventId, h.events[1].source.eventId);
  assert(
    Object.values(h.local.jobsSubmissionGuardsV1).every(
      (row) => row.state === "validation_error",
    ),
  );
});
test("event or storage failure cannot clear a guard or enable replay", async () => {
  const h = guardFixture(),
    id = (await h.request("jobs:submission-prepare")).data.id;
  h.recordFails(true);
  assert.match(
    (await h.request("jobs:submission-attempted", { id })).error,
    /outbox/,
  );
  assert.match((await h.request("jobs:submission-prepare")).error, /待核实/);
  const unavailable = guardFixture();
  unavailable.writeFails(true);
  assert.match(
    (await unavailable.request("jobs:submission-prepare")).error,
    /Storage/,
  );
  assert.equal(unavailable.events.length, 0);
});
test("a replaced document, changed Profile and foreign sender cannot prepare or acknowledge a submit", async () => {
  assert.match(
    (
      await guardFixture(
        {},
        { liveUrl: "https://jobs.ashbyhq.com/other/job" },
      ).request("jobs:submission-prepare")
    ).error,
    /changed/,
  );
  assert.match(
    (
      await guardFixture({}, { profileInvalid: true }).request(
        "jobs:submission-prepare",
      )
    ).error,
    /Profile changed/,
  );
  const h = guardFixture();
  assert.match(
    (
      await h.request(
        "jobs:submission-prepare",
        {},
        { ...h.sender, id: "foreign" },
      )
    ).error,
    /document required/,
  );
  const id = (await h.request("jobs:submission-prepare")).data.id;
  assert.match(
    (
      await h.request(
        "jobs:submission-attempted",
        { id },
        { ...h.sender, documentId: "replacement" },
      )
    ).error,
    /guard changed/,
  );
  assert.equal(h.events.length, 0);
});
test("native worker preserves phase proof and reports event persistence failure without maintaining a second application list", async () => {
  const source = await readModule(
      new URL("../source/background-api.js", import.meta.url),
      "utf8",
    ),
    events = [];
  let fail = false;
  const context = vm.createContext({
    URL,
    Date,
    chrome: {
      runtime: {
        id: "jobs",
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {
            throw Error("Application lists must remain server-owned");
          },
        },
      },
    },
    JobsTabProfiles: {
      ensure: async () => ({ id: "profile", profileName: "Profile" }),
    },
    JobsSync: {
      record: async (...args) => {
        if (fail) throw Error("Outbox failed");
        events.push(args);
      },
    },
  });
  vm.runInContext(source, context);
  const sender = { id: "jobs", url, tab: { id: 1, title: "Engineer" } };
  assert(
    (
      await context.handle(
        {
          type: "saveApplication",
          jobLink: url,
          jobsSyncProof: "ats_confirmation",
        },
        sender,
      )
    ).ok,
  );
  assert.equal(events[0][1].proof, "ats_confirmation");
  assert.equal(events[0][1].profileId, "profile");
  await context.handle(
    {
      type: "saveApplication",
      jobLink: url,
      jobTitle: "",
      jobsSyncProof: "ats_confirmation",
    },
    { ...sender, tab: { id: 1, title: "Thank you for applying" } },
  );
  assert.equal(
    events[1][0].jobTitle,
    "",
    "an explicitly titleless receipt preserves existing server metadata",
  );
  fail = true;
  await assert.rejects(
    context.handle({ type: "saveApplication" }, sender),
    /Outbox failed/,
  );
  await assert.rejects(
    context.handle({ type: "saveApplication" }, { ...sender, id: "foreign" }),
    /Application tab required/,
  );
});

test("server-owned attempts and unavailable history both prevent a fresh local submit", async () => {
  assert.match(
    (
      await guardFixture(
        {},
        {
          prior: {
            matched: true,
            application: { submitted: true, confirmed: false },
          },
        },
      ).request("jobs:submission-prepare")
    ).error,
    /已有提交记录/,
  );
  assert.match(
    (await guardFixture({}, { prior: null }).request("jobs:submission-prepare"))
      .error,
    /无法核对/,
  );
});
