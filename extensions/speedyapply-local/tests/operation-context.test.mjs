import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const sources = Object.fromEntries(
  await Promise.all(
    [
      "option-match",
      "profile-answers",
      "dom-wait",
      "control-fields",
      "operation-context",
      "control-content",
      "review-presenter",
      "ai-review",
      "automatic-fill",
    ].map(async (name) => [
      name,
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ]),
  ),
);
async function setup(entry, { complete = false } = {}) {
  const dom = new JSDOM(
    `<form aria-labelledby="job-application-form"><label>Question<input required value="${complete ? "Ready" : ""}"></label><button type="button" class="ashby-application-form-submit-button">Submit</button></form>`,
    {
      url: "https://jobs.ashbyhq.com/fixture/role/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    profile = { profileName: "Fixture", personalData: { firstName: "Test" } },
    listeners = [],
    storage = new Set(),
    trusted = new Map(),
    checks = [];
  let live = profile,
    clicks = 0,
    hook = async () => {},
    invalidated = [],
    known = async () => [{ index: 0, answer: "Confirmed answer" }];
  w.JobsControlConfig = { enabled: entry === "remote", observe: true };
  w.chrome = {
    storage: {
      onChanged: {
        addListener: (fn) => storage.add(fn),
        removeListener: (fn) => storage.delete(fn),
      },
    },
    runtime: {
      id: "fixture",
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile") {
          checks.push(message.verify === true);
          await hook(message);
          return {
            data:
              live === null
                ? null
                : {
                    id: "fixture",
                    tabId: 1,
                    profile: message.verify ? live : profile,
                  },
          };
        }
        if (message.type === "jobs:auto-answers")
          throw Error("These tests use confirmed values, never AI");
        return {};
      },
    },
  };
  const add = doc.addEventListener.bind(doc),
    remove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, fn, ...args) => {
    if (!trusted.has(type)) trusted.set(type, new Set());
    trusted.get(type).add(fn);
    return add(type, fn, ...args);
  };
  doc.removeEventListener = (type, fn, ...args) => {
    trusted.get(type)?.delete(fn);
    return remove(type, fn, ...args);
  };
  for (const name of [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "operation-context",
  ])
    w.eval(sources[name]);
  const root = doc.querySelector("form");
  doc.querySelector("button").onclick = () => clicks++;
  const send = (message) =>
    new Promise((resolve) => {
      for (const listener of listeners)
        listener(message, { id: "fixture" }, resolve);
    });
  const inspect = async () => {
    const reply = await send({ type: "jobs:control-inspect" });
    assert(!reply.error, reply.error);
    return reply.data;
  };
  const command = async (action = "fill_answers") => {
    const page = await inspect();
    return {
      id: "once",
      target: { documentId: page.documentId, revision: page.revision },
      expiresAt: Date.now() + 10000,
      action,
      args:
        action === "fill_answers"
          ? {
              answers: [
                {
                  fieldId: page.fields[0].id,
                  value: "Confirmed answer",
                  replace: true,
                },
              ],
            }
          : undefined,
    };
  };
  if (entry === "remote") {
    w.eval(sources["control-content"]);
    await w.JobsPageSession.run(
      async (options) => {
        await options.getProfile();
        options.setMessage("autofill-complete");
      },
      {
        jobsAdapterId: "ashby",
        getProfile: async () => profile,
        setMessage() {},
        ctx: { onInvalidated: (fn) => invalidated.push(fn) },
      },
    );
  } else
    for (const name of ["review-presenter", "ai-review", "automatic-fill"])
      w.eval(sources[name]);
  const run = async (action = "fill") =>
    entry === "remote"
      ? send({
          type: "jobs:control-execute",
          command: await command(
            action === "submit" ? "submit" : "fill_answers",
          ),
        })
      : w.JobsAutomatic.advance({
          root,
          profile,
          action,
          selector: "button",
          resolveAnswers: (...args) => known(...args),
        });
  return {
    w,
    doc,
    root,
    profile,
    checks,
    run,
    command,
    execute: (command) => send({ type: "jobs:control-execute", command }),
    clicks: () => clicks,
    setProfile: (value) => {
      live = value;
    },
    onCheck: (fn) => {
      hook = fn;
    },
    resolve: (fn) => {
      known = fn;
    },
    invalidate: () => invalidated.forEach((fn) => fn()),
    edit: () => {
      const node = doc.querySelector("input");
      for (const fn of trusted.get("keydown") || [])
        fn({ type: "keydown", isTrusted: true, target: node });
      node.value = "User answer";
    },
    storageChange: (tabId = 1, stored = { id: "fixture", profile: live }) => {
      for (const fn of storage)
        fn(
          {
            ["profile_" + tabId]: {
              oldValue: { id: "fixture", profile },
              newValue: stored,
            },
          },
          "session",
        );
    },
    close: () => w.close(),
  };
}

