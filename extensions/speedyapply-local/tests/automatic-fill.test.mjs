import { confirmedAnswer, confirmedDraft } from "./helpers/verified-answer.mjs";
import { mountReviewPanel } from "./helpers/review-panel.mjs";
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
  w.JobsOperator?.update({ mode: "person", epoch: "fixture", since: 1 });
  mountReviewPanel(w);
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
const reply = confirmedDraft;

for (const scenario of ["complete", "changed", "oversized"])
  test(`terms context reaches verification and remains current: ${scenario}`, async () => {
    const body =
      "Application processing only. ".repeat(
        scenario === "oversized" ? 800 : 100,
      ) + "No unrelated marketing.";
    const h = setup(
      `<fieldset><legend>Terms and Conditions</legend><p id="terms-body">${body}</p><label><input type="checkbox" required>Yes, I have read the above mentioned Terms and Conditions and consent to all of them.</label></fieldset>`,
      async (message, w) => {
        if (scenario === "changed" && message.fields[0].description !== body) {
          assert.equal(
            message.fields[0].description,
            "Different terms now apply.",
          );
          assert.equal(w.document.querySelector("input").checked, false);
          return message.fields.map((field) => ({
            fieldId: field.fieldId,
            state: "needs_input",
            value: null,
            source: "unknown",
            needsConfirmation: true,
          }));
        }
        assert.equal(message.fields[0].description, body);
        if (scenario === "changed")
          w.document.getElementById("terms-body").textContent =
            "Different terms now apply.";
        return message.fields.map((field) =>
          confirmedAnswer(field, {
            fieldId: field.fieldId,
            state: "answer",
            value: true,
            source: "profile",
            needsConfirmation: false,
          }),
        );
      },
    );
    try {
      await h.run({ action: "fill" });
      assert.equal(
        h.calls(),
        scenario === "oversized" ? 0 : scenario === "changed" ? 2 : 1,
      );
      assert.equal(
        h.w.document.querySelector("input").checked,
        scenario === "complete",
      );
      assert.equal(h.clicks(), 0);
      if (scenario === "changed")
        assert(h.events.some(([type]) => type === "auto_answer_obsolete"));
    } finally {
      h.close();
    }
  });

for (const question of [
  "Have you ever been convicted of a felony?",
  "Do you hold a security clearance?",
  "Are you a U.S. person under ITAR?",
  "Are you bound by a non-compete agreement?",
])
  test(`model provenance cannot skip review: ${question}`, async () => {
    const h = setup(
      `<label>${question}<select required><option value="">Select</option><option value="no">No</option></select></label>`,
      async (message) =>
        message.fields.map((field) => ({
          ...reply(field, "no"),
          source: "profile",
          needsConfirmation: false,
        })),
    );
    try {
      assert.equal(await h.run({ action: "next", autoConfirm: true }), false);
      assert.equal(h.w.document.querySelector("select").value, "");
      assert.equal(h.clicks(), 0);
      assert.equal(
        h.events.some(([type]) => type === "auto_review_automatic"),
        false,
      );
      assert.equal(h.calls(), 1);
    } finally {
      h.close();
    }
  });

