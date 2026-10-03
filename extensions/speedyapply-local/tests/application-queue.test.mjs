import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await readModule(
  new URL("../src/custom/application-queue.js", import.meta.url),
  "utf8",
);
const clone = (value) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
const id = (n) => String(n).padStart(24, "0"),
  url = (n) => "https://jobs.ashbyhq.com/acme/job-" + n;
function fixture() {
  let saved,
    session = "browser-1",
    clock = 1000,
    seq = 1,
    enabled = false,
    resolveAllowed = true,
    compatible = true,
    failCreate = false,
    failUpdate = false;
  const tabs = [],
    events = [];
  const io = {
    now: () => clock,
    uuid: () => String(seq++),
    same: (a, b) =>
      a?.replace(/\/application$/, "") === b?.replace(/\/application$/, ""),
    load: async () => clone(saved),
    save: async (state) => {
      saved = clone(state);
      events.push(["save", clone(state)]);
    },
    session: async () => session,
    resolve: async (u, j) => ({
      state: "matched",
      job_id: j,
      job_ids: [j],
      title: "Role",
      company: "Company",
      ...(compatible
        ? {
            queue: {
              version: 1,
              allowed: resolveAllowed,
              reason: resolveAllowed ? "" : "application_history",
            },
          }
        : {}),
    }),
    autoSubmit: async () => enabled,
    tabs: async () => clone(tabs),
    tab: async (n) => clone(tabs.find((tab) => tab.id === n)),
    staging: (nonce) =>
      "chrome-extension://extension/queue-entry.html#" + nonce,
    createTab: async (u) => {
      const tab = { id: seq++, url: u };
      tabs.push(tab);
      events.push(["create", tab.id]);
      if (failCreate) {
        failCreate = false;
        throw Error("lost create reply");
      }
      return clone(tab);
    },
    navigate: async (n, u) => {
      tabs.find((tab) => tab.id === n).url = u;
      events.push(["navigate", n]);
      if (failUpdate) {
        failUpdate = false;
        throw Error("lost update reply");
      }
    },
    control: async (n, state) => events.push(["control", n, clone(state)]),
    focus: async (n) => events.push(["focus", n]),
  };
  const make = () => {
    const context = vm.createContext({ URL });
    vm.runInContext(source, context);
    return context.JobsApplicationQueue.create(io);
  };
  let engine = make();
  return {
    io,
    tabs,
    events,
    get engine() {
      return engine;
    },
    state: () => clone(saved),
    restart: () => (engine = make()),
    browserRestart: () => {
      session = "browser-2";
      engine = make();
    },
    autoSubmit: (value) => (enabled = value),
    eligibility: (value) => (resolveAllowed = value),
    compatible: (value) => (compatible = value),
    failCreate: () => (failCreate = true),
    failUpdate: () => (failUpdate = true),
    advance: (ms) => (clock += ms),
    add: (n) => engine.command("add", { jobId: id(n), url: url(n) }),
    start: (mode = "fill") => engine.command("start", { mode }),
    sender: (frame = 0, doc = "chrome-doc") => ({
      tabId: tabs[0].id,
      frameId: frame,
      browserDocumentId: doc,
      lifecycle: "active",
      url: tabs[0].url,
    }),
    page: (data, frame = 0, doc = "chrome-doc") =>
      engine.page(
        { document: "page-" + frame, url: tabs[0].url, ...data },
        {
          tabId: tabs[0].id,
          frameId: frame,
          browserDocumentId: doc,
          lifecycle: "active",
          url: tabs[0].url,
        },
      ),
  };
}
test("enqueue deduplicates and does not open a tab until explicitly started", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(1);
  assert.equal(h.state().items.length, 1);
  assert.equal(h.tabs.length, 0);
  await h.start();
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, url(1));
  assert.equal(h.state().mode, "fill");
  const createIndex = h.events.findIndex((e) => e[0] === "create");
  assert(
    h.events
      .slice(0, createIndex)
      .some((e) => e[0] === "save" && e[1].items[0]?.state === "opening"),
  );
});
test("unavailable server eligibility fails closed and changed application status is rechecked at launch", async () => {
  const h = fixture();
  h.compatible(false);
  await assert.rejects(h.add(1), /兼容/);
  h.compatible(true);
  await h.add(1);
  h.eligibility(false);
  await h.start();
  assert.equal(h.tabs.length, 0);
  assert.equal(h.state().items[0].state, "blocked");
});
test("preexisting applicant tab is preserved and never commandeered", async () => {
  const h = fixture();
  await h.add(1);
  h.tabs.push({ id: 42, url: url(1) + "/application" });
  await h.start();
  assert.equal(h.tabs.length, 1);
  assert.equal(h.state().items[0].state, "blocked");
  assert(!h.events.some((e) => e[0] === "navigate"));
});
for (const effect of ["Create", "Update"])
  test(`lost ${effect} acknowledgement recovers the owned staging tab without opening twice`, async () => {
    const h = fixture();
    await h.add(1);
    h["fail" + effect]();
    await h.start();
    h.restart();
    await h.engine.tick();
    assert.equal(h.tabs.length, 1);
    assert.equal(h.tabs[0].url, url(1));
    assert.equal(h.state().items[0].state, "entering");
  });