test("shared resume references preserve unchanged runs and still invalidate changed attachments", async () => {
  const h = await setup("automatic");
  let operation;
  try {
    h.profile.resumeData = {
      resumeBase64: "synthetic-content",
      fileName: "synthetic.pdf",
    };
    const send = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = async (message) => {
      const response = await send(message);
      if (response?.data?.profile)
        response.data.resumeRef = "original-attachment";
      return response;
    };
    operation = h.w.JobsOperationContext.create({
      root: h.root,
      profile: h.profile,
      profileId: "fixture",
    });
    await operation.verify();
    const stored = {
      id: "fixture",
      resumeRef: "original-attachment",
      profile: { ...h.profile, resumeData: { fileName: "synthetic.pdf" } },
    };
    h.storageChange(1, stored);
    operation.assertCurrent();
    h.storageChange(1, { ...stored, resumeRef: "changed-attachment" });
    assert.throws(() => operation.assertCurrent(), /Profile 已改变/);
  } finally {
    operation?.release();
    h.close();
  }
});

for (const entry of ["automatic", "remote"]) {
  test(`${entry} stops a changed bound Profile before writing`, async () => {
    const h = await setup(entry);
    try {
      let verified = 0;
      if (entry === "automatic")
        h.resolve(async () => {
          h.setProfile({
            ...h.profile,
            personalData: { firstName: "Updated" },
          });
          h.storageChange();
          return [{ index: 0, answer: "Confirmed answer" }];
        });
      h.onCheck((message) => {
        if (message.verify && ++verified === 2)
          h.setProfile({
            ...h.profile,
            personalData: { firstName: "Updated" },
          });
      });
      await h.run();
      assert.equal(h.doc.querySelector("input").value, "");
      assert.equal(h.clicks(), 0);
      if (entry === "remote")
        assert(
          verified >= 2,
          "latest Profile is checked again at the field commit boundary",
        );
    } finally {
      h.close();
    }
  });
  test(`${entry} stops a removed Profile before writing`, async () => {
    const h = await setup(entry);
    try {
      h.setProfile(null);
      await h.run();
      assert.equal(h.doc.querySelector("input").value, "");
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  });
  for (const change of ["user-edit", "root-replaced", "root-moved", "pagehide"])
    test(`${entry} cancels ${change} while Profile verification is pending`, async () => {
      const h = await setup(entry);
      try {
        let changed = false;
        h.onCheck(async (message) => {
          if ((entry === "remote" && !message.verify) || changed) return;
          changed = true;
          await Promise.resolve();
          if (change === "user-edit") h.edit();
          if (change === "root-replaced")
            h.root.replaceWith(h.root.cloneNode(true));
          if (change === "root-moved") {
            const box = h.doc.createElement("section");
            h.doc.body.append(box);
            box.append(h.root);
          }
          if (change === "pagehide")
            h.w.dispatchEvent(new h.w.Event("pagehide"));
        });
        await h.run();
        assert.equal(
          h.doc.querySelector("input").value,
          change === "user-edit" ? "User answer" : "",
        );
        assert.equal(h.clicks(), 0);
      } finally {
        h.close();
      }
    });
  test(`${entry} bound Profile invalidation prevents navigation`, async () => {
    const h = await setup(entry, { complete: true });
    try {
      let scheduled = false;
      h.onCheck(() => {
        if (scheduled) return;
        scheduled = true;
        h.w.setTimeout(() => {
          h.setProfile({
            ...h.profile,
            personalData: { firstName: "Updated" },
          });
          h.storageChange();
        }, 0);
      });
      await h.run("submit");
      assert.equal(h.clicks(), 0);
      assert.equal(h.doc.querySelector("input").value, "Ready");
    } finally {
      h.close();
    }
  });
  test(`${entry} unchanged Profile fills or submits once`, async () => {
    const h = await setup(entry);
    try {
      if (entry === "remote") {
        const command = await h.command(),
          results = await Promise.all([h.execute(command), h.execute(command)]);
        assert.equal(results[0].state, "completed");
        assert.equal(results[0].data.appliedFieldIds.length, 1);
        assert.deepEqual(results[0], results[1]);
      } else {
        assert.equal(await h.run(), true);
        assert.equal(await h.run(), true);
      }
      assert.equal(h.doc.querySelector("input").value, "Confirmed answer");
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  });
}

test("a Profile cache update cancels an asynchronous writer before its next control action", async () => {
  const h = await setup("automatic");
  try {
    const operation = h.w.JobsOperationContext.create({
      root: h.root,
      profile: h.profile,
    });
    await operation.verify();
    await operation.write(async (current) => {
      assert(current());
      h.setProfile({ ...h.profile, personalData: { firstName: "Updated" } });
      h.storageChange();
      await Promise.resolve();
      assert.equal(current(), false);
      assert.throws(operation.assertCurrent, /Profile/);
    });
    operation.release();
    assert.equal(h.doc.querySelector("input").value, "");
  } finally {
    h.close();
  }
});

test("trusted hardware edits still cancel while a writer is active", async () => {
  const h = await setup("automatic");
  try {
    const operation = h.w.JobsOperationContext.create({
      root: h.root,
      profile: h.profile,
    });
    await operation.verify();
    await operation.write(async (current) => {
      h.edit();
      await Promise.resolve();
      assert.equal(current(), false);
    });
    operation.release();
    assert.equal(h.doc.querySelector("input").value, "User answer");
  } finally {
    h.close();
  }
});

test("remote profile edits between fields preserve the accepted value and stop remaining writes", async () => {
  const h = await setup("remote");
  try {
    h.root.insertAdjacentHTML(
      "beforeend",
      "<label>Second question<input required></label>",
    );
    const reader = h.w.JobsControlFields.create(h.doc, () => h.root),
      rows = reader.scan();
    const command = await h.command();
    command.args.answers = rows.map((row) => ({
      fieldId: row.public.id,
      value: "Confirmed answer",
    }));
    h.doc.querySelector("input").addEventListener("input", () => {
      h.setProfile({ ...h.profile, personalData: { firstName: "Updated" } });
      h.storageChange();
    });
    const result = await h.execute(command);
    assert.equal(h.doc.querySelectorAll("input")[1].value, "");
    assert.equal(h.clicks(), 0);
    assert(
      result.data.failedFieldIds.includes(rows[1].public.id),
      "subsequent field is never written after the cache invalidates the operation",
    );
  } finally {
    h.close();
  }
});

for (const mode of ["expired", "invalidated"])
  test(`remote ${mode} operation cannot write after asynchronous verification`, async () => {
    const h = await setup("remote");
    try {
      const command = await h.command();
      if (mode === "expired") command.expiresAt = Date.now() + 40;
      h.onCheck(async (message) => {
        if (message.verify) {
          if (mode === "invalidated") h.invalidate();
          else await new Promise((resolve) => setTimeout(resolve, 60));
        }
      });
      const result = await h.execute(command);
      assert.equal(result.state, "failed");
      assert.equal(h.doc.querySelector("input").value, "");
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  });

test("a review cannot resume a cancelled page lifecycle", async () => {
  const h = await setup("automatic");
  try {
    h.resolve(async (questions, profile, { onDecision }) => {
      onDecision({
        index: 0,
        status: "needs-input",
        profileAnswer: { profileOnly: true },
      });
      return [];
    });
    assert.equal(await h.run(), false);
    assert.equal(h.w.JobsAIReview.pending(), true);
    h.w.dispatchEvent(new h.w.Event("pagehide"));
    assert.equal(await h.w.JobsAIReview.confirm(), false);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("automatic confirmed fields reuse one bound Profile check for the entire step", async () => {
  const h = await setup("automatic");
  try {
    for (let i = 1; i < 12; i++)
      h.root.insertAdjacentHTML(
        "beforeend",
        `<label>Question ${i}<input required></label>`,
      );
    h.resolve(async (questions) =>
      questions.map((_, index) => ({ index, answer: "Confirmed answer" })),
    );
    assert.equal(await h.run(), true);
    assert(
      [...h.doc.querySelectorAll("input")].every(
        (input) => input.value === "Confirmed answer",
      ),
    );
    assert.equal(
      h.checks.length,
      1,
      "one binding check, reused through resolution, writes and readiness",
    );
    assert.equal(
      h.checks[0],
      false,
      "the adapter already loaded the server snapshot",
    );
  } finally {
    h.close();
  }
});

test("automatic cache invalidation between fields still stops the next write", async () => {
  const h = await setup("automatic");
  try {
    h.root.insertAdjacentHTML(
      "beforeend",
      "<label>Second question<input required></label>",
    );
    h.resolve(async (questions) =>
      questions.map((_, index) => ({ index, answer: "Confirmed answer" })),
    );
    h.doc.querySelector("input").addEventListener("input", () => {
      h.setProfile({ ...h.profile, personalData: { firstName: "Updated" } });
      h.storageChange();
    });
    assert.equal(await h.run(), false);
    assert.equal(h.doc.querySelectorAll("input")[1].value, "");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("a Profile cache change in another tab does not cancel this page's operation", async () => {
  const h = await setup("automatic");
  try {
    const operation = h.w.JobsOperationContext.create({
      root: h.root,
      profile: h.profile,
    });
    await operation.verify();
    h.setProfile({
      ...h.profile,
      personalData: { firstName: "Another synthetic name" },
    });
    h.storageChange(2);
    assert.equal(operation.current(), true);
    h.storageChange(1);
    assert.equal(operation.current(), false);
    operation.release();
  } finally {
    h.close();
  }
});

test("concurrent local checks share the in-flight binding read and cancellation still invalidates the result", async () => {
  const h = await setup("automatic");
  try {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.onCheck(() => gate);
    const operation = h.w.JobsOperationContext.create({
      root: h.root,
      profile: h.profile,
    });
    const waiting = Array.from({ length: 12 }, () =>
      operation.verify({ fresh: false }),
    );
    release();
    await Promise.all(waiting);
    assert.equal(h.checks.length, 1);
    await operation.verify({ fresh: false });
    assert.equal(h.checks.length, 1);
    h.setProfile({ ...h.profile, personalData: { firstName: "Updated" } });
    h.storageChange();
    await assert.rejects(operation.verify({ fresh: false }), /Profile/);
    operation.release();
  } finally {
    h.close();
  }
});

test("automatic filling keeps the fetched snapshot instead of polling the server again between answers", async () => {
  const h = await setup("automatic");
  try {
    h.resolve(async () => {
      // A server edit does not silently replace the Profile of an active run.
      // Explicit bound-cache changes are covered separately above.
      h.setProfile({
        ...h.profile,
        personalData: { firstName: "Remote edit" },
      });
      return [{ index: 0, answer: "Confirmed answer" }];
    });
    assert.equal(await h.run(), true);
    assert.equal(h.doc.querySelector("input").value, "Confirmed answer");
    assert.deepEqual(h.checks, [false]);
  } finally {
    h.close();
  }
});
