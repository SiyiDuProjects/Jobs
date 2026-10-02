import { readModule } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const memoryCode = (
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "control-fields",
      "workday-controls",
      "answer-memory",
      "manual-answer",
    ].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");

function setup(enabled = true) {
  const dom = new JSDOM(
    "<form><label>Why this team?<textarea></textarea></label></form>",
    {
      url: "https://jobs.ashbyhq.com/fixture/role/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    saved = [],
    ports = [],
    states = [],
    errors = [],
    node = w.document.querySelector("textarea");
  w.chrome = {
    runtime: {
      connect() {
        const port = {
          onMessage: {
            addListener(fn) {
              port.receive = fn;
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.lost = fn;
            },
          },
          postMessage(msg) {
            port.request = msg;
          },
          disconnect() {
            port.disconnected = true;
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  w.eval(memoryCode);
  w.JobsAnswerMemory.start(w.document, enabled, (rows) => saved.push(...rows));
  w.testNode = node;
  w.setState = (state) => states.push(state);
  w.setError = (error) => errors.push(error);
  w.generate = () =>
    w.JobsManualAnswer.start(node, {
      prompt: "Why this team?",
      additionalContext: "",
      onState: w.setState,
      onError: w.setError,
      onComplete: () => {},
    });
  return {
    w,
    node,
    saved,
    ports,
    states,
    errors,
    generate: () => w.generate(),
    close: () => dom.window.close(),
  };
}

test("actual Luna completion saves only the final text through ordinary answer memory", async () => {
  const h = setup();
  try {
    h.node.value = "Original";
    h.generate();
    const port = h.ports[0];
    assert.equal(port.request.prompt, "Why this team?");
    port.receive({ type: "STREAM_UPDATE", text: "Partial" });
    assert.equal(h.saved.length, 0);
    port.receive({ type: "STREAM_UPDATE", text: "Final supported answer" });
    assert.equal(h.saved.length, 0);
    await port.receive({
      type: "STREAM_END",
      responseId: "test",
      source: "suggestion",
    });
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].question, "Why this team?");
    assert.equal(h.saved[0].response, "Final supported answer");
    assert.equal(h.states.at(-1), "finished");
    assert(port.disconnected);
  } finally {
    h.close();
  }
});

test("actual Luna error restores prior text and never learns the partial answer or error message", () => {
  const h = setup();
  try {
    h.node.value = "Original";
    h.generate();
    const port = h.ports[0];
    port.receive({ type: "STREAM_UPDATE", text: "Partial" });
    port.receive({ type: "STREAM_ERROR", error: "需要你确认：缺少个人事实" });
    assert.equal(h.node.value, "Original");
    assert.equal(h.saved.length, 0);
    assert.equal(h.states.at(-1), "error");
    assert.equal(h.errors.at(-1), "需要你确认：缺少个人事实");
    assert(port.disconnected);
  } finally {
    h.close();
  }
});

test("worker disconnect restores the preexisting answer rather than leaving a blank or partial draft", () => {
  for (const partial of ["", "Unfinished draft"]) {
    const h = setup();
    try {
      h.node.value = "Original answer";
      h.generate();
      const port = h.ports[0];
      if (partial) port.receive({ type: "STREAM_UPDATE", text: partial });
      port.lost();
      assert.equal(h.node.value, "Original answer");
      assert.equal(h.saved.length, 0);
      assert.equal(h.states.at(-1), "error");
    } finally {
      h.close();
    }
  }
});

test("late success and failure cannot overwrite text edited while Generate Answer is pending", async () => {
  for (const type of ["STREAM_UPDATE", "STREAM_ERROR", "STREAM_END"]) {
    const h = setup();
    try {
      h.node.value = "Original";
      h.generate();
      const port = h.ports[0];
      h.node.value = "User correction";
      h.node.dispatchEvent(new h.w.Event("input", { bubbles: true }));
      await port.receive({
        type,
        text: "Old model answer",
        error: "Old error",
        source: "suggestion",
      });
      assert.equal(h.node.value, "User correction");
      assert.equal(h.saved.length, 0);
      assert(port.disconnected);
    } finally {
      h.close();
    }
  }
});

test("an old request cannot write after a new request or a silent form change", async () => {
  const h = setup();
  try {
    h.generate();
    const first = h.ports[0];
    h.generate();
    const second = h.ports[1];
    await first.receive({ type: "STREAM_UPDATE", text: "Old request" });
    assert.equal(h.node.value, "");
    await second.receive({ type: "STREAM_UPDATE", text: "New request" });
    assert.equal(h.node.value, "New request");
    h.node.value = "Form replaced value";
    await second.receive({ type: "STREAM_ERROR", error: "Late failure" });
    assert.equal(h.node.value, "Form replaced value");
  } finally {
    h.close();
  }
});

test("edits during the final asynchronous commit are not learned as AI output", async () => {
  const h = setup();
  try {
    h.generate();
    const port = h.ports[0];
    await port.receive({ type: "STREAM_UPDATE", text: "Generated" });
    const ending = port.receive({ type: "STREAM_END", source: "suggestion" });
    h.node.value = "Edited during blur";
    h.node.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await ending;
    assert.equal(h.node.value, "Edited during blur");
    assert.equal(h.saved.length, 0);
  } finally {
    h.close();
  }
});

test("Luna remembers after the final change and blur have committed synchronous validation", async () => {
  const h = setup();
  try {
    h.node.setAttribute("aria-invalid", "true");
    h.node.addEventListener("change", () =>
      h.node.removeAttribute("aria-invalid"),
    );
    h.generate();
    const port = h.ports[0];
    port.receive({ type: "STREAM_UPDATE", text: "Final supported answer" });
    await port.receive({
      type: "STREAM_END",
      responseId: "test",
      source: "suggestion",
    });
    assert.equal(h.node.hasAttribute("aria-invalid"), false);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].response, "Final supported answer");
  } finally {
    h.close();
  }
});

test("manual Generate Answer also labels profile facts and excludes them from Saved Responses", async () => {
  const h = setup();
  try {
    h.generate();
    const port = h.ports[0];
    port.receive({ type: "STREAM_UPDATE", text: "Profile-derived text" });
    await port.receive({
      type: "STREAM_END",
      responseId: "test",
      source: "profile",
    });
    assert.equal(h.node.value, "Profile-derived text");
    assert.equal(h.saved.length, 0);
    assert.equal(h.node.dataset.jobsAnswerSource, "profile");
  } finally {
    h.close();
  }
});

test("actual Luna callback respects disabled saving and cannot save a removed textarea", async () => {
  for (const enabled of [false, true]) {
    const h = setup(enabled);
    try {
      h.generate();
      const port = h.ports[0];
      if (enabled) h.node.remove();
      port.receive({ type: "STREAM_UPDATE", text: "Complete answer" });
      await port.receive({ type: "STREAM_END", responseId: "test" });
      assert.equal(h.saved.length, 0);
    } finally {
      h.close();
    }
  }
});

test("Luna worker sends the initiating tab Profile reference and version without personal facts", async () => {
  const background = await readModule(
    new URL("../source/background-api.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM("", { runScripts: "outside-only" }),
    w = dom.window,
    payloads = [],
    events = [];
  let connect, receive;
  const bound = {
    id: "intern-id",
    lastSync: "2026-09-26T01:00:00Z",
    profile: { profileName: "Intern", employmentData: { sponsorship: false } },
  };
  try {
    w.chrome = {
      runtime: {
        id: "fixture",
        onMessage: { addListener() {} },
        onConnect: { addListener: (fn) => (connect = fn) },
      },
    };
    w.JobsAnswerContext = {
      create: async (sender) => {
        assert.equal(sender.tab.id, 17);
        return {
          bound,
          job: { title: "Intern", description: "Test" },
          verify: async () => {},
        };
      },
    };
    w.JobsSync = {
      generateAnswer: async (payload) => {
        payloads.push(payload);
        return { text: "Answer", source: "profile" };
      },
    };
    w.eval(background);
    connect({
      name: "generate-response",
      sender: { id: "fixture", tab: { id: 17 } },
      onMessage: { addListener: (fn) => (receive = fn) },
      onDisconnect: { addListener() {} },
      postMessage: (value) => events.push(value),
    });
    await receive({
      type: "GENERATE_RESPONSE",
      prompt: "Question",
      additionalContext: "Context",
    });
    assert.equal(payloads[0].profileId, "intern-id");
    assert.equal(payloads[0].profileVersion, bound.lastSync);
    assert.equal(payloads[0].profile, undefined);
    assert.equal(events[0].text, "Answer");
    assert.equal(events.at(-1).type, "STREAM_END");
  } finally {
    dom.window.close();
  }
});
