import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";

const source = await readModule(
  new URL("../src/custom/recovery-pause.js", import.meta.url),
  "utf8",
);
const pause = () =>
  Response.json({ code: "recovery_application_pause" }, { status: 503 });

function setup(retain = async () => ({})) {
  const session = { profile_1: { profile: "old synthetic profile" } };
  const context = vm.createContext({
    JobsManagementSync: { pendingSnapshot: retain },
    chrome: {
      storage: {
        session: {
          getKeys: async () => Object.keys(session),
          set: async (values) =>
            Object.assign(session, structuredClone(values)),
          remove: async (keys) => {
            for (const key of keys) delete session[key];
          },
        },
      },
    },
  });
  vm.runInContext(source, context);
  return {
    context,
    session,
    async switchConnection() {
      await context.JobsPrivateSession.clear();
      session.profile_2 = { profile: "new synthetic profile" };
    },
  };
}

test("an old connection pause response cannot clear the replacement connection", async () => {
  const h = setup(),
    epoch = h.context.JobsPrivateSession.epoch;
  await h.switchConnection();
  await assert.rejects(
    h.context.checkRecoveryPause(pause(), epoch),
    /连接已改变/,
  );
  assert.deepEqual(h.session.profile_2, { profile: "new synthetic profile" });
});

for (const validJSON of [true, false])
  test(`connection changes while pause JSON ${validJSON ? "resolves" : "rejects"} preserve the new private session`, async () => {
    const h = setup(),
      epoch = h.context.JobsPrivateSession.epoch,
      parsed = Promise.withResolvers();
    const pending = h.context.checkRecoveryPause(
      { status: 503, clone: () => ({ json: () => parsed.promise }) },
      epoch,
    );
    await h.switchConnection();
    if (validJSON) parsed.resolve({ code: "recovery_application_pause" });
    else parsed.reject(Error("synthetic invalid JSON"));
    await assert.rejects(pending, /连接已改变/);
    assert.deepEqual(h.session.profile_2, { profile: "new synthetic profile" });
  });

test("a current authenticated pause clears private facts and retains pending work", async () => {
  const pendingKey = "jobsResponses:synthetic";
  const pending = [{ question: "Synthetic question", response: "Pending" }];
  const h = setup(async () => ({ [pendingKey]: pending }));
  await assert.rejects(
    h.context.checkRecoveryPause(pause(), h.context.JobsPrivateSession.epoch),
    { code: "recovery_application_pause" },
  );
  assert.equal(h.session.profile_1, undefined);
  assert.deepEqual(h.session[pendingKey], pending);
});

test("ordinary errors do not pause a current connection", async () => {
  const h = setup(),
    epoch = h.context.JobsPrivateSession.epoch;
  for (const response of [
    Response.json({ code: "recovery_application_pause" }, { status: 502 }),
    Response.json({ error: "Synthetic gateway failure" }, { status: 503 }),
    new Response("Synthetic HTML error", { status: 503 }),
  ])
    await h.context.checkRecoveryPause(response, epoch);
  assert.equal(h.context.JobsPrivateSession.epoch, epoch);
  assert.deepEqual(h.session.profile_1, { profile: "old synthetic profile" });
});

test("callers without an epoch retain shared pause handling", async () => {
  const held = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let retained = 0;
  const h = setup(async () => {
    retained++;
    entered.resolve();
    return held.promise;
  });
  const first = h.context.checkRecoveryPause(pause());
  await entered.promise;
  const second = h.context.checkRecoveryPause(pause());
  const results = Promise.all([
    assert.rejects(first, { code: "recovery_application_pause" }),
    assert.rejects(second, { code: "recovery_application_pause" }),
  ]);
  held.resolve({});
  await results;
  assert.equal(retained, 1);
  assert.equal(h.session.profile_1, undefined);
});
