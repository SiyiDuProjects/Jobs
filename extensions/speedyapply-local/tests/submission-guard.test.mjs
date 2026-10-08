import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const sources = await Promise.all(
  ["job-match-rules", "job-match", "submission-guard"].map((name) =>
    readWithDependencies(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
  ),
);
function fixture(respond) {
  const w = new JSDOM(
    '<form><input required><button type="button">Submit</button></form>',
    {
      url: "https://jobs.ashbyhq.com/example/role/application",
      runScripts: "outside-only",
    },
  ).window;
  const messages = [],
    listeners = [];
  w.setInterval = () => assert.fail("No periodic queue work");
  w.chrome = {
    runtime: {
      id: "test",
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => {
        messages.push(message);
        return (
          (await respond?.(message)) || {
            data:
              message.type === "jobs:submission-prepare"
                ? { id: "guard" }
                : { removed: false },
          }
        );
      },
    },
  };
  for (const source of sources) w.eval(source);
  return {
    w,
    messages,
    api: w.JobsSubmissionGuard,
    remove: (sender = { id: "test" }) =>
      listeners.forEach((fn) =>
        fn(
          { type: "jobs:job-removed", url: w.location.href },
          sender,
          () => {},
        ),
      ),
    button: w.document.querySelector("button"),
  };
}

test("initialization makes no request and deletion invalidates every previously captured write guard", () => {
  const h = fixture();
  try {
    assert.equal(h.messages.length, 0);
    const guard = h.api.guard(() => true);
    assert.equal(guard(), true);
    h.remove({ id: "other" });
    assert.equal(guard(), true);
    h.remove();
    assert.equal(guard(), false);
    assert.equal(h.api.clickNavigate("next", h.button), false);
    assert.throws(() => h.api.verify());
  } finally {
    h.w.close();
  }
});

for (const action of ["next", "submit"])
  test(`${action} rejects a deletion racing its local/fresh navigation check`, async () => {
    const gate = Promise.withResolvers();
    const h = fixture((message) =>
      message.type === "jobs:removal-check" ? gate.promise : undefined,
    );
    try {
      const task = h.api.beforeNavigate(
        action,
        h.w.document.querySelector("form"),
        h.button,
      );
      h.remove();
      gate.resolve({ data: { removed: false } });
      await assert.rejects(task);
      assert.equal(
        h.messages.some(
          (message) => message.type === "jobs:submission-attempted",
        ),
        false,
      );
    } finally {
      gate.resolve({ data: { removed: false } });
      h.w.close();
    }
  });

test("only an actually dispatched submit click records attempted, then synchronous validation", async () => {
  const h = fixture();
  try {
    const form = h.w.document.querySelector("form");
    await h.api.beforeNavigate("submit", form, h.button);
    h.button.addEventListener("click", () =>
      h.w.document.querySelector("input").checkValidity(),
    );
    assert.equal(h.api.clickNavigate("submit", h.button), true);
    assert.deepEqual(
      h.messages
        .filter((message) => message.type.startsWith("jobs:submission-"))
        .map((message) => message.type),
      [
        "jobs:submission-prepare",
        "jobs:submission-attempted",
        "jobs:submission-validation-error",
      ],
    );
  } finally {
    h.w.close();
  }
});

test("an undispatched click retains preparation without inventing an attempt", async () => {
  const h = fixture();
  try {
    await h.api.beforeNavigate(
      "submit",
      h.w.document.querySelector("form"),
      h.button,
    );
    h.button.click = () => {};
    assert.equal(h.api.clickNavigate("submit", h.button), false);
    assert.equal(
      h.messages.some(
        (message) => message.type === "jobs:submission-attempted",
      ),
      false,
    );
  } finally {
    h.w.close();
  }
});
