import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { createOperatorState } from "../src/custom/operator-state.js";
import { createReviewLoader } from "../src/custom/deferred-review-view.js";
const pageSource = await readModule(
  new URL("../src/custom/page-review.js", import.meta.url),
  "utf8",
);
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(loadView, child = false) {
  const top = new JSDOM("<body><iframe></iframe></body>", {
    url: "https://fixture.test/apply",
    runScripts: "outside-only",
  }).window;
  const w = child ? top.document.querySelector("iframe").contentWindow : top;
  w.chrome = {
    runtime: { getURL: (path) => "chrome-extension://fixture/" + path },
  };
  w.eval(pageSource);
  const operator = createOperatorState();
  operator.update({ mode: "person", epoch: "person" });
  const page = w.createPageReview({
    operator,
    loadView,
    claim: async () => operator.update({ mode: "page-tool", epoch: "claim" }),
  });
  return {
    w,
    operator,
    page,
    close: () => {
      page.dispose();
      top.close();
    },
  };
}
const data = (id) => ({ id, items: [], canConfirm: true });
function viewRecorder() {
  const calls = [],
    renders = [];
  return {
    calls,
    renders,
    create: () => {
      calls.push("create");
      return {
        attach: () => calls.push("attach"),
        expand: () => calls.push("expand"),
        show: (value, action) => renders.push({ value, action }),
      };
    },
  };
}
test("deferred module transport deduplicates requests and retries a failed import", async () => {
  let calls = 0;
  const pending = gate(),
    createReviewView = () => {};
  const load = createReviewLoader(() => {
    calls++;
    return pending.promise;
  });
  const first = load(),
    second = load();
  assert.equal(first, second);
  await turn();
  assert.equal(calls, 1);
  pending.resolve({ createReviewView });
  assert.equal(await first, createReviewView);
  assert.equal(await load(), createReviewView);
  let attempts = 0;
  const retry = createReviewLoader(async () => {
    if (++attempts === 1) throw Error("Unavailable");
    return { createReviewView };
  });
  await assert.rejects(retry(), /Unavailable/);
  assert.equal(await retry(), createReviewView);
  assert.equal(attempts, 2);
});
test("child frames never import or mount the editor while status-only top pages stay lightweight", async () => {
  for (const child of [true, false]) {
    let loads = 0;
    const h = fixture(async () => {
      loads++;
      return viewRecorder().create;
    }, child);
    try {
      h.operator.update({ mode: "page-tool", epoch: "agent" });
      h.page.status({ id: "status", canFill: true });
      h.page.expand();
      await turn();
      assert.equal(loads, 0);
      h.page.show(data("review"), () => {});
      await turn();
      assert.equal(loads, child ? 0 : 1);
      assert.equal(
        h.w.document.querySelectorAll("[data-jobs-operator]").length,
        child ? 0 : 1,
      );
    } finally {
      h.close();
    }
  }
});
test("late UI loading renders only the latest review and stale callbacks never target its successor", async () => {
  const pending = gate(),
    view = viewRecorder(),
    actions = [];
  let loads = 0;
  const h = fixture(() => {
    loads++;
    return pending.promise;
  });
  try {
    h.page.show(data("old"), () => actions.push("old"));
    await turn();
    assert.equal(loads, 0, "person review uses the side panel");
    h.operator.update({ mode: "page-tool", epoch: "agent" });
    await turn();
    h.page.show(data("latest"), () => actions.push("latest"));
    pending.resolve(view.create);
    await turn();
    assert.equal(loads, 1);
    assert.equal(view.renders.at(-1).value.id, "latest");
    assert(!view.renders.some((render) => render.value?.id === "old"));
    const stale = view.renders.at(-1).action;
    h.page.show(data("successor"), () => actions.push("successor"));
    assert((await stale("confirm")).error);
    assert.deepEqual(actions, []);
    await view.renders.at(-1).action("confirm");
    assert.deepEqual(actions, ["successor"]);
  } finally {
    h.close();
  }
});
test("hand-back, cleared review and disposal cancel a pending UI mount without reclaiming ownership", async () => {
  for (const cancel of ["hand-back", "clear", "dispose"]) {
    const pending = gate(),
      view = viewRecorder();
    const h = fixture(() => pending.promise);
    try {
      h.operator.update({ mode: "page-tool", epoch: "agent" });
      h.page.show(data("review"), () => assert.fail("stale write"));
      await turn();
      if (cancel === "hand-back")
        h.operator.update({ mode: "person", epoch: "returned" });
      if (cancel === "clear") h.page.show(null);
      if (cancel === "dispose") h.page.dispose();
      pending.resolve(view.create);
      await turn();
      assert.deepEqual(view.calls, []);
      if (cancel === "hand-back")
        assert.equal(h.operator.read().mode, "person");
      if (cancel === "dispose")
        assert.equal(h.w.document.querySelector("[data-jobs-operator]"), null);
    } finally {
      h.close();
    }
  }
});
test("failed UI loading leaves the review guarded and an explicit retry can mount it", async () => {
  const view = viewRecorder();
  let attempts = 0;
  const h = fixture(async () => {
    if (++attempts === 1) throw Error("Module unavailable");
    return view.create;
  });
  try {
    h.operator.update({ mode: "page-tool", epoch: "agent" });
    h.page.show(data("review"), () => {});
    await turn();
    const toggle = h.w.document
      .querySelector("[data-jobs-operator]")
      .shadowRoot.querySelector("button");
    assert.equal(toggle.textContent, "重试补答");
    assert.equal(attempts, 1);
    h.page.status({ id: "status", text: "waiting" });
    await turn();
    assert.equal(attempts, 1);
    await toggle.onclick({ isTrusted: true });
    await turn();
    assert.equal(attempts, 2);
    assert.equal(view.renders.at(-1).value.id, "review");
  } finally {
    h.close();
  }
});

test("an in-flight ownership claim cannot prepare a disposed page", async () => {
  const top = new JSDOM("<body></body>", {
    url: "https://fixture.test/apply",
    runScripts: "outside-only",
  }).window;
  const claim = gate(),
    operator = createOperatorState();
  let writes = 0;
  top.chrome = {
    runtime: { getURL: (path) => "chrome-extension://fixture/" + path },
  };
  top.eval(pageSource);
  operator.update({ mode: "page-tool", epoch: "agent" });
  const page = top.createPageReview({
    operator,
    claim: () => claim.promise,
    loadView: async () => viewRecorder().create,
  });
  try {
    page.status({ id: "page", canFill: true }, () => writes++);
    const buttons = top.document
      .querySelector("[data-jobs-operator]")
      .shadowRoot.querySelectorAll("button");
    const prepare = [...buttons].find(
      (button) => button.textContent === "准备本页回答",
    );
    const pending = prepare.onclick({ isTrusted: true });
    page.dispose();
    claim.resolve();
    await pending;
    assert.equal(writes, 0);
    assert.equal(top.document.querySelector("[data-jobs-operator]"), null);
  } finally {
    page.dispose();
    top.close();
  }
});
