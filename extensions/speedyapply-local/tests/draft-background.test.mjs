import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
import {
  updateDraftJournal,
  approveDraftJournal,
} from "../src/custom/draft-journal.js";
const code = await readModule(
  new URL("../src/custom/draft-background.js", import.meta.url),
  "utf8",
);
function fixture() {
  const data = {};
  let removed;
  let bound = { id: "profile", lastSync: "v1" },
    url = "job-1",
    epoch = 0;
  let delay = async () => {};
  const sender = { id: "jobs", tab: { id: 1 }, documentId: "document-1", url };
  const ctx = vm.createContext({
    updateDraftJournal,
    approveDraftJournal,
    JobsJobMatch: { key: (value) => value },
    JobsAnswerContext: {
      create: async () => {
        const original = JSON.stringify(bound),
          currentUrl = url;
        return {
          bound: { ...bound },
          job: { appUrl: url },
          url,
          verify: async () => {
            if (JSON.stringify(bound) !== original || currentUrl !== url)
              throw Error("binding changed");
          },
        };
      },
    },
    JobsPrivateSession: {
      get epoch() {
        return epoch;
      },
      assertCurrent(value) {
        if (value !== epoch) throw Error("connection changed");
      },
      async commit(value, values) {
        this.assertCurrent(value);
        Object.assign(data, values);
      },
    },
    chrome: {
      runtime: { id: "jobs", onMessage: { addListener() {} } },
      tabs: {
        onRemoved: {
          addListener: (fn) => {
            removed = fn;
          },
        },
      },
      storage: {
        session: {
          get: async (key) => {
            await delay();
            return { [key]: data[key] };
          },
          remove: async (key) => {
            delete data[key];
          },
        },
      },
    },
  });
  vm.runInContext(code, ctx);
  return {
    data,
    sender,
    call: (message, owner = sender) => ctx.draftRequest(message, owner),
    remove: () => removed(1),
    changeProfile: () => {
      bound = { ...bound, lastSync: "v2" };
    },
    changeJob: () => {
      url = "job-2";
    },
    disconnect: () => {
      epoch++;
    },
    delay: (fn) => {
      delay = fn;
    },
  };
}
const item = { key: "field", question: "Why this role?", answer: "A draft" };
test("drafts retain earlier documents of the same application and reset for another Profile or job", async () => {
  const h = fixture();
  await h.call({ action: "put", items: [item] });
  assert.equal(
    (
      await h.call(
        { action: "read" },
        { ...h.sender, documentId: "next-document" },
      )
    ).items.length,
    1,
  );
  h.changeProfile();
  assert.equal((await h.call({ action: "read" })).items.length, 0);
  await h.call({ action: "put", items: [item] });
  h.changeJob();
  assert.equal((await h.call({ action: "read" })).items.length, 0);
});
test("a stale checklist revision cannot approve a newer answer", async () => {
  const h = fixture();
  const state = await h.call({ action: "put", items: [item] });
  await h.call({
    action: "put",
    items: [{ ...item, answer: "Changed draft" }],
  });
  await assert.rejects(
    h.call({ action: "approve", revision: state.revision }),
    /草稿已改变/,
  );
  assert.equal((await h.call({ action: "read" })).approved, -1);
});
for (const kind of ["Profile", "connection"])
  test(`a ${kind} change while reading rejects the old journal write`, async () => {
    const h = fixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    h.delay(async () => {
      started();
      await gate;
    });
    const task = h.call({ action: "put", items: [item] });
    await waiting;
    if (kind === "Profile") h.changeProfile();
    else h.disconnect();
    release();
    await assert.rejects(task, /changed/);
    assert.deepEqual(h.data, {});
  });
test("draft storage only accepts bound extension documents and clears when the tab closes", async () => {
  const h = fixture();
  for (const sender of [
    { ...h.sender, id: "page" },
    { ...h.sender, documentId: null },
    { ...h.sender, tab: null },
  ])
    await assert.rejects(
      h.call({ action: "put", items: [item] }, sender),
      /document required/,
    );
  await h.call({ action: "put", items: [item] });
  h.remove();
  assert.deepEqual(h.data, {});
});