test("browser restart pauses restored application documents and rejects reused unrelated tab ids", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  await h.page({ type: "hello" });
  h.browserRestart();
  await h.engine.tick();
  assert.equal(h.state().enabled, false);
  assert.equal((await h.page({ type: "hello" })).allowed, false);
  h.tabs[0].url = url(2);
  await assert.rejects(
    h.engine.command("resume", { id: h.state().items[0].id }),
    /同一岗位/,
  );
  assert.equal((await h.page({ type: "hello" })).owned, false);
});
test("review suspends only its job, other jobs continue and the same document can resume", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  await h.start();
  await h.page({ type: "hello" });
  await h.page({ type: "status", phase: "ai-review", active: true });
  assert.equal(h.state().items[0].state, "waiting_input");
  assert.equal(h.tabs.length, 2);
  await h.page({ type: "status", phase: "ai-filling", active: true });
  assert.equal(h.state().items[0].state, "filling");
});
test("pause and cancel revoke navigation while preserving the page and queue record", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  await h.page({ type: "hello" });
  await h.engine.command("pause");
  await assert.rejects(
    h.page({ type: "intent", action: "next", step: "one" }),
    /暂停/,
  );
  await h.engine.command("cancel", { id: h.state().items[0].id });
  assert.equal(h.tabs.length, 1);
  assert.equal((await h.page({ type: "hello" })).allowed, false);
});
test("fill mode never submits and apply mode requires the actual current global setting", async () => {
  const h = fixture();
  await h.add(1);
  await assert.rejects(h.start("apply"), /自动提交/);
  await h.start();
  await h.page({ type: "hello" });
  await assert.rejects(
    h.page({ type: "intent", action: "submit", step: "review" }),
    /只填写/,
  );
});
test("submission intent is durable before dispatch and survives worker/browser restarts without replay", async () => {
  const h = fixture();
  h.autoSubmit(true);
  await h.add(1);
  await h.start("apply");
  await h.page({ type: "hello" });
  await h.page({ type: "intent", action: "submit", step: "review" });
  assert.equal(h.state().items[0].state, "submission_uncertain");
  h.restart();
  await assert.rejects(
    h.page({ type: "intent", action: "submit", step: "different" }),
    /暂停|核实/,
  );
  await h.page({ type: "status", active: true, finalReady: true });
  assert.equal(h.state().items[0].state, "submission_uncertain");
  await assert.rejects(
    h.engine.command("resume", { id: h.state().items[0].id }),
    /不能自动/,
  );
  await assert.rejects(
    h.engine.command("cancel", { id: h.state().items[0].id }),
    /待核实/,
  );
  await h.page({ type: "status", confirmed: true });
  assert.equal(h.state().items[0].state, "confirmed");
});
test("a recorded next step cannot be replayed; changed step may proceed and stale documents cannot", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  await h.page({ type: "hello" });
  await h.page({ type: "intent", action: "next", step: "one" });
  h.restart();
  await assert.rejects(
    h.page({ type: "intent", action: "next", step: "one" }),
    /已经尝试/,
  );
  await h.page({ type: "intent", action: "next", step: "two" });
  await h.page({ type: "hello" }, 0, "new-chrome-doc");
  await assert.rejects(h.page({ type: "status", confirmed: true }), /旧文档/);
});
test("closed page is held without reopening, while unrelated queued jobs can progress", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  await h.start();
  h.tabs.splice(0, 1);
  await h.engine.tick();
  assert.equal(h.state().items[0].state, "blocked");
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, url(2));
});
test("a fill-only final page is ready, never submitted, and releases the next queued job", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  await h.start();
  await h.page({ type: "hello" });
  await h.page({ type: "status", active: true, finalReady: true });
  assert.equal(h.state().items[0].state, "ready");
  assert.equal(h.tabs.length, 2);
});

