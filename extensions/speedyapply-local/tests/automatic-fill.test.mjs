import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const codes = await Promise.all(
  [
    "job-match-rules",
    "job-match",
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const memoryCode = await readWithDependencies(
  new URL("../src/custom/answer-memory.js", import.meta.url),
  "utf8",
);
function setup(html, answer) {
  const dom = new JSDOM(
    "<form>" + html + '</form><button id="submit">Submit</button>',
    {
      url: "https://jobs.ashbyhq.com/test/role/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    profile = { profileName: "Intern", employmentData: { sponsorship: false } },
    events = [],
    saved = [],
    storage = new Set();
  let calls = 0,
    clicks = 0,
    bound = profile;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.JobsAnswerMemory = {
    remember: (q, n, options) => saved.push([q, n, options]),
    confirmReview: () => {},
  };
  w.chrome = {
    storage: {
      onChanged: {
        addListener: (fn) => storage.add(fn),
        removeListener: (fn) => storage.delete(fn),
      },
    },
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return {
            data: {
              id: "intern",
              tabId: 1,
              profile: {
                employmentData: bound.employmentData,
                profileName: bound.profileName,
              },
            },
          };
        calls++;
        return { data: { answers: await answer(message, w) } };
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  w.document.querySelector("#submit").onclick = () => clicks++;
  const run = (options = {}) =>
    w.JobsAutomatic.advance({
      root: w.document.querySelector("form"),
      profile,
      selector: "#submit",
      action: "submit",
      autoConfirm: false,
      ...options,
    });
  return {
    w,
    run,
    profile,
    events,
    saved,
    calls: () => calls,
    clicks: () => clicks,
    setProfile: (value) => {
      bound = value;
      for (const fn of storage)
        fn(
          { profile_1: { newValue: { id: "intern", profile: bound } } },
          "session",
        );
    },
    close: () => w.close(),
  };
}
const reply = (field, value) => ({
  fieldId: field.fieldId,
  state: "answer",
  value,
  reason: "",
  source: "suggestion",
});

test("fill state machine rejects premature navigation and cannot replay a recorded attempt", () => {
  const h = setup("", async () => []);
  try {
    const flow = h.w.JobsAutomatic.createFlow();
    assert.throws(() => flow.navigate("submit"), /cannot be replayed/);
    for (const state of [
      "verifying",
      "filling",
      "scanning",
      "resolving",
      "writing",
      "scanning",
      "review",
      "verifying",
      "checking",
    ])
      flow.move(state);
    flow.navigate("submit");
    assert.equal(flow.state, "navigation-attempted");
    assert.equal(flow.block(), false);
    assert.equal(flow.cancel(), false);
    assert.throws(() => flow.move("checking"), /Invalid fill transition/);
    assert.throws(() => flow.navigate("submit"), /cannot be replayed/);
    const snapshot = flow.snapshot();
    snapshot.history.length = 0;
    assert(
      flow.snapshot().history.length > 0,
      "Snapshots cannot mutate the navigation journal",
    );
  } finally {
    h.close();
  }
});

test("queue navigation journal is awaited inside readiness and a changed field cannot cross it", async () => {
  const h = setup(
    '<label>Name<input required value="Ready"></label>',
    async () => [],
  );
  let release,
    started = false,
    after = 0;
  h.w.JobsQueuePage = {
    allowed: () => true,
    guard: (fn) => fn,
    verify: async () => {},
    beforeNavigate: async () => {
      started = true;
      await new Promise((resolve) => (release = resolve));
    },
    afterNavigate: () => after++,
  };
  try {
    const attempt = h.run();
    for (let i = 0; i < 100 && !started; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(started);
    assert.equal(h.clicks(), 0);
    h.w.document.querySelector("input").value = "";
    release();
    assert.equal(await attempt, false);
    assert.equal(h.clicks(), 0);
    assert.equal(after, 0);
  } finally {
    h.close();
  }
});

test("durable queue refusal cannot be bypassed by an otherwise ready automatic submit", async () => {
  const h = setup(
    '<label>Name<input required value="Ready"></label>',
    async () => [],
  );
  h.w.JobsQueuePage = {
    allowed: () => true,
    guard: (fn) => fn,
    verify: async () => {},
    beforeNavigate: async () => {
      throw Error("只填写，不提交");
    },
    afterNavigate: () => assert.fail("no navigation"),
  };
  try {
    assert.equal(await h.run(), false);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("cancelling an active fill rejects a late AI answer without clearing the page or navigating", async () => {
  let entered, release;
  const ready = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const h = setup(
    "<label>Motivation*<textarea required></textarea></label>",
    async (message) => {
      entered();
      await gate;
      return message.fields.map((field) => reply(field, "Late answer"));
    },
  );
  try {
    const task = h.run(),
      root = h.w.document.querySelector("form");
    await ready;
    assert.equal(h.w.JobsAutomatic.state(root).state, "resolving");
    h.w.JobsAutomatic.cancel(root);
    release();
    assert.equal(await task, false);
    assert.equal(h.w.JobsAutomatic.state(root).state, "cancelled");
    assert.equal(root.querySelector("textarea").value, "");
    assert.equal(h.clicks(), 0);
  } finally {
    release();
    h.close();
  }
});

test("explicitly restarting autofill can recover a failed AI request without reloading the form", async () => {
  let count = 0;
  const h = setup(
    "<label>Motivation*<textarea required></textarea></label>",
    async (message) => {
      if (++count === 1) throw Error("Temporary network failure");
      return message.fields.map((field) => ({
        ...reply(field, "Recovered answer"),
        source: "profile",
        needsConfirmation: false,
      }));
    },
  );
  const start = () => {
    const wrapped = h.w.JobsAutomatic.observe({
      setMessage: () => {},
      getProfile: async () => h.profile,
    });
    return h.run({
      setMessage: wrapped.setMessage,
      action: "fill",
      autoConfirm: true,
    });
  };
  try {
    assert.equal(await start(), false);
    assert.equal(h.calls(), 1);
    await start();
    assert.equal(h.calls(), 2);
    assert.equal(
      h.w.document.querySelector("textarea").value,
      "Recovered answer",
    );
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("large forms resolve Profile answers before applying the AI request size limit", async () => {
  const h = setup(
    Array.from(
      { length: 31 },
      (_, i) => `<label>Question ${i}*<input required></label>`,
    ).join(""),
    async () => assert.fail("All answers are already known"),
  );
  try {
    assert.equal(
      await h.run({
        action: "fill",
        resolveAnswers: async (fields) =>
          fields.map((_, index) => ({ index, answer: "Known" })),
      }),
      true,
    );
    assert.equal(h.calls(), 0);
    assert(
      [...h.w.document.querySelectorAll("input")].every(
        (node) => node.value === "Known",
      ),
    );
  } finally {
    h.close();
  }
});

test("more than 30 unresolved fields use bounded AI batches without abandoning later gaps", async () => {
  const sizes = [];
  const h = setup(
    Array.from(
      { length: 31 },
      (_, i) => `<label>Question ${i}*<input required></label>`,
    ).join(""),
    async (message) => {
      sizes.push(message.fields.length);
      return message.fields.map((field) => ({
        ...reply(field, "Supported answer"),
        source: "profile",
        needsConfirmation: false,
      }));
    },
  );
  try {
    assert.equal(await h.run({ action: "fill", autoConfirm: true }), true);
    assert.deepEqual(sizes, [30, 1]);
    assert(
      [...h.w.document.querySelectorAll("input")].every(
        (node) => node.value === "Supported answer",
      ),
    );
  } finally {
    h.close();
  }
});

test("unavailable bound Profile preserves completed fields and stops navigation visibly", async () => {
  const h = setup(
    '<label>Name*<input required value="Existing answer"></label>',
    async () => {
      assert.fail("No AI needed");
    },
  );
  const send = h.w.chrome.runtime.sendMessage;
  let checks = 0,
    phase;
  h.w.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "jobs:tab-profile") {
      checks++;
      return { error: "Profile 已更新" };
    }
    return send(message);
  };
  try {
    assert.equal(
      await h.run({ setMessage: (value) => (phase = value) }),
      false,
    );
    assert.equal(checks, 1);
    assert.equal(h.clicks(), 0);
    assert.equal(phase, "profile-unavailable");
    assert.equal(h.w.document.querySelector("input").value, "Existing answer");
  } finally {
    h.close();
  }
});
test("one batch fills text and choices, stages memory and waits for user review without submitting", async () => {
  const h = setup(
    '<label>Motivation*<textarea required></textarea></label><fieldset><legend>Language*</legend><label>Python<input name="lang" type="radio" required></label><label>Java<input name="lang" type="radio"></label></fieldset><label>Degree*<select required><option value="">Choose</option><option value="ba">Bachelor</option></select></label><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Available?*</label><div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div></div><div role="radiogroup" aria-label="Editor" aria-required="true"><button type="button" role="radio" aria-checked="false">Vim</button></div><div role="checkbox" aria-label="Required checkbox" aria-required="true" aria-checked="false"></div>',
    async (message) =>
      message.fields.map((f) =>
        reply(
          f,
          f.type === "textarea"
            ? "Supported motivation"
            : f.type === "custom-checkbox"
              ? false
              : f.options[0].value,
        ),
      ),
  );
  try {
    for (const button of h.w.document.querySelectorAll("[data-option]"))
      button.onclick = () => button.setAttribute("aria-pressed", "true");
    const radio = h.w.document.querySelector('[role="radio"]');
    radio.onclick = () =>
      setTimeout(() => radio.setAttribute("aria-checked", "true"), 10);
    assert.equal(await h.run(), false);
    assert.equal(h.calls(), 1);
    assert.equal(h.clicks(), 0);
    assert.equal(h.saved.length, 6);
    assert(h.saved.every(([, , options]) => options.requireReview));
    h.w.document.querySelector("#submit").click();
    assert.equal(
      h.clicks(),
      0,
      "Synthetic continuation is blocked during review",
    );
    await h.run();
    assert.equal(h.calls(), 1);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});
test("missing personal facts and late validation both stop navigation", async () => {
  for (const lateError of [false, true]) {
    const h = setup(
      "<label>Required answer*<input required></label>",
      async (message, w) => {
        if (lateError) {
          // Make validation arrive after staging, not after an arbitrary 15ms that
          // can expire inside the writer when the complete suite shares the CPU.
          const remember = w.JobsAnswerMemory.remember;
          w.JobsAnswerMemory.remember = (...args) => {
            remember(...args);
            w.document
              .querySelector("input")
              .setAttribute("aria-invalid", "true");
          };
          return [reply(message.fields[0], "Answer")];
        }
        return [
          {
            fieldId: message.fields[0].fieldId,
            state: "needs_input",
            value: null,
            reason: "Missing confirmed fact",
          },
        ];
      },
    );
    try {
      assert.equal(await h.run(), false);
      assert.equal(h.clicks(), 0);
      assert.equal(h.saved.length, lateError ? 1 : 0);
    } finally {
      h.close();
    }
  }
});
test("a changed Profile or manual value during Luna prevents stale answers and submission", async () => {
  for (const changeProfile of [true, false]) {
    let h, manual;
    h = setup("<label>Major*<input required></label>", async (message) => {
      if (changeProfile)
        h.setProfile({
          profileName: "Newgrad",
          employmentData: { sponsorship: true },
        });
      else {
        const input = h.w.document.querySelector("input");
        manual({ isTrusted: true, target: input });
        input.value = "Manual correction";
      }
      return [reply(message.fields[0], "Stale answer")];
    });
    const add = h.w.document.addEventListener.bind(h.w.document);
    h.w.document.addEventListener = (type, handler, ...rest) => {
      if (type === "keydown") manual = handler;
      return add(type, handler, ...rest);
    };
    try {
      assert.equal(await h.run(), false);
      assert.equal(h.clicks(), 0);
      assert.notEqual(
        h.w.document.querySelector("input").value,
        "Stale answer",
      );
    } finally {
      h.close();
    }
  }
});
test("unsupported fields and malformed option answers never reach Submit", async () => {
  for (const html of [
    '<label>Canvas answer<div contenteditable="true"></div></label>',
    '<label>Choice*<select required><option value="">Choose</option><option value="a">A</option></select></label>',
  ]) {
    const h = setup(html, async (message) =>
      message.fields.map((f) => reply(f, "invented-option")),
    );
    try {
      assert.equal(await h.run(), false);
      assert.equal(h.clicks(), 0);
    } finally {
      h.close();
    }
  }
});

test("iCIMS native combobox uses saved answers for required gaps and skips optional salary", async () => {
  const h = setup(
    '<label>Visa*<select role="combobox" required><option value="yes" selected>Yes</option><option value="no">No</option></select></label><label>Previously employed here?*<select role="combobox" required><option value="">— Make a Selection —</option><option value="Y">Yes</option><option value="N">No</option></select></label><label>Salary expectations<input></label>',
    async (message) => {
      assert.fail("Optional salary must not reach AI");
      assert(
        message.formContext.some(
          (row) =>
            row.question === "Previously employed here?*" &&
            row.answer === "No",
        ),
      );
      return [
        {
          fieldId: message.fields[0].fieldId,
          state: "needs_input",
          value: null,
          reason: "No confirmed salary expectation",
        },
      ];
    },
  );
  try {
    assert.equal(
      await h.run({
        resolveAnswers: async (questions) => {
          // The optional salary reaches only the rule pass, which has no answer for it.
          assert.equal(questions.length, 2);
          assert.deepEqual([...questions[0].options], ["Yes", "No"]);
          return [{ index: 0, answer: "No" }];
        },
      }),
      true,
    );
    assert.equal(h.w.document.querySelectorAll("select")[0].value, "yes");
    assert.equal(h.w.document.querySelectorAll("select")[1].value, "N");
    assert.equal(h.calls(), 0);
    assert.equal(h.clicks(), 1);
    assert.equal(h.saved.length, 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert(h.events.some(([type]) => type === "auto_known_answer_applied"));
  } finally {
    h.close();
  }
});

test("a choice missed by memory reaches Luna, while disabling auto-next only disables navigation", async () => {
  const h = setup(
    '<label>Question*<select role="combobox" required><option value="">Choose</option><option value="N">No</option></select></label>',
    async (message) => {
      assert.equal(message.fields[0].type, "select-one");
      return [reply(message.fields[0], "N")];
    },
  );
  try {
    assert.equal(
      await h.run({ action: "fill", resolveAnswers: async () => [] }),
      false,
    );
    assert.equal(h.calls(), 1);
    assert.equal(h.clicks(), 0);
    assert.equal(h.saved.length, 1);
  } finally {
    h.close();
  }
});

test("review card shows human choice labels, locates fields, learns corrected answers only after confirmation and continues once", async () => {
  const h = setup(
    '<label>Previously employed here?*<select required><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></label><label>Motivation*<textarea required></textarea></label>',
    async (message) =>
      message.fields.map((f) => ({
        ...reply(f, f.type === "textarea" ? "AI draft" : "N"),
        reason: "Internal reasoning must stay hidden.",
        questionZh: f.type === "textarea" ? "求职动机" : "是否曾在该公司工作",
        answerZh: f.type === "textarea" ? "AI 草稿" : "否",
      })),
  );
  const learned = [];
  h.w.eval(memoryCode);
  h.w.JobsAnswerMemory.start(h.w.document, true, (rows) =>
    learned.push(...rows),
  );
  try {
    await h.run();
    const shadow = h.w.document.querySelector("#jobs-ai-review").shadowRoot;
    assert.equal(shadow.querySelectorAll(".item").length, 2);
    assert.equal(shadow.querySelector(".answer").textContent, "否");
    assert.equal(
      shadow.querySelector(".question").textContent,
      "是否曾在该公司工作",
    );
    assert.equal(shadow.querySelectorAll(".answer")[1].textContent, "AI 草稿");
    assert.equal(shadow.querySelector(".reason"), null);
    assert(!shadow.textContent.includes("Internal reasoning"));
    assert.match(shadow.querySelector("h2").textContent, /AI 补填 · 2/);
    shadow.querySelector(".item").click();
    assert.equal(h.w.document.activeElement.tagName, "SELECT");
    const text = h.w.document.querySelector("textarea");
    text.value = "My corrected answer";
    text.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    h.w.JobsAnswerMemory.flush();
    await Promise.resolve();
    assert.equal(learned.length, 0);
    assert.equal(
      shadow.querySelectorAll(".answer")[1].textContent,
      "My corrected answer",
    );
    assert.equal(
      shadow.querySelectorAll(".source")[1].textContent,
      "已手动修改",
    );
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(learned.length, 2);
    assert.equal(learned[0].response, "No");
    assert.equal(learned[1].response, "My corrected answer");
    assert.equal(h.clicks(), 1);
    await h.w.JobsAIReview.confirm();
    await h.run();
    assert.equal(h.clicks(), 1);
    assert.equal(h.calls(), 1);
    assert.equal(h.w.document.querySelector("#jobs-ai-review"), null);
  } finally {
    h.close();
  }
});

test("confirmation does not navigate with auto-next off or remaining required gaps; changed Profile cannot confirm or learn", async () => {
  for (const scenario of ["manual", "gap", "profile"]) {
    const h = setup(
      "<label>Answer<input required></label>" +
        (scenario === "gap" ? "<label>Unknown<input required></label>" : ""),
      async (message) =>
        message.fields.map((f, i) =>
          i
            ? { fieldId: f.fieldId, state: "needs_input", value: null }
            : reply(f, "Draft"),
        ),
    );
    const learned = [];
    h.w.eval(memoryCode);
    h.w.JobsAnswerMemory.start(h.w.document, true, (rows) =>
      learned.push(...rows),
    );
    try {
      await h.run({ action: scenario === "manual" ? "fill" : "submit" });
      if (scenario === "profile")
        h.setProfile({
          profileName: "Newgrad",
          employmentData: { sponsorship: true },
        });
      assert.equal(await h.w.JobsAIReview.confirm(), scenario !== "profile");
      assert.equal(h.clicks(), 0);
      assert.equal(learned.length, scenario !== "profile" ? 1 : 0);
      assert.equal(h.w.JobsAIReview.pending(), scenario === "profile");
      if (scenario === "gap") {
        h.w.document.querySelector("#submit").click();
        assert.equal(
          h.clicks(),
          1,
          "user can ask the ATS to validate after confirming",
        );
      }
    } finally {
      h.close();
    }
  }
});

test("invalidating an adapter while waiting for mounted fields prevents a late AI call", async () => {
  const h = setup("", async () => {
    throw Error("must not request AI");
  });
  try {
    let invalidate;
    h.w.JobsPageSession = { root: () => h.w.document.querySelector("form") };
    const wrapped = h.w.JobsAutomatic.observe(
      {
        getProfile: async () => h.profile,
        setMessage: () => {},
        ctx: { onInvalidated: (fn) => (invalidate = fn) },
      },
      async () => [],
    );
    await wrapped.getProfile();
    wrapped.setMessage("complete-manually");
    await new Promise((resolve) => setTimeout(resolve, 20));
    invalidate();
    h.w.document.querySelector("form").innerHTML =
      "<label>Late question<input required></label>";
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.calls(), 0);
    assert.equal(h.w.document.querySelector("input").value, "");
  } finally {
    h.close();
  }
});

test("cleared or rerendered education search fields cannot deadlock review or be learned as completed answers", async () => {
  for (const replacement of [false, true]) {
    const h = setup(
      "<label>School<input required></label><label>Major<input required></label>",
      async (message) => message.fields.map((f) => reply(f, "Draft")),
    );
    const approved = [];
    h.w.JobsAnswerMemory.confirmReview = (nodes) => approved.push(...nodes);
    try {
      await h.run({ action: "next" });
      const input = h.w.document.querySelector("input");
      if (replacement) input.replaceWith(h.w.document.createElement("input"));
      else input.value = "";
      h.w.document.dispatchEvent(new h.w.Event("change", { bubbles: true }));
      await Promise.resolve();
      const card = h.w.document.querySelector("#jobs-ai-review").shadowRoot;
      assert.equal(card.querySelector("#confirm").disabled, false);
      assert.match(card.querySelector("h2").textContent, /待补 1/);
      assert.equal(await h.w.JobsAIReview.confirm(), true);
      assert.equal(h.w.JobsAIReview.pending(), false);
      assert.equal(
        h.clicks(),
        0,
        "confirmation alone cannot advance an incomplete form",
      );
      assert.equal(approved.length, 1);
      assert.notEqual(approved[0], input);
      h.w.document.querySelector("#submit").click();
      assert.equal(
        h.clicks(),
        1,
        "native continuation is released for manual repair",
      );
    } finally {
      h.close();
    }
  }
});

test("TRC replay: optional salary is skipped, missing employment fact is visibly explained and remains blank until the user supplies it", async () => {
  const reason =
    "The profile does not state whether you are currently or have previously been employed by TRC Companies.";
  const h = setup(
    '<label>Are you currently or have you previously been employed by TRC Companies?*<select role="combobox"><option value="">— Make a Selection —</option><option value="Yes">Yes</option><option value="No">No</option></select></label><label>What are your salary expectations?<input></label>',
    async (message) => {
      assert.equal(message.fields.length, 1);
      assert.match(message.fields[0].question, /TRC/);
      return [
        {
          fieldId: message.fields[0].fieldId,
          state: "needs_input",
          value: null,
          reason,
        },
      ];
    },
  );
  try {
    await h.run({
      resolveAnswers: async (questions) => {
        assert.equal(questions.length, 2);
        return [];
      },
    });
    const shadow = h.w.document.querySelector("#jobs-ai-review").shadowRoot,
      select = h.w.document.querySelector("select");
    assert.equal(h.w.document.querySelector("input").value, "");
    assert.equal(select.value, "");
    assert.equal(shadow.querySelectorAll(".item").length, 1);
    assert.match(shadow.querySelector("h2").textContent, /需要你补充/);
    assert(!shadow.textContent.includes(reason));
    assert.equal(shadow.querySelector(".answer").textContent, "待补充");
    assert.equal(shadow.querySelector("#confirm").disabled, false);
    assert.match(shadow.querySelector("#status").textContent, /待补/);
    assert.equal(h.saved.length, 0);
    assert.equal(h.clicks(), 0);
    shadow.querySelector(".item").click();
    assert.equal(h.w.document.activeElement, select);
    select.value = "No";
    select.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await Promise.resolve();
    assert.equal(shadow.querySelector(".answer").textContent, "否");
    assert.equal(shadow.querySelector("#confirm").disabled, false);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.clicks(), 1);
    assert.equal(h.calls(), 1);
  } finally {
    h.close();
  }
});

test("TRC education replay: exact major and school fill while conditional extra fields stay blank, visible and unsaved", async () => {
  const schools = Array.from(
    { length: 316 },
    (_, i) => `<option value="school-${i}">School ${i}</option>`,
  ).join("");
  const h = setup(
    '<label>Major*<select required><option value="">Choose</option><option>Data Science</option><option>Data Science</option><option>Physics</option></select></label><label>Please add your Major if it is not in the list<input></label>' +
      `<label>School*<select required><option value="">Choose</option>${schools}<option>University of California Berkeley</option><option>Not In List</option></select></label><label>Please add your School if it is not in the list<input></label>` +
      '<label>Expected Graduation Date*<select required><option value="">Choose</option><option>Spring 2027</option><option>Fall 2027</option></select></label>',
    async (message) => {
      assert.equal(message.fields.length, 3);
      assert.equal(
        message.fields[0].options.filter((o) => o.value === "Data Science")
          .length,
        1,
      );
      assert.equal(message.fields[1].options.length, 318);
      return message.fields.map((f, i) => ({
        ...reply(
          f,
          ["Physics", "University of California Berkeley", "Spring 2027"][i],
        ),
        source: "profile",
        needsConfirmation: false,
        reason:
          f.type === "text" ? "已在列表中，无需补充。" : "档案对应的选项。",
      }));
    },
  );
  const learned = [];
  h.w.eval(memoryCode);
  h.w.JobsAnswerMemory.start(h.w.document, true, (rows) =>
    learned.push(...rows),
  );
  try {
    await h.run({ action: "fill" });
    assert.equal(h.calls(), 1);
    assert.equal(h.clicks(), 0);
    assert.deepEqual(
      [...h.w.document.querySelectorAll("select")].map((node) => node.value),
      ["Physics", "University of California Berkeley", "Spring 2027"],
    );
    assert.deepEqual(
      [...h.w.document.querySelectorAll("input")].map((node) => node.value),
      ["", ""],
    );
    const card = h.w.document.querySelector("#jobs-ai-review").shadowRoot;
    assert.equal(card.querySelectorAll(".item").length, 3);
    assert(!/留空/.test(card.querySelector("h2").textContent));
    h.w.JobsAnswerMemory.flush();
    assert.equal(learned.length, 0);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(
      learned.length,
      0,
      "Profile-derived answers never become independent memories",
    );
    assert(learned.every((row) => row.response));
    assert.equal(h.clicks(), 0);
    assert.equal(h.calls(), 1);
  } finally {
    h.close();
  }
});

test("review expands inside the existing status surface and removes an older duplicate surface", async () => {
  const h = setup(
    "<label>Extra preference<input required></label>",
    async (message) => message.fields.map((f) => reply(f, "Preference")),
  );
  try {
    const host = h.w.document.createElement("speedyapply-autofill");
    h.w.document.body.append(host);
    const container = host.attachShadow({ mode: "open" }),
      original = h.w.document.createElement("div");
    container.append(original);
    h.w.JobsReviewPresenter.attach(host, container, () => host.remove());
    await h.run({ action: "fill" });
    assert.equal(
      h.w.document.querySelector("#jobs-ai-review"),
      null,
      "No separate popup by Submit",
    );
    assert.equal(container.querySelector("#jobs-ai-review").style.top, "96px");
    assert.equal(original.style.display, "none");
    const second = h.w.document.createElement("speedyapply-autofill");
    h.w.document.body.append(second);
    const next = second.attachShadow({ mode: "open" }),
      message = h.w.document.createElement("div");
    next.append(message);
    h.w.JobsReviewPresenter.attach(second, next, () => second.remove());
    assert.equal(
      h.w.document.querySelectorAll("speedyapply-autofill").length,
      1,
    );
    assert(next.querySelector("#jobs-ai-review"));
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(message.style.display, "");
    assert.equal(next.querySelector("#jobs-ai-review"), null);
  } finally {
    h.close();
  }
});

test("an AI answer the page does not keep stays on the review card and never stops the other answers", async () => {
  // Wellington: one list reported as not kept aborted the whole AI batch.
  const h = setup(
    '<label>First*<input id="first" required></label><label>Second*<input id="second" required></label>',
    async (message) =>
      message.fields.map((f) =>
        reply(f, f.question.startsWith("First") ? "One" : "Two"),
      ),
  );
  try {
    const pipeline = h.w.JobsFormPipeline;
    // The page drops the first AI answer: the one write reports it as not kept.
    h.w.JobsFormPipeline = {
      ...pipeline,
      write: async (node, answer, options) =>
        node.id === "first"
          ? (options.ledger.abstain(node, options.decider, "value not kept"),
            { ok: false, reason: "value not kept" })
          : pipeline.write(node, answer, options),
    };
    assert.equal(await h.run(), false);
    assert.equal(h.w.document.querySelector("#second").value, "Two");
    assert(h.events.some(([type]) => type === "auto_value_not_kept"));
    assert(!h.events.some(([type]) => type === "auto_blocked"));
    assert(h.w.JobsAIReview.pending(), "both answers wait on the review card");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("an AI option that does not exist or a write that fails leaves that field on the card; the others are written", async () => {
  const h = setup(
    '<label>Shift*<select id="shift" required><option value="">Choose</option><option value="d">Day</option></select></label><label>Gone*<input id="gone" required></label><label>Second*<input id="second" required></label>',
    async (message) =>
      message.fields.map((f) =>
        f.question.startsWith("Shift")
          ? reply(f, "not-an-option")
          : reply(f, f.question.startsWith("Gone") ? "Lost" : "Two"),
      ),
  );
  try {
    const pipeline = h.w.JobsFormPipeline;
    h.w.JobsFormPipeline = {
      ...pipeline,
      write: async (node, answer, options) => {
        // The one write reports a failed write; it never throws for it.
        if (node.id === "gone") {
          options.ledger.abstain(
            node,
            options.decider,
            "Field is no longer an editable empty control",
          );
          return {
            ok: false,
            reason: "Field is no longer an editable empty control",
          };
        }
        return pipeline.write(node, answer, options);
      },
    };
    assert.equal(await h.run(), false);
    assert.equal(h.w.document.querySelector("#second").value, "Two");
    assert.equal(h.w.document.querySelector("#shift").value, "");
    assert(
      !h.events.some(([type]) => type === "auto_blocked"),
      "no field stops the batch",
    );
    assert(
      h.events.some(
        ([type, , detail]) =>
          type === "auto_needs_input" && /unknown option/.test(detail),
      ),
    );
  } finally {
    h.close();
  }
});
