import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
const code =
  (await readModule(
    new URL("../src/custom/platform-config.js", import.meta.url),
    "utf8",
  )) +
  "\n" +
  (await readWithDependencies(
    new URL("../src/custom/queue-page.js", import.meta.url),
    "utf8",
  ));
const sources = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const domSource = await readModule(
  new URL("../source/content/shared/dom-controls.js", import.meta.url),
  "utf8",
);
const backgroundCode = (
  await Promise.all(
    ["application-queue", "queue-background"].map((name) =>
      readModule(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(check) {
  for (let n = 0; n < 120; n++) {
    if (check()) return;
    await wait();
  }
  assert.fail("Expected page event did not happen");
}
function fixture(
  html = "",
  initial = { owned: true, allowed: true, mode: "fill", itemId: "one" },
  respond,
) {
  const dom = new JSDOM("<!doctype html><body>" + html + "</body>", {
      url: "https://fixture.myworkdayjobs.com/job/one",
      runScripts: "outside-only",
    }),
    w = dom.window;
  Object.defineProperty(w.crypto, "subtle", { value: webcrypto.subtle });
  w.TextEncoder = TextEncoder;
  const messages = [],
    listeners = [],
    timers = [];
  let state = initial;
  w.setInterval = (fn) => {
    timers.push(fn);
    return timers.length;
  };
  w.clearInterval = () => {};
  w.chrome = {
    runtime: {
      id: "extension",
      sendMessage: async (message) => {
        messages.push(message);
        const override = await respond?.(message.data || message);
        if (override) return override;
        if (message.type === "jobs:submission-prepare")
          return { data: { id: "synthetic-submission-guard" } };
        if (message.type !== "jobs:queue-page") return { data: { ok: true } };
        return {
          data:
            message.data.type === "intent" && state.owned
              ? { ok: true }
              : state,
        };
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  w.eval(code);
  return {
    w,
    messages,
    api: w.JobsQueuePage,
    timers,
    setState: (value) => (state = value),
    control: (next) => {
      state = next;
      for (const fn of listeners)
        fn(
          { type: "jobs:queue-control", state: next },
          { id: "extension" },
          () => {},
        );
    },
    close: () => w.close(),
  };
}
test("ordinary pages retain settings; queue fill mode cannot inherit automatic submission", async () => {
  for (const owned of [false, true]) {
    const h = fixture("", { owned, allowed: true, mode: "fill" });
    try {
      const original = {
        autofillSettings: {
          autoSubmit: true,
          autoClickNextPage: false,
          saveResponses: true,
        },
      };
      const actual = await h.api.configure(original);
      assert.equal(actual.autofillSettings.autoSubmit, !owned);
      assert.equal(actual.autofillSettings.autoClickNextPage, owned);
      assert.equal(original.autofillSettings.autoSubmit, true);
    } finally {
      h.close();
    }
  }
});
test("prefilled ordinary sign-in journals before one click and never transmits credentials", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve)),
    h = fixture(
      '<form><input type="email" value="fixture@example.invalid"><input type="password" value="private-fixture"><button type="button">Sign in</button></form>',
      undefined,
      async (message) => (message.type === "intent" ? held : undefined),
    );
  let clicks = 0;
  h.w.document.querySelector("button").onclick = () => clicks++;
  try {
    await until(() => h.messages.some((m) => m.data.type === "intent"));
    assert.equal(clicks, 0);
    release({ data: { ok: true } });
    await until(() => clicks === 1);
    assert(!JSON.stringify(h.messages).includes("private-fixture"));
    assert(!JSON.stringify(h.messages).includes("fixture@example.invalid"));
    assert.equal(
      h.messages.find((m) => m.data.type === "intent").data.action,
      "login",
    );
  } finally {
    h.close();
  }
});
for (const html of [
  '<input autocomplete="one-time-code">',
  '<iframe title="Security challenge"></iframe>',
  '<form><input type="email"><input type="password"><button>Sign in</button></form>',
])
  test("verification or missing credentials pauses entry without clicking", async () => {
    const h = fixture(html);
    let clicks = 0;
    h.w.document.addEventListener("click", () => clicks++);
    try {
      await until(() =>
        h.messages.some((m) => m.data.type === "status" && m.data.blocker),
      );
      assert.equal(clicks, 0);
      assert(!h.messages.some((m) => m.data.type === "intent"));
    } finally {
      h.close();
    }
  });
test("an existing application form is never mistaken for an entry Apply action", async () => {
  const h = fixture('<form><button type="submit">Apply</button></form>');
  let clicks = 0;
  h.w.document.querySelector("button").onclick = () => clicks++;
  try {
    await h.api.ready;
    await wait();
    await wait();
    assert.equal(clicks, 0);
    assert(!h.messages.some((m) => m.data.type === "intent"));
  } finally {
    h.close();
  }
});
test("pause/resume permanently invalidates an old asynchronous operation generation", async () => {
  const h = fixture();
  try {
    await h.api.ready;
    const old = h.api.guard(() => true);
    assert.equal(old(), true);
    h.control({ owned: true, allowed: false, mode: "fill", itemId: "one" });
    h.control({ owned: true, allowed: true, mode: "fill", itemId: "one" });
    await wait();
    assert.equal(old(), false);
    assert.equal(h.api.guard(() => true)(), true);
  } finally {
    h.close();
  }
});
test("pause while navigation acknowledgement is pending prevents that click even after resume", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve)),
    h = fixture(
      "<form><button>Next</button></form>",
      undefined,
      async (message) => (message.type === "intent" ? held : undefined),
    );
  try {
    await h.api.ready;
    const attempt = h.api.beforeNavigate(
      "next",
      h.w.document.querySelector("form"),
      h.w.document.querySelector("button"),
    );
    await until(() => h.messages.some((m) => m.data.type === "intent"));
    h.control({ owned: true, allowed: false, mode: "fill", itemId: "one" });
    h.control({ owned: true, allowed: true, mode: "fill", itemId: "one" });
    release({ data: { ok: true } });
    await assert.rejects(attempt, /状态已变化/);
  } finally {
    h.close();
  }
});
const rejectedIntents = [
  [
    "removed posting",
    {
      data: {
        owned: true,
        allowed: false,
        removed: true,
        state: "cancelled",
      },
    },
  ],
  ["held queue permission", { data: { owned: true, allowed: false } }],
  ["negative acknowledgement", { data: { ok: false } }],
  ["missing acknowledgement", { data: null }],
  ["worker rejection", { error: "synthetic navigation rejection" }],
];
for (const [reason, reply] of rejectedIntents) {
  for (const action of ["next", "submit"])
    test(`${action} refuses ${reason} returned only by intent, without a control broadcast`, async () => {
      const gate = Promise.withResolvers(),
        h = fixture(
          '<form><button type="button">Continue</button></form>',
          { owned: true, allowed: true, mode: "apply", itemId: "one" },
          (message) => (message.type === "intent" ? gate.promise : undefined),
        );
      let clicks = 0;
      const button = h.w.document.querySelector("button");
      button.onclick = () => clicks++;
      try {
        await h.api.ready;
        const attempt = h.api
          .beforeNavigate(action, h.w.document.querySelector("form"), button)
          .then(() => h.api.clickNavigate(action, button));
        await until(() => h.messages.some((m) => m.data?.type === "intent"));
        assert.equal(clicks, 0);
        gate.resolve(reply);
        await assert.rejects(attempt);
        assert.equal(clicks, 0);
        assert(!h.messages.some((m) => m.type === "jobs:submission-attempted"));
        if (reply.data?.owned) assert.equal(h.api.allowed(), false);
      } finally {
        gate.resolve(reply);
        h.close();
      }
    });
  test(`entry refuses ${reason} returned only by intent, without a control broadcast`, async () => {
    const gate = Promise.withResolvers(),
      h = fixture(
        '<form><input type="email" value="fixture@example.invalid"><input type="password" value="private-fixture"><button type="button">Sign in</button></form>',
        undefined,
        (message) => (message.type === "intent" ? gate.promise : undefined),
      );
    let clicks = 0;
    h.w.document.querySelector("button").onclick = () => clicks++;
    try {
      await until(() => h.messages.some((m) => m.data?.type === "intent"));
      assert.equal(clicks, 0);
      gate.resolve(reply);
      await until(() =>
        h.messages.some((m) => m.data?.type === "status" && m.data.blocker),
      );
      assert.equal(clicks, 0);
      if (reply.data?.owned) assert.equal(h.api.allowed(), false);
    } finally {
      gate.resolve(reply);
      h.close();
    }
  });
}
for (const owned of [false, true])
  test(`successful ${owned ? "queue" : "ordinary"} navigation keeps its permission semantics`, async () => {
    const h = fixture('<form><button type="button">Submit</button></form>', {
      owned,
      allowed: true,
      mode: "apply",
      itemId: owned ? "one" : undefined,
    });
    let clicks = 0;
    const button = h.w.document.querySelector("button");
    button.onclick = () => clicks++;
    try {
      await h.api.ready;
      await h.api.beforeNavigate(
        "submit",
        h.w.document.querySelector("form"),
        button,
      );
      assert.equal(h.api.clickNavigate("submit", button), true);
      assert.equal(clicks, 1);
      assert.equal(
        h.messages.filter((m) => m.data?.type === "intent").length,
        1,
      );
      assert.equal(h.api.allowed(), !owned);
      assert.equal(
        h.messages.filter((m) => m.type === "jobs:submission-attempted").length,
        1,
      );
    } finally {
      h.close();
    }
  });
for (const removedDuringPrepare of [false, true])
  test(`ordinary submission ${removedDuringPrepare ? "stops after removal" : "accepts current permission"} from the real worker after preparation`, async () => {
    const gate = Promise.withResolvers(),
      local = {},
      session = {},
      url = "https://fixture.myworkdayjobs.com/job/one",
      event = { addListener() {} };
    let listener,
      removed = false;
    const area = (values) => ({
      get: async (key) => ({ [key]: structuredClone(values[key]) }),
      set: async (data) => Object.assign(values, structuredClone(data)),
    });
    vm.runInNewContext(backgroundCode, {
      URL,
      crypto: webcrypto,
      JobsJobMatch: { key: (value) => value, same: (a, b) => a === b },
      JobsSync: {
        removalPending: async () => removed,
        resolveJob: async () => ({
          state: "matched",
          removal: { removed: false },
        }),
      },
      chrome: {
        storage: { local: area(local), session: area(session) },
        runtime: {
          id: "extension",
          getURL: (path) => "chrome-extension://extension/" + path,
          onMessage: { addListener: (fn) => (listener = fn) },
          onStartup: event,
        },
        alarms: { create() {}, onAlarm: event },
        tabs: {
          get: async () => ({ id: 1, url }),
          query: async () => [{ id: 1, url }],
          onRemoved: event,
          onUpdated: event,
        },
      },
    });
    const h = fixture(
      '<form><button type="button">Submit</button></form>',
      { owned: false, allowed: true },
      (message) => {
        if (message.type === "jobs:submission-prepare") return gate.promise;
        if (message.type.startsWith("jobs:")) return;
        return new Promise((reply) =>
          listener(
            { type: "jobs:queue-page", data: message },
            { id: "extension", tab: { id: 1, url }, url, frameId: 0 },
            reply,
          ),
        );
      },
    );
    let clicks = 0;
    const button = h.w.document.querySelector("button");
    button.onclick = () => clicks++;
    try {
      await h.api.ready;
      const attempt = h.api
        .beforeNavigate("submit", h.w.document.querySelector("form"), button)
        .then(() => h.api.clickNavigate("submit", button));
      await until(() =>
        h.messages.some((m) => m.type === "jobs:submission-prepare"),
      );
      assert.equal(h.api.allowed(), true);
      removed = removedDuringPrepare;
      gate.resolve({ data: { id: "synthetic-submission-guard" } });
      if (removedDuringPrepare) await assert.rejects(attempt);
      else assert.equal(await attempt, true);
      assert.equal(clicks, removedDuringPrepare ? 0 : 1);
      assert.equal(h.api.allowed(), !removedDuringPrepare);
      assert.equal(
        h.messages.filter((m) => m.data?.type === "intent").length,
        1,
      );
      assert.equal(
        h.messages.filter((m) => m.type === "jobs:submission-attempted").length,
        removedDuringPrepare ? 0 : 1,
      );
    } finally {
      gate.resolve({ data: { id: "synthetic-submission-guard" } });
      h.close();
    }
  });
for (const type of ["hello", "check"])
  test(`a stale ${type} permission cannot revive a removed ordinary page`, async () => {
    const gate = Promise.withResolvers(),
      h = fixture(
        '<button type="button">Continue</button>',
        { owned: false, allowed: true },
        (message) => (message.type === type ? gate.promise : undefined),
      );
    try {
      const attempt = type === "hello" ? h.api.ready : h.api.verify();
      await until(() => h.messages.some((m) => m.data?.type === type));
      h.control({ owned: true, allowed: false, removed: true });
      gate.resolve({ data: { owned: false, allowed: true } });
      if (type === "hello") await attempt;
      else await assert.rejects(attempt);
      assert.equal(h.api.allowed(), false);
      assert.equal(h.api.guard(() => true)(), false);
      assert.equal(
        h.w.JobsPageActions.click(h.w.document.querySelector("button")),
        false,
      );
    } finally {
      gate.resolve({ data: { owned: false, allowed: true } });
      h.close();
    }
  });
test("entry accepts an explicit ordinary-page permission returned by intent", async () => {
  const h = fixture(
    '<form><input type="email" value="fixture@example.invalid"><input type="password" value="private-fixture"><button type="button">Sign in</button></form>',
    undefined,
    (message) =>
      message.type === "intent"
        ? { data: { owned: false, allowed: true } }
        : undefined,
  );
  let clicks = 0;
  h.w.document.querySelector("button").onclick = () => clicks++;
  try {
    await until(() => clicks === 1);
    assert.equal(h.api.allowed(), true);
    assert.equal(h.messages.filter((m) => m.data?.type === "intent").length, 1);
  } finally {
    h.close();
  }
});
test("native writes, old click/upload helpers and an async Workday option all honor pause", async () => {
  const h = fixture(
    '<input id="text"><select id="select"><option>A</option><option>B</option></select><button id="button">Choice</button><input type="file" id="file"><div data-automation-id="multiSelectContainer"><input aria-label="Field of Study" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="major"><ul data-automation-id="selectedItemList"></ul></div><div data-uxi-popup-anchor="major"></div>',
  );
  try {
    await h.api.ready;
    sources.forEach((source) => h.w.eval(source));
    h.w.eval(domSource);
    let clicks = 0;
    h.w.document.querySelector("#button").onclick = () => clicks++;
    const search = h.w.document.querySelector("[data-uxi-widget-type]"),
      pending = h.w.JobsControlFields.chooseSpec(
        search,
        h.w.JobsProfileAnswers.literalSpec("major", "Physics"),
      );
    await wait();
    h.control({ owned: true, allowed: false, mode: "fill", itemId: "one" });
    assert.equal(
      h.w.JobsControlFields.writeValue(
        h.w.document.querySelector("#text"),
        "wrong",
      ),
      null,
    );
    assert.equal(
      h.w.JobsControlFields.writeSelect(h.w.document.querySelector("#select"), [
        "B",
      ]),
      null,
    );
    h.w.jobsClickValue("#button");
    h.w.jobsUploadResumeValue({}, "#file");
    assert.equal(clicks, 0);
    assert.equal(h.w.document.querySelector("#text").value, "");
    h.control({ owned: true, allowed: true, mode: "fill", itemId: "one" });
    const option = h.w.document.createElement("div");
    option.setAttribute("role", "option");
    option.textContent = "Physics";
    option.onclick = () => clicks++;
    h.w.document.querySelector("[data-uxi-popup-anchor]").append(option);
    assert.equal(await pending, null);
    assert.equal(clicks, 0, "the old search cannot revive after resume");
  } finally {
    h.close();
  }
});
test("a page or foreign sender cannot issue queue-control commands", async () => {
  const h = fixture();
  try {
    await h.api.ready;
    h.w.postMessage(
      { type: "jobs:queue-control", state: { allowed: false } },
      "*",
    );
    await wait();
    assert.equal(h.api.allowed(), true);
  } finally {
    h.close();
  }
});

test("entry-only pages cannot initialize form filling and returning to the verified job resumes pending work", async () => {
  const h = fixture("", {
    owned: true,
    allowed: true,
    mode: "fill",
    entryOnly: true,
  });
  let resumes = 0;
  try {
    h.api.attach({ resume: () => resumes++ });
    await assert.rejects(
      h.api.configure({ autofillSettings: {} }),
      /尚未核对同一岗位/,
    );
    await wait();
    h.setState({ owned: true, allowed: true, mode: "fill", entryOnly: false });
    h.timers[0]();
    await until(() => resumes === 1);
    assert.equal(
      (await h.api.configure({ autofillSettings: {} })).autofillSettings
        .autoSubmit,
      false,
    );
  } finally {
    h.close();
  }
});

test("owner removal cancels ordinary pending work and stale permissions cannot revive it", async () => {
  const h = fixture("<button>Next</button>", { owned: false, allowed: true });
  try {
    await h.api.ready;
    let cancelled = 0;
    h.api.attach({
      cancel: () => cancelled++,
      pending: () => true,
      state: () => ({}),
    });
    const oldGuard = h.api.guard(() => true);
    h.control({
      owned: true,
      allowed: false,
      removed: true,
      state: "cancelled",
    });
    assert.equal(cancelled, 1);
    assert.equal(oldGuard(), false);
    assert.equal(h.api.allowed(), false);
    h.control({ owned: false, allowed: true });
    assert.equal(h.api.allowed(), false);
    await assert.rejects(h.api.verify());
    assert.equal(
      h.w.JobsPageActions.click(h.w.document.querySelector("button")),
      false,
    );
  } finally {
    h.close();
  }
});

test("persisted removal stops an ordinary page at startup and is checked before navigation", async () => {
  const h = fixture("", { owned: true, allowed: false, removed: true });
  try {
    await h.api.ready;
    assert.equal(h.api.allowed(), false);
    await assert.rejects(h.api.configure({ autofillSettings: {} }));
  } finally {
    h.close();
  }
});