for (const scenario of [
  { prior: "binding", continues: true },
  { prior: "rule", continues: true },
  { prior: "binding", source: "suggestion", confirmation: true },
  { prior: "binding", source: "suggestion" },
  { prior: "binding", outcome: "lost" },
  { prior: "binding", outcome: "invalid" },
  { prior: "missing-fact", continues: true },
])
  test(`AI recovery after ${scenario.prior}: ${scenario.outcome || scenario.source || (scenario.confirmation ? "explicit review" : scenario.continues ? "continue" : "fact review")}`, async () => {
    const h = setup(
      '<label>Overall*<select required><option value="">Select</option><option value="high">High</option></select></label>',
      async (message) =>
        message.fields.map((field) =>
          confirmedAnswer(field, {
            ...reply(field, "high"),
            source: scenario.source || "profile",
            needsConfirmation:
              scenario.source === "suggestion" ||
              scenario.confirmation === true,
          }),
        ),
    );
    try {
      const select = h.w.document.querySelector("select");
      select.addEventListener("change", () => {
        if (scenario.outcome === "lost") select.value = "";
        if (scenario.outcome === "invalid")
          select.setCustomValidity("Fixture validation failure");
      });
      const result = await h.run({
        action: "next",
        autoConfirm: true,
        fill: async () => {
          if (scenario.prior === "binding")
            await h.w.JobsFormPipeline.bind([
              {
                name: "language-level",
                find: () => select,
                answer: h.w.JobsProfileAnswers.literalSpec(
                  "language_proficiency",
                  "Unmapped fixture level",
                ),
              },
            ]);
        },
        resolveAnswers: async () =>
          scenario.prior === "rule"
            ? [
                {
                  index: 0,
                  status: "answered",
                  source: "profile",
                  answer: "Unmapped fixture level",
                },
              ]
            : scenario.prior === "missing-fact"
              ? [
                  {
                    index: 0,
                    status: "needs-input",
                    reason: "Missing explicit fact",
                    profileAnswer: { profileOnly: true },
                  },
                ]
              : [],
      });
      assert.equal(h.calls(), 1, "AI receives the unresolved field once");
      assert.equal(result, !!scenario.continues);
      assert.equal(h.clicks(), scenario.continues ? 1 : 0);
      assert.equal(select.value, scenario.outcome === "lost" ? "" : "high");
      assert.equal(
        h.events.some(([type]) => type === "auto_review_automatic"),
        !!scenario.continues,
      );
      if (scenario.prior !== "missing-fact")
        assert(h.events.some(([type]) => type === "auto_decider_abstained"));
    } finally {
      h.close();
    }
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
  h.w.JobsSubmissionGuard = {
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
  h.w.JobsSubmissionGuard = {
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
      return message.fields.map((field) =>
        confirmedAnswer(field, {
          ...reply(field, "Recovered answer"),
          source: "profile",
          needsConfirmation: false,
        }),
      );
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
      return message.fields.map((field) =>
        confirmedAnswer(field, {
          ...reply(field, "Supported answer"),
          source: "profile",
          needsConfirmation: false,
        }),
      );
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
          confirmedAnswer(message.fields[0], {
            fieldId: message.fields[0].fieldId,
            state: "needs_input",
            value: null,
            reason: "Missing confirmed fact",
          }),
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

test("iCIMS native combobox fills a known answer while unsupported optional salary remains blank", async () => {
  const h = setup(
    '<label>Visa*<select role="combobox" required><option value="yes" selected>Yes</option><option value="no">No</option></select></label><label>Previously employed here?*<select role="combobox" required><option value="">— Make a Selection —</option><option value="Y">Yes</option><option value="N">No</option></select></label><label>Salary expectations<input></label>',
    async (message) => {
      assert(
        message.formContext.some(
          (row) =>
            row.question === "Previously employed here?*" &&
            row.answer === "No",
        ),
      );
      return [
        confirmedAnswer(message.fields[0], {
          fieldId: message.fields[0].fieldId,
          state: "needs_input",
          value: null,
          reason: "No confirmed salary expectation",
        }),
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
    assert.equal(h.calls(), 1);
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
            ? confirmedAnswer(f, {
                fieldId: f.fieldId,
                state: "needs_input",
                value: null,
              })
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
      assert.equal(message.fields.length, 2);
      assert.match(message.fields[0].question, /TRC/);
      return message.fields.map((field) =>
        confirmedAnswer(field, {
          fieldId: field.fieldId,
          state: "needs_input",
          value: null,
          reason,
        }),
      );
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
      assert.equal(message.fields.length, 5);
      const choices = message.fields.filter((f) => f.options.length);
      assert.equal(
        choices[0].options.filter((o) => o.value === "Data Science").length,
        1,
      );
      assert.equal(choices[1].options.length, 318);
      return message.fields.map((f) =>
        f.options.length
          ? confirmedAnswer(f, {
              ...reply(
                f,
                ["Physics", "University of California Berkeley", "Spring 2027"][
                  choices.indexOf(f)
                ],
              ),
              source: "profile",
              needsConfirmation: false,
              reason:
                f.type === "text"
                  ? "已在列表中，无需补充。"
                  : "档案对应的选项。",
            })
          : {
              fieldId: f.fieldId,
              state: "needs_input",
              value: null,
              source: "unknown",
            },
      );
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

test("review stays in its mounted panel container and removes an older view", async () => {
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
    assert.equal(container.querySelector("#jobs-ai-review").style.top, "");
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

test("optional binding failure does not create a blocking review card", async () => {
  const h = setup(
    '<label>Nickname<select id="nickname"><option value="">Choose</option><option>Other</option></select></label><label>Name<input required value="Kept"></label>',
    async () => {
      throw Error("No AI needed");
    },
  );
  try {
    const result = await h.run({
      action: "fill",
      fill: async () => {
        const input = h.w.document.querySelector("#nickname");
        await h.w.JobsFormPipeline.bind([
          { name: "nickname", find: () => input, answer: "Synthetic" },
        ]);
      },
    });
    assert.equal(result, true);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.calls(), 1);
  } finally {
    h.close();
  }
});

test("recovery restores pending review without filling, requesting AI, or navigating", async () => {
  const h = setup(
    '<label>Answer<input required value="User kept this" data-jobs-review-pending></label><label>Missing<input required></label>',
    async () => {
      throw Error("Recovery cannot request answers");
    },
  );
  try {
    await h.run({
      recover: true,
      fill: () => {
        throw Error("Recovery cannot call adapter");
      },
    });
    assert.equal(h.w.document.querySelector("input").value, "User kept this");
    assert.equal(h.w.document.querySelectorAll("input")[1].value, "");
    assert.equal(h.w.JobsAIReview.pending(), true, JSON.stringify(h.events));
    assert.equal(h.clicks(), 0);
    assert.equal(h.calls(), 0);
  } finally {
    h.close();
  }
});

test("recovery does not report a populated server-rejected form as page-complete", async () => {
  const h = setup(
    '<div role="alert"><h2>Your form needs corrections</h2><ul><li>Missing entry for required field: <button type="button">Email</button></li></ul></div><label>Email<input type="email" required value="fixture@example.test"></label>',
    async () => {
      throw Error("Recovery cannot request answers");
    },
  );
  try {
    const phases = [];
    await h.run({ recover: true, setMessage: (phase) => phases.push(phase) });
    assert.equal(phases.at(-1), "complete-required");
    assert.equal(phases.includes("page-complete"), false);
    assert.equal(h.clicks(), 0);
    assert.equal(h.calls(), 0);
  } finally {
    h.close();
  }
});

test("Helion: registered saved text, textarea and Yes-No controls all reach supplementation beside a consent card", async () => {
  const entry = (id, label, control) =>
    `<div class="ashby-application-form-field-entry" data-field-path="${id}"><label class="ashby-application-form-question-title" for="${id}">${label}*</label>${control}</div>`;
  let fields = [];
  const h = setup(
    entry(
      "start",
      "When can you start?",
      '<input id="start" type="text" required>',
    ) +
      entry("gpa", "Current GPA", '<input id="gpa" type="text" required>') +
      entry(
        "projects",
        "Project teams",
        '<textarea id="projects" required></textarea>',
      ) +
      entry(
        "eligible",
        "Eligible?",
        '<div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div>',
      ) +
      entry("consent", "Signature", '<input id="consent" required>'),
    async (message) => {
      fields = message.fields;
      return fields.map((field) =>
        confirmedAnswer(field, {
          fieldId: field.fieldId,
          state: "needs_input",
          reason: "Synthetic unknown fact",
        }),
      );
    },
  );
  try {
    h.w.eval(
      await readWithDependencies(
        new URL("../src/custom/ashby-saved-controls.js", import.meta.url),
        "utf8",
      ),
    );
    await h.run({
      action: "fill",
      resolveAnswers: async (rows) =>
        rows.map((row, index) => ({
          index,
          status: row.question.startsWith("Signature")
            ? "needs-input"
            : "unmatched",
          reason: "Synthetic unknown fact",
          ...(row.question.startsWith("Signature")
            ? { profileAnswer: { profileOnly: true } }
            : {}),
        })),
    });
    assert.equal(
      h.calls(),
      1,
      JSON.stringify(h.events.filter((e) => /blocked|options/.test(e[0]))),
    );
    assert.equal(fields.length, 5);
    assert.deepEqual(
      [...fields.find((f) => f.type === "yesno").options].map((o) => o.label),
      ["Yes", "No"],
    );
    const questions = [
      ...h.w.document
        .querySelector("#jobs-ai-review")
        .shadowRoot.querySelectorAll(".question"),
    ].map((n) => n.textContent);
    for (const label of [
      "When can you start?",
      "Current GPA",
      "Project teams",
      "Eligible?",
      "Signature",
    ])
      assert.ok(
        questions.some((q) => q.includes(label)),
        label + " must be visible in review",
      );
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("three Ashby open-ended questions receive AI drafts through the saved-control writer and all require review", async () => {
  const h = setup(
    [1, 2, 3]
      .map(
        (i) =>
          `<div class="ashby-application-form-field-entry" data-field-path="essay-${i}"><label class="ashby-application-form-question-title" for="essay-${i}">Project example ${i}*</label><textarea id="essay-${i}" required></textarea></div>`,
      )
      .join(""),
    async (message) =>
      message.fields.map((field, i) =>
        reply(field, `Synthetic project draft ${i + 1}`),
      ),
  );
  try {
    h.w.eval(
      await readWithDependencies(
        new URL("../src/custom/ashby-saved-controls.js", import.meta.url),
        "utf8",
      ),
    );
    const send = h.w.chrome.runtime.sendMessage;
    h.w.chrome.runtime.sendMessage = (message) =>
      message.type === "jobs:ashby-commit"
        ? Promise.resolve({ data: { state: "confirmed" } })
        : send(message);
    await h.run({
      action: "fill",
      resolveAnswers: async (rows) =>
        rows.map((_, index) => ({
          index,
          status: "unmatched",
          reason: "no_matching_rule",
        })),
    });
    assert.equal(h.calls(), 1);
    assert.deepEqual(
      [...h.w.document.querySelectorAll("form textarea")].map((n) => n.value),
      [
        "Synthetic project draft 1",
        "Synthetic project draft 2",
        "Synthetic project draft 3",
      ],
    );
    assert.equal(
      h.w.document
        .querySelector("#jobs-ai-review")
        .shadowRoot.querySelectorAll(".item").length,
      3,
    );
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});

test("required controls revealed during review return to the same answer pipeline and stay visible", async () => {
  const h = setup(
    "<label>Preference<input required></label>",
    async (message) =>
      message.fields.map((field) =>
        field.question === "Follow-up*"
          ? {
              fieldId: field.fieldId,
              state: "needs_input",
              value: null,
              source: "unknown",
              reason: "Missing fact",
            }
          : reply(field, "Draft"),
      ),
  );
  try {
    await h.run({ action: "next" });
    assert.equal(h.calls(), 1);
    h.w.document
      .querySelector("form")
      .insertAdjacentHTML(
        "beforeend",
        "<label>Follow-up*<input required></label>",
      );
    await h.w.JobsAIReview.confirm();
    assert.equal(h.calls(), 2);
    assert.equal(h.clicks(), 0);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.match(
      h.w.document.querySelector("#jobs-ai-review").shadowRoot.textContent,
      /Follow-up/,
    );
  } finally {
    h.close();
  }
});

test("verified subjective drafts cross a Next step and appear once before manual submission", async () => {
  const { createDraftReview } = await import("../src/custom/draft-review.js");
  const { createDraftChecklist } =
    await import("../src/custom/draft-checklist.js");
  const { updateDraftJournal, approveDraftJournal } =
    await import("../src/custom/draft-journal.js");
  const { bindAnswerEvidence } = await import("../src/custom/answer-proof.js");
  let journal = updateDraftJournal(null, []);
  const connect = (h) => {
    h.w.createDraftReview = (root, reader, surface, current) =>
      createDraftReview(
        root,
        reader,
        surface,
        current,
        createDraftChecklist(root, reader, async (action, data) => {
          if (action === "put")
            journal = updateDraftJournal(journal, data.items);
          if (action === "approve")
            journal = approveDraftJournal(journal, data.revision);
          return journal;
        }),
      );
  };
  const h = setup(
    "<label>Why this role?<textarea required></textarea></label>",
    async (message) =>
      message.fields.map((field) =>
        bindAnswerEvidence(
          {
            ...reply(field, "I would like to work on reliable systems."),
            decision: "draft",
            needsConfirmation: true,
            proof: {
              version: 2,
              status: "verified",
              profileId: "fixture",
              profileVersion: "v1",
              field,
              value: "I would like to work on reliable systems.",
              id: "c".repeat(24),
              paths: [],
            },
          },
          field,
          { id: "fixture", lastSync: "v1" },
        ),
      ),
  );
  connect(h);
  try {
    h.w.document.querySelector("#submit").textContent = "Next";
    assert.equal(await h.run({ action: "next", autoConfirm: true }), true);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.clicks(), 1);
    assert.equal(
      h.saved.length,
      0,
      "generated drafts never become learned person facts",
    );
    assert.equal(journal.items.length, 1);
    const final = setup("<h2>Review</h2>", async () => []);
    connect(final);
    try {
      assert.equal(
        await final.run({ action: "fill", review: true, autoConfirm: true }),
        false,
      );
      assert.equal(final.w.JobsAIReview.pending(), true);
      assert.equal(final.clicks(), 0);
      assert.equal(await final.w.JobsAIReview.confirm(), true);
      assert.equal(journal.approved, journal.revision);
      assert.equal(
        final.clicks(),
        0,
        "manual submission setting remains authoritative",
      );
    } finally {
      final.close();
    }
  } finally {
    h.close();
  }
});

test("AI-owned verified drafts stay on the shared self-review card", async () => {
  const { createDraftReview } = await import("../src/custom/draft-review.js");
  const { bindAnswerEvidence } = await import("../src/custom/answer-proof.js");
  const h = setup(
    "<label>Why this team?<textarea required></textarea></label>",
    async (message) =>
      message.fields.map((field) =>
        bindAnswerEvidence(
          {
            ...reply(field, "A subjective draft."),
            decision: "draft",
            needsConfirmation: true,
            proof: {
              version: 2,
              status: "verified",
              profileId: "p",
              profileVersion: "v",
              field,
              value: "A subjective draft.",
              id: "d".repeat(24),
              paths: [],
            },
          },
          field,
          { id: "p", lastSync: "v" },
        ),
      ),
  );
  let recorded = 0;
  h.w.createDraftReview = (root, reader, surface, current) =>
    createDraftReview(root, reader, surface, current, {
      add: async () => {
        recorded++;
      },
      read: async () => ({ revision: 0, approved: -1, items: [] }),
      approve: async () => {},
      dispose: () => {},
    });
  try {
    h.w.JobsOperator.update({ mode: "agent", epoch: "agent", since: 2 });
    assert.equal(await h.run({ action: "next", autoConfirm: true }), false);
    assert.equal(h.w.JobsAIReview.pending(), true);
    assert.equal(recorded, 0);
    assert.equal(h.clicks(), 0);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});
