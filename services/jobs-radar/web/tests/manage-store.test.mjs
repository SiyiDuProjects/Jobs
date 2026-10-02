import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const bundle = (
  await build({
    stdin: {
      contents: `export {ManagementStore} from './src/manage/store'; export {defaultProfile} from './src/manage/model';`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "managed",
    platform: "browser",
    logLevel: "silent",
  })
).outputFiles[0].text;
const ng = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  intern = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const key = "jobsResponses:" + ng;
const answer = (key, response) => ({
  key,
  keywords: [key],
  appearances: 1,
  response,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

async function fixture() {
  const dom = new JSDOM("", {
      url: "https://jobs.test/",
      runScripts: "outside-only",
    }),
    w = dom.window;
  w.structuredClone = structuredClone;
  w.AbortSignal = AbortSignal;
  w.eval(bundle);
  const store = new w.managed.ManagementStore();
  const records = Object.fromEntries(
    [
      [ng, "Newgrad"],
      [intern, "Intern"],
    ].map(([id, name]) => [
      id,
      {
        id,
        last_sync: "v1",
        profile: { ...clone(w.managed.defaultProfile), profileName: name },
      },
    ]),
  );
  const docs = {
    [key]: { revision: 1, value: [answer("first", "Before")] },
    dailyGoal: { revision: 1, value: 10 },
  };
  const requests = [];
  let intercept,
    after,
    offline = false;
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined,
      method = init.method || "GET";
    requests.push({ url, method, body });
    await intercept?.(url, body);
    if (offline && body) throw Error("Offline write");
    let data,
      status = 200;
    if (url === "/api/session") data = { authenticated: true };
    else if (url === "/api/manage/state") {
      if (body)
        for (const item of body.changes) {
          assert.equal(item.revision, docs[item.key]?.revision || 0);
          docs[item.key] = {
            value: clone(item.value),
            revision: item.revision + 1,
          };
        }
      data = docs;
    } else if (url.startsWith("/api/manage/profiles")) {
      const id = url.split("/")[4];
      if (method === "GET") {
        data = id
          ? records[id]
          : Object.values(records)
              .filter((r) => !r.deleted)
              .map((r) => ({
                id: r.id,
                profileName: r.profile.profileName,
              }));
        if (id && (!data || data.deleted)) {
          status = 404;
          data = { error: "Profile not found" };
        }
      } else if (method === "DELETE") {
        assert.equal(body.expected_sync, records[id].last_sync);
        records[id].deleted = true;
        data = Object.values(records).find((r) => !r.deleted);
      } else {
        const target = id || body.id || w.crypto.randomUUID(),
          old = records[target];
        if (
          old?.deleted ||
          (method === "POST" &&
            old &&
            JSON.stringify(old.profile) !== JSON.stringify(body.profile))
        ) {
          status = 409;
          data = { error: "Creation reference conflict" };
        } else {
          if (
            !old ||
            JSON.stringify(old.profile) !== JSON.stringify(body.profile)
          ) {
            if (method === "PUT")
              assert.equal(body.expected_sync, old.last_sync);
            records[target] = {
              id: target,
              profile: body.profile,
              last_sync: "v" + requests.length,
            };
          }
          data = { id: target, last_sync: records[target].last_sync };
        }
      }
    } else throw Error("Unexpected API " + url);
    const snapshot = clone(data);
    await after?.(url, body);
    return { ok: status === 200, status, json: async () => snapshot };
  };
  await store.start();
  return {
    w,
    store,
    records,
    docs,
    requests,
    offline: (value) => (offline = value),
    intercept: (fn) => (intercept = fn),
    after: (fn) => (after = fn),
    close() {
      store.stop();
      w.close();
    },
  };
}

test("a failed refresh resumes and is not an unsaved edit", async () => {
  const h = await fixture();
  try {
    h.intercept((url, body) => {
      if (url === "/api/manage/state" && !body)
        throw Error("Temporary read failure");
    });
    await h.store.refresh();
    assert.equal(h.store.state.unsaved || 0, 0);
    h.intercept(undefined);
    h.docs.dailyGoal = { value: 23, revision: 2 };
    await h.store.refresh();
    assert.equal(h.store.state.docs.dailyGoal.value, 23);
  } finally {
    h.close();
  }
});

test("an earlier refresh cannot roll back a completed edit", async () => {
  const h = await fixture();
  try {
    const entered = gate(),
      release = gate();
    h.after(async (url, body) => {
      if (url === "/api/manage/state" && !body) {
        h.after(undefined);
        entered.resolve();
        await release.promise;
      }
    });
    const polling = h.store.refresh();
    await entered.promise;
    await h.store.write({ dailyGoal: 42 });
    release.resolve();
    await polling;
    assert.equal(h.store.state.docs.dailyGoal.value, 42);
  } finally {
    h.close();
  }
});

test("failed edits remain retryable and unrelated success cannot mask the unsaved state", async () => {
  const h = await fixture();
  try {
    h.offline(true);
    await assert.rejects(
      h.store.write({ [key]: [answer("first", "Unsaved")] }),
      /Offline/,
    );
    h.offline(false);
    await h.store.profileAPI();
    await h.store.write({ dailyGoal: 11 });
    assert.equal(h.store.state.unsaved, 1);
    assert.match(h.store.state.error, /Offline/);
    assert.match(h.store.state.notice, /尚未保存/);
    await h.store.retryFailed();
    assert.equal(h.docs[key].value[0].response, "Unsaved");
    assert.equal(h.store.state.unsaved, 0);
  } finally {
    h.close();
  }
});

test("upload acknowledgements refresh unrelated changed data before its next edit", async () => {
  const h = await fixture();
  try {
    h.intercept((url, body) => {
      if (url === "/api/manage/state" && body) {
        h.docs.dailyGoal = { value: 20, revision: 2 };
        h.intercept(undefined);
      }
    });
    await h.store.write({ [key]: [answer("first", "Changed")] });
    assert.equal(h.store.state.docs.dailyGoal.value, 20);
    await h.store.write({ dailyGoal: 21 });
    assert.equal(h.docs.dailyGoal.value, 21);
  } finally {
    h.close();
  }
});

test("a queued Profile save cannot select its Profile after an already requested switch completes", async () => {
  const h = await fixture();
  try {
    const entered = gate(),
      release = gate();
    h.after(async (url) => {
      if (url === "/api/manage/profiles/" + intern) {
        h.after(undefined);
        entered.resolve();
        await release.promise;
      }
    });
    const selected = h.store.selectProfile(intern);
    await entered.promise;
    const old = clone(h.store.state.current),
      value = { ...old.profile, profileName: "Edited Newgrad" };
    const saved = h.store.saveProfile(value, old);
    release.resolve();
    await selected;
    await saved;
    assert.equal(h.records[ng].profile.profileName, "Edited Newgrad");
    assert.equal(h.store.state.current.id, intern);
  } finally {
    h.close();
  }
});

test("a failed Profile save retains a retryable draft and blocks a destructive switch", async () => {
  const h = await fixture();
  try {
    h.offline(true);
    await assert.rejects(
      h.store.saveProfile({
        ...h.store.state.current.profile,
        profileName: "Unsaved Newgrad",
      }),
      /Offline/,
    );
    h.offline(false);
    await assert.rejects(h.store.selectProfile(intern), /尚未保存/);
    await h.store.retryFailed();
    assert.equal(h.records[ng].profile.profileName, "Unsaved Newgrad");
    await h.store.selectProfile(intern);
    assert.equal(h.store.state.current.id, intern);
  } finally {
    h.close();
  }
});

test("write snapshots caller data before it can mutate", async () => {
  const h = await fixture();
  try {
    const value = [answer("first", "Intended")],
      saving = h.store.write({ [key]: value });
    value[0].response = "Changed outside";
    await saving;
    assert.equal(h.docs[key].value[0].response, "Intended");
  } finally {
    h.close();
  }
});

for (const failure of ["lost-response", "list-refresh"]) {
  for (const retry of ["retry-button", "editor-save"]) {
    test(`Profile creation ${failure} retries with the same reference through ${retry}`, async () => {
      const h = await fixture();
      try {
        const id = h.w.crypto.randomUUID(),
          profile = {
            ...h.store.state.current.profile,
            profileName: "Created once",
          };
        let accepted = false,
          failed = false;
        h.after((url, body) => {
          if (url === "/api/manage/profiles" && body) {
            accepted = true;
            if (failure === "lost-response" && !failed) {
              failed = true;
              throw Error("Lost create response");
            }
          }
        });
        h.intercept((url, body) => {
          if (
            failure === "list-refresh" &&
            accepted &&
            !failed &&
            url === "/api/manage/profiles" &&
            !body
          ) {
            failed = true;
            throw Error("Lost list refresh");
          }
        });
        await assert.rejects(h.store.saveProfile(profile, null, id), /Lost/);
        assert.equal(Object.keys(h.records).length, 3);
        if (retry === "retry-button") await h.store.retryFailed();
        else await h.store.saveProfile(profile, null, id);
        assert.equal(Object.keys(h.records).length, 3);
        assert.equal(h.store.state.current.id, id);
        assert.equal(h.store.state.unsaved, 0);
        const posts = h.requests.filter(
          (r) => r.url === "/api/manage/profiles" && r.method === "POST",
        );
        assert.equal(posts.length, 2);
        assert(posts.every((r) => r.body.id === id));
      } finally {
        h.close();
      }
    });
  }
  test(`Profile deletion ${failure} remains successful when retried`, async () => {
    const h = await fixture();
    try {
      let accepted = false,
        failed = false;
      h.after((url, body) => {
        if (url === "/api/manage/profiles/" + ng && body) {
          accepted = true;
          if (failure === "lost-response" && !failed) {
            failed = true;
            throw Error("Lost delete response");
          }
        }
      });
      h.intercept((url, body) => {
        if (
          failure === "list-refresh" &&
          accepted &&
          !failed &&
          url === "/api/manage/profiles" &&
          !body
        ) {
          failed = true;
          throw Error("Lost list refresh");
        }
      });
      await assert.rejects(h.store.deleteProfile(ng), /Lost/);
      assert(h.records[ng].deleted);
      await h.store.retryFailed();
      assert.equal(
        Object.values(h.records).filter((r) => !r.deleted).length,
        1,
      );
      assert.equal(h.store.state.current.id, intern);
      assert.equal(h.store.state.unsaved, 0);
    } finally {
      h.close();
    }
  });
}

test("independent queued edits survive an acknowledgement between writes", async () => {
  const h = await fixture();
  try {
    const entered = gate(),
      release = gate();
    h.intercept(async (url, body) => {
      if (url === "/api/manage/state" && body) {
        h.intercept(undefined);
        entered.resolve();
        await release.promise;
      }
    });
    const first = h.store.write({ [key]: [answer("first", "Changed")] });
    await entered.promise;
    const second = h.store.write({
      [key]: [answer("first", "Changed"), answer("new", "New answer")],
    });
    release.resolve();
    await first;
    await second;
    assert.deepEqual(clone(h.docs[key].value.map((r) => r.response)), [
      "Changed",
      "New answer",
    ]);
  } finally {
    h.close();
  }
});

for (const operation of ["refresh", "profile-save"])
  test(`stop releases personal data and ignores an in-flight ${operation}`, async () => {
    const h = await fixture();
    try {
      const entered = gate(),
        release = gate();
      h.after(async (url, body) => {
        if (
          operation === "refresh"
            ? url === "/api/manage/state" && !body
            : url === "/api/manage/profiles/" + ng && body
        ) {
          h.after(undefined);
          entered.resolve();
          await release.promise;
        }
      });
      const pending =
        operation === "refresh"
          ? h.store.refresh()
          : h.store.saveProfile({
              ...h.store.state.current.profile,
              profileName: "Already accepted",
            });
      await entered.promise;
      h.store.stop();
      release.resolve();
      await pending;
      assert.deepEqual(clone(h.store.state.docs), {});
      assert.deepEqual(clone(h.store.state.profiles), []);
      assert.equal(h.store.state.current, undefined);
      assert.equal(h.store.state.pending, 0);
    } finally {
      h.close();
    }
  });