test("Apply child inherits ownership, while the parent and an unrelated duplicate stay stopped", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  await h.page({ type: "hello" });
  await h.page({ type: "intent", action: "entry", step: "apply" });
  const parent = h.tabs[0].id;
  h.tabs.push({ id: 30, openerTabId: parent, url: url(1) + "/application" });
  const child = await h.engine.page(
    { type: "hello", document: "child", url: h.tabs[1].url },
    { tabId: 30, frameId: 0, browserDocumentId: "child-doc" },
  );
  assert.equal(child.owned, true);
  assert.equal(child.mode, "fill");
  assert.equal(h.state().items[0].tabId, 30);
  assert.equal((await h.page({ type: "check" })).allowed, false);
  h.tabs.push({ id: 31, url: url(1) });
  assert.equal(
    (
      await h.engine.page(
        { type: "hello", document: "duplicate", url: url(1) },
        { tabId: 31, browserDocumentId: "duplicate-doc" },
      )
    ).allowed,
    false,
  );
});

test("explicit resume after browser restart reacquires a unique matching restored tab", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  h.browserRestart();
  h.tabs[0].id = 100;
  await h.engine.tick();
  await h.engine.command("resume", { id: h.state().items[0].id });
  assert.equal(h.state().items[0].tabId, 100);
  assert.equal((await h.page({ type: "hello" })).allowed, true);
  assert.equal(h.tabs.length, 1);
});

test("heartbeat alone cannot keep an unchanging entry page active indefinitely", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  await h.start();
  await h.page({ type: "hello" });
  await h.page({ type: "status", phase: "idle" });
  h.advance(121000);
  await h.page({ type: "status", phase: "idle" });
  await h.engine.tick();
  assert.equal(h.state().items[0].state, "waiting_input");
  assert.equal(h.tabs.length, 2);
});

test("same-origin login may enter but cannot fill, navigate a form or claim readiness for another job", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  h.io.resolve = async () => ({ state: "unmatched" });
  h.tabs[0].url = "https://jobs.ashbyhq.com/acme/login";
  assert.equal((await h.page({ type: "hello" })).entryOnly, true);
  await h.page({ type: "intent", action: "login", step: "login" });
  await assert.rejects(
    h.page({ type: "intent", action: "next", step: "wrong-job" }),
    /身份无法核实/,
  );
  await h.page({ type: "status", active: true, finalReady: true });
  assert.equal(h.state().items[0].state, "entering");
  h.tabs[0].url = url(2);
  assert.equal((await h.page({ type: "check" })).entryOnly, true);
  h.tabs[0].url = url(1) + "/application";
  assert.equal((await h.page({ type: "check" })).entryOnly, false);
  await h.page({ type: "intent", action: "next", step: "actual-job" });
});

test("cancelled queue pages remain stopped after browser session ownership is lost", async () => {
  const h = fixture();
  await h.add(1);
  await h.start();
  await h.engine.command("cancel", { id: h.state().items[0].id });
  h.browserRestart();
  const permission = await h.page({ type: "hello" });
  assert.equal(permission.owned, true);
  assert.equal(permission.allowed, false);
});

