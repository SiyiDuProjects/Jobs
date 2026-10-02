import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const code = await readModule(
  new URL("../src/custom/site-bridge.js", import.meta.url),
  "utf8",
);
const origin = "https://jobs.siyidu.com";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("disconnect wins over an earlier connection response and bridge initialization is idempotent", async () => {
  const dom = new JSDOM("<body/>", { url: origin, runScripts: "outside-only" }),
    w = dom.window;
  let release,
    connected = false,
    disabled = false;
  const gate = new Promise((r) => {
      release = r;
    }),
    requests = [],
    messages = [],
    posts = [];
  w.AbortSignal = AbortSignal;
  w.postMessage = (data) => posts.push(data);
  w.chrome = {
    runtime: {
      id: "fixture",
      sendMessage: async (message) => {
        messages.push(message.type);
        if (message.type === "jobs:sync-connect") {
          connected = true;
          disabled = false;
          return { ok: true };
        }
        if (message.type === "jobs:sync-disconnect") {
          connected = false;
          disabled = true;
          return { ok: true };
        }
        return {
          connected,
          profilesConnected: connected,
          disabled,
          deviceId: "fixture",
          extensionId: "fixture",
        };
      },
      onMessage: { addListener() {} },
    },
  };
  w.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/connect")) await gate;
    return {
      ok: true,
      json: async () => ({
        token: "PRIVATE_TOKEN",
        profile_token: "PRIVATE_PROFILE_TOKEN",
      }),
    };
  };
  try {
    w.eval(code);
    w.eval(code);
    await tick();
    assert.equal(requests.filter((u) => u.endsWith("/connect")).length, 1);
    w.dispatchEvent(
      new w.MessageEvent("message", {
        source: w,
        origin,
        data: { type: "jobs:extension-disconnect" },
      }),
    );
    await tick();
    release();
    for (let i = 0; i < 20 && !disabled; i++) await tick();
    assert(disabled);
    assert(!connected);
    assert(
      messages.indexOf("jobs:sync-connect") <
        messages.indexOf("jobs:sync-disconnect"),
    );
    assert.equal(requests.filter((u) => u.endsWith("/disconnect")).length, 1);
    assert(!JSON.stringify(posts).includes("PRIVATE_"));
  } finally {
    release();
    await tick();
    w.close();
  }
});

test("extension reload leaves normal and middle-click links usable, including synchronous context invalidation", async () => {
  for (const mode of ["missing-id", "throws-on-send"]) {
    const dom = new JSDOM(
        '<a data-jobs-id="aaaaaaaaaaaaaaaaaaaaaaaa" data-jobs-kind="intern" href="https://ats.example/intern">Apply</a>',
        { url: origin, runScripts: "outside-only" },
      ),
      w = dom.window;
    const handlers = {},
      removed = [],
      posts = [];
    const add = w.document.addEventListener.bind(w.document),
      remove = w.document.removeEventListener.bind(w.document);
    w.document.addEventListener = (type, fn, ...rest) => {
      handlers[type] = fn;
      add(type, fn, ...rest);
    };
    w.document.removeEventListener = (type, fn, ...rest) => {
      removed.push(type);
      remove(type, fn, ...rest);
    };
    let invalid = false,
      opens = 0;
    w.postMessage = (data) => posts.push(data);
    w.chrome = {
      runtime: {
        get id() {
          return invalid && mode === "missing-id" ? undefined : "fixture";
        },
        sendMessage: (message) => {
          if (invalid) throw Error("Extension context invalidated.");
          if (message.type === "jobs:site-links") {
            opens++;
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve({ connected: true, profilesConnected: true });
        },
        onMessage: { addListener() {} },
      },
    };
    try {
      w.eval(code);
      await tick();
      const published = opens;
      let prevented = false;
      handlers.click({
        isTrusted: true,
        button: 0,
        target: w.document.querySelector("a"),
        preventDefault() {
          prevented = true;
        },
      });
      await tick();
      assert.equal(
        prevented,
        false,
        "even a healthy extension must not own navigation",
      );
      assert.equal(opens, published + 1);
      invalid = true;
      for (const button of [0, 1]) {
        prevented = false;
        assert.doesNotThrow(() =>
          handlers[button ? "auxclick" : "click"]({
            isTrusted: true,
            button,
            target: w.document.querySelector("a"),
            preventDefault() {
              prevented = true;
            },
          }),
        );
        assert.equal(
          prevented,
          false,
          "invalid extension must not cancel native link navigation",
        );
      }
      await tick();
      assert(removed.includes("click") && removed.includes("auxclick"));
      assert.equal(opens, published + 1);
      if (mode === "missing-id")
        assert(posts.some((p) => p.error?.includes("刷新本页")));
    } finally {
      w.close();
    }
  }
});

for (const failure of ["pending-answer", "server-offline", "none"])
  test(`disconnect preserves pending answers and reports the actual local state: ${failure}`, async () => {
    const dom = new JSDOM("<body/>", {
        url: origin,
        runScripts: "outside-only",
      }),
      w = dom.window;
    const posts = [],
      order = [];
    let disabled = false;
    w.AbortSignal = AbortSignal;
    w.postMessage = (value) => posts.push(value);
    w.chrome = {
      runtime: {
        id: "fixture",
        onMessage: { addListener() {} },
        sendMessage: async (msg) => {
          if (msg.type === "jobs:sync-disconnect") {
            order.push("local-stop");
            if (failure === "pending-answer")
              return { error: "个人回答尚未同步，草稿已保留" };
            disabled = true;
            return { ok: true };
          }
          return {
            connected: !disabled,
            profilesConnected: !disabled,
            disabled,
            deviceId: "fixture",
          };
        },
      },
    };
    w.fetch = async () => {
      order.push("server-revoke");
      return { ok: failure !== "server-offline" };
    };
    try {
      w.eval(code);
      await tick();
      w.dispatchEvent(
        new w.MessageEvent("message", {
          source: w,
          origin,
          data: { type: "jobs:extension-disconnect" },
        }),
      );
      await tick();
      await tick();
      if (failure === "pending-answer") {
        assert.deepEqual(order, ["local-stop"]);
        assert.equal(posts.at(-1).connected, true);
        assert.match(posts.at(-1).error, /草稿已保留/);
      } else {
        assert.deepEqual(order, ["local-stop", "server-revoke"]);
        assert.equal(posts.at(-1).disabled, true);
        if (failure === "server-offline")
          assert.match(posts.at(-1).error, /插件已停止.*尚未撤销/);
        else assert.equal(posts.at(-1).error, "");
      }
    } finally {
      w.close();
    }
  });