test("owner removal cancels only matching queue work without opening another job", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  await h.start();
  await h.engine.remove(url(1));
  assert.equal(h.state().items[0].state, "cancelled");
  assert.equal(h.state().items[0].paused, true);
  assert.equal(h.state().items[1].state, "queued");
  assert.equal(h.tabs.length, 1);
  h.restart();
  assert.equal((await h.page({ type: "hello" })).allowed, false);
});

for (const active of [false, true])
  test(`trusted additional matching cancels ${active ? "active and queued" : "queued"} aliases without nearby jobs`, async () => {
    const h = fixture(),
      original = "https://fixture.wd1.myworkdayjobs.com/job/Role_R123456",
      alias = original + "-1",
      nearby = original + "-2",
      foreign = alias.replace("fixture.wd1", "other.wd1");
    for (const [index, candidate] of [
      alias,
      original,
      nearby,
      foreign,
    ].entries())
      await h.engine.command("add", { jobId: id(index + 1), url: candidate });
    if (active) await h.start();
    const before = h.state(),
      calls = [],
      eventCount = h.events.length;
    await h.engine.remove(original, (...args) => {
      calls.push(args);
      return args[0] === alias;
    });
    const after = h.state();
    assert.deepEqual(after.items.slice(2), before.items.slice(2));
    for (const item of after.items.slice(0, 2)) {
      assert.equal(item.state, "cancelled");
      assert.equal(item.paused, true);
    }
    assert(
      calls.every((args) => args.length === 1 && typeof args[0] === "string"),
    );
    assert.equal(h.tabs.length, active ? 1 : 0);
    const effects = h.events.slice(eventCount);
    assert.equal(effects[0][0], "save");
    assert.equal(
      effects.filter((event) => event[0] === "control").length,
      active ? 1 : 0,
    );
    if (active) {
      const control = effects.find((event) => event[0] === "control");
      assert.equal(control[1], h.tabs[0].id);
      assert.equal(control[2].allowed, false);
      assert.equal(control[2].state, "cancelled");
    }
    assert(!effects.some((event) => ["create", "navigate"].includes(event[0])));
  });

for (const state of ["submission_uncertain", "confirmed", "cancelled"])
  test(`additional alias removal preserves ${state} history and refuses replay`, async () => {
    const h = fixture();
    h.autoSubmit(true);
    await h.add(2);
    await h.start("apply");
    await h.page({ type: "hello" });
    if (state === "cancelled")
      await h.engine.command("cancel", { id: h.state().items[0].id });
    else {
      await h.page({ type: "intent", action: "submit", step: "review" });
      if (state === "confirmed")
        await h.page({ type: "status", confirmed: true });
    }
    const before = h.state().items[0],
      eventCount = h.events.length;
    await h.engine.remove(url(1), (candidate) => candidate === url(2));
    const after = h.state().items[0];
    assert.equal(after.state, state);
    assert.equal(after.paused, true);
    for (const key of [
      "id",
      "jobId",
      "url",
      "intent",
      "documents",
      "ownerSession",
      "tabId",
    ])
      assert.deepEqual(after[key], before[key]);
    const controls = h.events
      .slice(eventCount)
      .filter((event) => event[0] === "control");
    assert.equal(controls.length, 1);
    assert.equal(controls[0][2].allowed, false);
    assert.equal(controls[0][2].state, state);
    await assert.rejects(
      h.engine.command("resume", { id: after.id }),
      /不能自动重试/,
    );
  });

test("additional matching cannot replace same-URL removal or enter through command arguments", async () => {
  const h = fixture();
  await h.add(1);
  await h.add(2);
  const alsoMatches = () => true;
  await h.engine.command("cancel", { id: h.state().items[0].id, alsoMatches });
  assert.equal(h.state().items[1].state, "queued");
  await assert.rejects(
    h.engine.command("remove", { url: url(2), alsoMatches }),
    /未知队列操作/,
  );
  await h.engine.remove(url(2), () => false);
  assert.equal(h.state().items[1].state, "cancelled");
});
