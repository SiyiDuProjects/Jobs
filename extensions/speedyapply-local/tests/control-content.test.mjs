import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";

const modules = Object.fromEntries(
  await Promise.all(
    [
      "dom-wait",
      "ashby-controls",
      "control-fields",
      "workday-controls",
      "greenhouse-controls",
      "tesla-controls",
      "operation-context",
      "control-content",
    ].map(async (name) => [
      name,
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ]),
  ),
);
const reviewSource = await readWithDependencies(
  new URL("../src/custom/ai-review.js", import.meta.url),
  "utf8",
);
const content = await fs.readFile(
  new URL("../source/content/routing.js", import.meta.url),
  "utf8",
);
const copy = (value) => JSON.parse(JSON.stringify(value));
function harness(
  html,
  {
    enabled = true,
    url = "https://jobs.ashbyhq.com/acme/test/application?token=private-token&email=private-mail#secret",
  } = {},
) {
  const dom = new JSDOM("<!doctype html>" + html, {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window;
  const listeners = [],
    sent = [],
    messages = [],
    invalidations = [];
  w.JobsControlConfig = { enabled };
  w.JobsAnswerMemory = undefined;
  w.JobsDiagnostics = undefined;
  w.chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: async (message) => {
        sent.push(copy(message));
        return message.type === "jobs:tab-profile"
          ? { data: { id: "ng", profile: { profileName: "Newgrad" } } }
          : {};
      },
      onMessage: { addListener: (callback) => listeners.push(callback) },
    },
  };
  for (const source of Object.values(modules)) w.eval(source);
  const send = (message, sender = { id: "test-extension" }) =>
    new Promise((resolve) => {
      for (const listener of listeners)
        listener(message, sender, (value) => resolve(copy(value)));
    });
  const inspect = async () => {
    const reply = await send({ type: "jobs:control-inspect" });
    assert(!reply.error, reply.error);
    return reply.data;
  };
  const activate = async (ats = "ashby", callback) => {
    const script = async (options) => {
      if (callback) return callback(options);
      await options.getProfile();
      options.setMessage("autofill-complete");
      return "upstream-result";
    };
    Object.defineProperty(script, "name", { value: ats });
    return w.JobsPageSession.run(script, {
      getProfile: async () => ({ profileName: "Newgrad" }),
      setMessage: (value) => messages.push(value),
      autofillSettings: {
        autoSubmit: true,
        autoClickNextPage: true,
        saveApplications: true,
      },
      ctx: {
        onInvalidated: (callback) => {
          invalidations.push(callback);
        },
      },
    });
  };
  const command = async (action, args, override = {}) => ({
    id: randomUUID(),
    target: await inspect().then(({ documentId, revision }) => ({
      documentId,
      revision,
    })),
    expiresAt: Date.now() + 60000,
    action,
    args,
    ...override,
  });
  return {
    dom,
    w,
    doc: w.document,
    listeners,
    sent,
    messages,
    send,
    inspect,
    activate,
    command,
    execute: (command) => send({ type: "jobs:control-execute", command }),
    rows: () => w.JobsControlFields.create(w.document).scan(),
    invalidate: () => invalidations.forEach((callback) => callback()),
    close: () => dom.window.close(),
  };
}
const ashby = (body) =>
  `<form aria-labelledby="job-application-form">${body}</form>`;
const textbox = '<label>Project summary<input required name="summary"></label>';
const submit =
  '<button type="button" class="ashby-application-form-submit-button">Submit application</button>';

test("document checks report only a live adapter and accept only the extension background", async () => {
  const h = harness(ashby(textbox));
  try {
    assert.equal((await h.send({ type: "jobs:document-check" })).active, false);
    await h.activate();
    assert.deepEqual(await h.send({ type: "jobs:document-check" }), {
      active: true,
      url: h.w.location.href,
    });
    assert.match(
      (await h.send({ type: "jobs:document-check" }, { id: "foreign" })).error,
      /background only/,
    );
    assert.match(
      (
        await h.send(
          { type: "jobs:document-check" },
          { id: "test-extension", tab: { id: 1 } },
        )
      ).error,
      /background only/,
    );
    h.invalidate();
    assert.equal((await h.send({ type: "jobs:document-check" })).active, false);
  } finally {
    h.close();
  }
});

async function reviewedHarness({ ready = true } = {}) {
  const h = harness(
    ashby(
      '<label>Location<select required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Unrelated<input value="Keep"></label>' +
        submit,
    ),
  );
  h.w.JobsReviewPresenter = { show() {} };
  h.w.eval(reviewSource);
  let confirmations = 0;
  await h.activate("ashby", async (options) => {
    await options.getProfile();
    const root = h.doc.querySelector("form"),
      reader = h.w.JobsControlFields.create(h.doc, () => root);
    h.w.JobsAIReview.add(root, reader, reader.scan()[0], { needsInput: true });
    if (ready)
      h.w.JobsAIReview.ready(async (nodes, release, { canProceed }) => {
        assert(canProceed());
        confirmations++;
        release();
        options.setMessage("complete-required");
      }, "next");
    options.setMessage(ready ? "ai-review" : "ai-thinking");
  });
  return { ...h, confirmations: () => confirmations };
}

test("remote review selects through the existing card and confirmation is separate and idempotent", async () => {
  const h = await reviewedHarness();
  try {
    const before = await h.inspect();
    assert.deepEqual(before.actions, [
      "inspect",
      "answer_review",
      "confirm_review",
    ]);
    const id = before.review.items[0].fieldId;
    const answered = await h.execute(
      await h.command("answer_review", {
        answers: [{ fieldId: id, value: "no" }],
      }),
    );
    assert.deepEqual(answered.data.appliedFieldIds, [id]);
    assert.equal(h.doc.querySelector("select").value, "no");
    assert(h.w.JobsAIReview.pending());
    assert.equal(h.confirmations(), 0);
    assert.match(
      (
        await h.execute(
          await h.command("fill_answers", {
            answers: [{ fieldId: id, value: "yes" }],
          }),
        )
      ).error,
      /unavailable/,
    );
    const cmd = await h.command("confirm_review");
    const confirmed = await h.execute(cmd);
    assert.equal(confirmed.state, "completed");
    assert(!h.w.JobsAIReview.pending());
    await h.execute(cmd);
    assert.equal(h.confirmations(), 1);
    assert.match(
      (await h.execute(await h.command("confirm_review"))).error,
      /unavailable/,
    );
  } finally {
    h.close();
  }
});

test("remote review rejects unrelated fields, changed answers, expired commands, and changed Profiles", async () => {
  const h = await reviewedHarness();
  try {
    const state = await h.inspect(),
      id = state.review.items[0].fieldId,
      other = state.fields.find((f) => f.id !== id).id;
    const unrelated = await h.execute(
      await h.command("answer_review", {
        answers: [{ fieldId: other, value: "Overwrite" }],
      }),
    );
    assert.deepEqual(unrelated.data.failedFieldIds, [other]);
    assert.equal(h.doc.querySelector("input").value, "Keep");
    const stale = await h.command("answer_review", {
      answers: [{ fieldId: id, value: "yes" }],
    });
    h.doc.querySelector("select").value = "no";
    assert.match((await h.execute(stale)).error, /Page changed/);
    assert.equal(h.doc.querySelector("select").value, "no");
    assert.match(
      (
        await h.execute(
          await h.command("confirm_review", {}, { expiresAt: Date.now() - 1 }),
        )
      ).error,
      /expired/,
    );
    h.w.chrome.runtime.sendMessage = async () => ({
      data: { id: "ng", profile: { profileName: "Changed" } },
    });
    assert.match(
      (await h.execute(await h.command("confirm_review"))).error,
      /Profile/,
    );
    assert.equal(h.confirmations(), 0);
    assert(h.w.JobsAIReview.pending());
  } finally {
    h.close();
  }
});

test("remote review stays unavailable while AI is still writing", async () => {
  const h = await reviewedHarness({ ready: false });
  try {
    assert.deepEqual((await h.inspect()).actions, ["inspect"]);
  } finally {
    h.close();
  }
});

function registrationClock(h) {
  const timers = new Map();
  let next = 0;
  h.w.setInterval = (callback, delay) => {
    assert.equal(delay, 10000);
    timers.set(++next, callback);
    return next;
  };
  h.w.clearInterval = (id) => timers.delete(id);
  return {
    timers,
    tick: async () => {
      for (const callback of [...timers.values()]) await callback();
    },
  };
}

for (const failure of ["sync", "async", "missing-id"])
  test(`registration heartbeat stops an invalid extension context (${failure})`, async () => {
    const h = harness(ashby(textbox)),
      clock = registrationClock(h);
    let attempts = 0;
    try {
      await h.activate();
      assert.equal(clock.timers.size, 1);
      const staleTick = [...clock.timers.values()][0];
      h.w.chrome.runtime.sendMessage = () => {
        attempts++;
        if (failure === "sync") throw Error("Extension context invalidated.");
        return Promise.reject(Error("Extension context invalidated."));
      };
      if (failure === "missing-id") h.w.chrome.runtime.id = undefined;
      await clock.tick();
      assert.equal(clock.timers.size, 0);
      assert.equal(attempts, failure === "missing-id" ? 0 : 1);
      await staleTick();
      await clock.tick();
      assert.equal(attempts, failure === "missing-id" ? 0 : 1);
      assert.equal(
        h.w.JobsPageSession.profile(),
        null,
        "stopping releases the temporary Profile",
      );
      if (failure !== "missing-id")
        assert.match(
          (await h.send({ type: "jobs:control-inspect" })).error,
          /No active ATS/,
        );
    } finally {
      h.close();
    }
  });

test("invalid initial context aborts existing lifecycle without starting the adapter or a heartbeat", async () => {
  const h = harness(ashby(textbox)),
    clock = registrationClock(h);
  let called = 0,
    aborted = 0;
  try {
    h.w.chrome.runtime.sendMessage = () => {
      throw Error("Extension context invalidated.");
    };
    const callbacks = [];
    await h.w.JobsPageSession.run(
      () => {
        called++;
      },
      {
        setMessage() {},
        ctx: {
          onInvalidated: (fn) => callbacks.push(fn),
          abort: () => {
            aborted++;
            callbacks.forEach((fn) => fn());
          },
        },
      },
    );
    assert.equal(called, 0);
    assert.equal(aborted, 1);
    assert.equal(clock.timers.size, 0);
  } finally {
    h.close();
  }
});

test("a transient background connection failure keeps registration retries and never refills the page", async () => {
  const h = harness(ashby(textbox)),
    clock = registrationClock(h);
  let attempts = 0,
    runs = 0;
  try {
    await h.activate("ashby", async (options) => {
      runs++;
      await options.getProfile();
    });
    h.w.chrome.runtime.sendMessage = (message) => {
      if (message.type !== "jobs:control-register") return Promise.resolve({});
      attempts++;
      if (attempts === 1)
        throw Error(
          "Could not establish connection. Receiving end does not exist.",
        );
      return Promise.resolve({});
    };
    await clock.tick();
    assert.equal(clock.timers.size, 1);
    await clock.tick();
    assert.equal(attempts, 2);
    assert.equal(runs, 1);
    h.invalidate();
    assert.equal(clock.timers.size, 0);
    await clock.tick();
    assert.equal(attempts, 2);
  } finally {
    h.close();
  }
});

test("pagehide releases the registration heartbeat", async () => {
  const h = harness(ashby(textbox)),
    clock = registrationClock(h);
  try {
    await h.activate();
    h.w.dispatchEvent(new h.w.Event("pagehide"));
    assert.equal(clock.timers.size, 0);
  } finally {
    h.close();
  }
});

test("renamed Workday and Greenhouse entry points retain protocol IDs, form roots and navigation actions", async () => {
  for (const [name, ats, html, url, action] of [
    [
      "workdayRunApplication",
      "workday",
      '<main data-automation-id="ApplyFlowPage"><label>Question<input required value="Ready"></label><button data-automation-id="pageFooterNextButton">Save and Continue</button></main>',
      "https://fixture.myworkdayjobs.com/apply",
      "next",
    ],
    [
      "greenhouseRunApplication",
      "greenhouse",
      '<form id="application-form"><label>Question<input required value="Ready"></label><button id="submit_app">Submit application</button></form>',
      "https://job-boards.greenhouse.io/fixture/jobs/1",
      "submit",
    ],
  ]) {
    const h = harness(html, { url });
    const observed = [];
    try {
      h.w.workdayRunApplication = async () => {};
      h.w.greenhouseRunApplication = async () => {};
      h.w[name] = async function (options) {
        await options.getProfile();
        options.setMessage("autofill-complete");
        return "adapter-result";
      };
      Object.defineProperty(h.w[name], "name", { value: name });

      h.w.JobsDiagnostics = {
        recentEvents: () => [],
        start: (id) => observed.push(id),
        beginRun() {},
        phase() {},
        stop() {},
      };
      h.w.eval(functionBlock(content, "jobsRunAdapter"));
      assert.equal(
        await h.w.jobsRunAdapter(h.w[name], {
          getProfile: async () => ({ profileName: "Newgrad" }),
          setMessage() {},
          autofillSettings: {},
          ctx: {},
        }),
        "adapter-result",
      );
      const report = await h.inspect();
      assert.equal(report.ats, ats);
      assert.equal(report.fields.length, 1);
      assert(report.actions.includes(action));
      assert.deepEqual(observed, [ats]);
      assert(
        h.sent.some(
          (message) =>
            message.type === "jobs:control-register" &&
            message.documentId === report.documentId,
        ),
      );
    } finally {
      h.close();
    }
  }
});

test("readable optional Greenhouse controls keep report schema and completion gate consistent", async () => {
  const h = harness(
    '<form id="application-form"><label>Optional attachment<input type="file"></label><div class="select"><label for="101">Optional survey</label><input id="101" class="select__input" role="combobox" aria-required="false"></div><button id="submit_app">Submit application</button></form>',
    { url: "https://job-boards.greenhouse.io/example/jobs/1" },
  );
  try {
    await h.activate("greenhouse");
    const report = await h.inspect();
    assert(
      report.actions.includes("submit"),
      "the readiness gate accepts readable optional blanks",
    );
    assert.equal(
      report.counts.unsupported,
      1,
      "native upload remains adapter-owned; dropdown writer is supported",
    );
    assert(
      report.fields.every(
        (field) => !Object.hasOwn(field, "completionReadable"),
      ),
      "internal capability does not leak into strict server schema",
    );
  } finally {
    h.close();
  }
});

function teslaCalendarHarness() {
  const h = harness(
    '<form><fieldset><div class="tds-form-item" variant="date"><label for="start">When are you available to start an internship?</label><div class="tds-form-input"><input id="start" class="tds-form-input-date" readonly required><div class="tds-form-input-trailing"><button type="button" id="open">Calendar</button></div><div class="tds-tooltip tds-tooltip--closed"><div class="tds-date-picker"></div></div></div></div><div class="tds-form-item"><label class="tds-form-label">Do you need to write a thesis or report for your university as part of your internship?</label><div><input type="radio" id="thesisYes" name="thesis"><label for="thesisYes">Yes</label><input type="radio" id="thesisNo" name="thesis"><label for="thesisNo">No</label></div></div></fieldset><button type="button" id="next">Next</button></form>',
    { url: "https://www.tesla.com/careers/search/job/apply/284004" },
  );
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  let month = 8,
    year = 2026,
    moves = 0,
    selected = 0,
    next = 0;
  const picker = h.doc.querySelector(".tds-date-picker"),
    input = h.doc.getElementById("start"),
    tooltip = h.doc.querySelector(".tds-tooltip");
  function render() {
    picker.innerHTML = `<div class="tds-date-picker-month"><button type="button">Previous month</button><label>${months[month]} ${year}</label><button type="button">Next month</button></div><div class="tds-date-picker-days-grid"><button type="button" class="tds-day tds-day--not-this-month">17</button>${Array.from({ length: 31 }, (_, i) => `<button type="button" class="tds-day">${i + 1}</button>`).join("")}</div>`;
    [...picker.querySelectorAll(".tds-date-picker-month button")].forEach(
      (button, index) =>
        (button.onclick = () => {
          moves++;
          month += index ? 1 : -1;
          if (month === 12) {
            month = 0;
            year++;
          }
          if (month === -1) {
            month = 11;
            year--;
          }
          render();
        }),
    );
    for (const day of picker.querySelectorAll(
      ".tds-day:not(.tds-day--not-this-month)",
    ))
      day.onclick = () => {
        selected++;
        input.value = `${months[month]} ${day.textContent}, ${year}`;
        tooltip.classList.add("tds-tooltip--closed");
      };
  }
  render();
  h.doc.getElementById("open").onclick = () =>
    tooltip.classList.remove("tds-tooltip--closed");
  h.doc.getElementById("next").onclick = () => next++;
  return { ...h, counters: () => ({ moves, selected, next }) };
}

test("Tesla remote date uses the visible calendar for an exact date and preserves readonly; thesis gets the actual question", async () => {
  const h = teslaCalendarHarness();
  try {
    await h.activate("tesla");
    const before = await h.inspect(),
      date = before.fields.find((f) => f.type === "date"),
      radio = before.fields.find((f) => f.type === "radio");
    assert(date?.required);
    assert(date.supported);
    assert.match(radio.question, /write a thesis/);
    const result = await h.execute(
      await h.command("fill_answers", {
        answers: [{ fieldId: date.id, value: "2027-05-17" }],
      }),
    );
    assert.deepEqual(result.data.appliedFieldIds, [date.id]);
    assert.deepEqual(h.counters(), { moves: 8, selected: 1, next: 0 });
    assert.equal(h.doc.getElementById("start").readOnly, true);
    assert.equal(h.doc.getElementById("start").value, "May 17, 2027");
    assert.equal(
      (await h.inspect()).fields.find((f) => f.id === date.id).value,
      "2027-05-17",
    );
  } finally {
    h.close();
  }
});

test("Tesla calendar refuses partial dates and disabled months without changing input or navigating", async () => {
  const h = teslaCalendarHarness();
  try {
    await h.activate("tesla");
    const date = (await h.inspect()).fields.find((f) => f.type === "date");
    let result = await h.execute(
      await h.command("fill_answers", {
        answers: [{ fieldId: date.id, value: "2027-05" }],
      }),
    );
    assert.deepEqual(result.data.failedFieldIds, [date.id]);
    assert.deepEqual(h.counters(), { moves: 0, selected: 0, next: 0 });
    h.doc.querySelectorAll(".tds-date-picker-month button")[1].disabled = true;
    result = await h.execute(
      await h.command("fill_answers", {
        answers: [{ fieldId: date.id, value: "2027-05-17" }],
      }),
    );
    assert.deepEqual(result.data.failedFieldIds, [date.id]);
    assert.equal(h.doc.getElementById("start").value, "");
    assert.equal(h.counters().next, 0);
  } finally {
    h.close();
  }
});

test("Workday lowercase applyFlowPage without a form exposes questionnaire fields to the shared interface", async () => {
  const h = harness(
    '<div data-automation-id="applyFlowPage"><div data-automation-id="applyFlowPrimaryQuestionsPage"><div data-automation-id="formField-test"><div data-automation-id="richText">Example question</div><button aria-haspopup="listbox" aria-label=" Select One Required" aria-invalid="true">Select One</button><input type="text" style="display:none"></div></div></div>',
    { url: "https://fixture.myworkdayjobs.com/apply" },
  );
  try {
    await h.activate("workday");
    const report = await h.inspect();
    assert.notEqual(report.phase, "unsupported_form");
    assert.equal(report.fields.length, 1);
    assert.equal(report.fields[0].question, "Example question");
    assert.equal(report.fields[0].required, true);
    assert.equal(report.fields[0].filled, false);
  } finally {
    h.close();
  }
});

test("disabled remote control preserves the page session and refuses commands", async () => {
  const h = harness(ashby(textbox), { enabled: false });
  try {
    assert.equal(h.sent.length, 0);
    assert.equal(typeof h.w.JobsControlFields.create, "function");
    assert.equal(typeof h.w.JobsPageSession.run, "function");
    h.w.eval(
      functionBlock(content, "jobsRunAdapter") +
        ";window.testRun=jobsRunAdapter;",
    );
    const options = {
        autofillSettings: { autoSubmit: true, autoClickNextPage: true },
        setMessage() {},
      },
      expected = { unchanged: true };
    let called = 0;
    assert.equal(
      await h.w.testRun((actual) => {
        called++;
        assert.equal(actual.autofillSettings, options.autofillSettings);
        return expected;
      }, options),
      expected,
    );
    assert.equal(called, 1);
    assert.match(
      (await h.send({ type: "jobs:control-execute", command: {} })).error,
      /disabled/,
    );
  } finally {
    h.close();
  }
});

test("enabled script registers only after the matched upstream adapter starts and preserves wrapper results", async () => {
  const h = harness(ashby(textbox));
  try {
    assert.equal(h.sent.length, 0);
    assert.match(
      (await h.send({ type: "jobs:control-inspect" })).error,
      /No active ATS/,
    );
    const result = await h.activate("ashby", async (options) => {
      assert.equal(options.autofillSettings.autoSubmit, true);
      assert.equal(options.autofillSettings.autoClickNextPage, true);
      assert.equal(options.autofillSettings.saveApplications, true);
      await options.getProfile();
      options.setMessage("autofill-complete");
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(
      h.sent.filter((message) => message.type === "jobs:control-register")
        .length,
      1,
    );
    assert.equal(h.sent[0].type, "jobs:control-register");
    const snapshot = await h.inspect();
    assert.equal(snapshot.ats, "ashby");
    assert.equal(snapshot.profileName, "Newgrad");
    assert.equal(snapshot.profileId, "ng");
    assert.equal(snapshot.coverage, "partial");
    h.invalidate();
    assert.match(
      (await h.send({ type: "jobs:control-inspect" })).error,
      /No active ATS/,
    );
  } finally {
    h.close();
  }
});

test("remote connection and inspection preserve normal settings; explicit field fill never clicks Next or Submit", async () => {
  const h = harness(ashby(textbox + submit));
  let options,
    clicks = 0;
  try {
    await h.activate("ashby", async (actual) => {
      options = actual;
      await actual.getProfile();
      actual.setMessage("autofill-complete");
    });
    h.doc.querySelector("button").onclick = () => clicks++;
    const field = (await h.inspect()).fields[0];
    await h.inspect();
    assert.equal(h.doc.querySelector("input").value, "");
    assert.equal(clicks, 0);
    const result = await h.execute(
      await h.command("fill_answers", {
        answers: [{ fieldId: field.id, value: "Fixture answer" }],
      }),
    );
    assert.equal(result.state, "completed");
    assert.deepEqual(result.data.appliedFieldIds, [field.id]);
    assert.equal(h.doc.querySelector("input").value, "Fixture answer");
    assert.equal(clicks, 0);
    assert.equal(options.autofillSettings.autoSubmit, true);
    assert.equal(options.autofillSettings.autoClickNextPage, true);
  } finally {
    h.close();
  }
});

test("private snapshot includes current ordinary values but omits secrets and hidden controls", async () => {
  const h = harness(
    ashby(`<label>Email<input type="email" value="private@example.test"></label>
  <label>Password<input type="password" value="private-password"></label>
  <label>Verification code<input autocomplete="one-time-code" value="123456"></label>
  <label>Social Security Number<input name="ssn" value="999-99-9999"></label>
  <div hidden><label>Hidden answer<input value="hidden-secret"></label></div>
  <div style="display:none"><label>Not rendered<input></label></div>
  <label>Resume<input type="file" required></label><div role="radiogroup" aria-label="Willing to relocate?"><span role="radio" aria-checked="false">Yes</span><span role="radio" aria-checked="false">No</span></div>
  ${textbox}${submit}`),
  );
  try {
    await h.activate();
    const snapshot = await h.inspect(),
      serialized = JSON.stringify(snapshot);
    for (const secret of [
      "private-password",
      "123456",
      "999-99-9999",
      "hidden-secret",
      "private-token",
      "private-mail",
      "#secret",
    ])
      assert(!serialized.includes(secret));
    assert.equal(
      snapshot.fields.find((field) => field.type === "email").value,
      "private@example.test",
    );
    assert.equal(snapshot.counts.total, 4);
    assert.equal(snapshot.counts.unsupported, 1);
    const custom = snapshot.fields.find(
      (field) => field.type === "custom-radio",
    );
    assert(custom);
    assert.equal(custom.filled, false);
    assert.equal(custom.supported, true);
    assert(!snapshot.actions.includes("submit"));
    assert(snapshot.actions.includes("fill_answers"));
  } finally {
    h.close();
  }
});

test("current typed answers are preserved and fabricated field IDs are reported as failed", async () => {
  const h = harness(
    ashby('<label>Existing<input value="My own answer"></label>' + textbox),
  );
  try {
    await h.activate();
    const snapshot = await h.inspect();
    assert.equal(snapshot.fields.length, 2);
    const existing = h.rows().find((row) => row.node.value === "My own answer");
    const forged = await h.command("fill_answers", {
      answers: [
        { fieldId: existing.public.id, value: "Overwrite" },
        { fieldId: "field-does-not-exist", value: "Missing" },
      ],
    });
    const result = await h.execute(forged);
    assert.equal(result.state, "completed");
    assert.deepEqual(result.data.appliedFieldIds, []);
    assert.equal(result.data.failedFieldIds.length, 2);
    assert.equal(h.doc.querySelector("input").value, "My own answer");
    assert.equal(h.doc.querySelector('[name="summary"]').value, "");
  } finally {
    h.close();
  }
});

test("an explicit replace flag edits a populated native control through the same field ID", async () => {
  const h = harness(ashby('<label>Summary<input value="Old answer"></label>'));
  try {
    await h.activate();
    const row = (await h.inspect()).fields[0];
    const result = await h.execute(
      await h.command("fill_answers", {
        answers: [{ fieldId: row.id, value: "Revised answer", replace: true }],
      }),
    );
    assert.deepEqual(result.data.appliedFieldIds, [row.id]);
    assert.equal(h.doc.querySelector("input").value, "Revised answer");
  } finally {
    h.close();
  }
});

test("radio, select and Yes/No answers select exact existing options and never approximate", async () => {
  const h = harness(
    ashby(`<fieldset><legend>Office preference</legend><label><input type="radio" name="office" value="yes" required>Yes</label><label><input type="radio" name="office" value="no" required>No</label></fieldset>
  <label>Source<select required><option value="">Choose</option><option value="referral">Friend or Referral</option><option value="linkedin">LinkedIn</option></select></label>
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Work preference *</label><div class="ashby-application-form-input-yesno"><button type="button" data-option="yes" aria-pressed="false">Yes</button><button type="button" data-option="no" aria-pressed="false">No</button></div></div>`),
  );
  try {
    h.doc
      .querySelectorAll("[data-option]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          h.doc
            .querySelectorAll("[data-option]")
            .forEach((other) =>
              other.setAttribute("aria-pressed", String(other === button)),
            ),
        ),
      );
    await h.activate();
    const initial = await h.inspect(),
      radio = initial.fields.find((field) => field.type === "radio"),
      select = initial.fields.find((field) => field.type === "select-one"),
      yesno = initial.fields.find((field) => field.type === "yesno");
    const bad = await h.execute(
      await h.command("fill_answers", {
        answers: [
          { fieldId: radio.id, value: "Maybe" },
          { fieldId: select.id, value: "Friend" },
          { fieldId: yesno.id, value: "N" },
        ],
      }),
    );
    assert.deepEqual(bad.data.appliedFieldIds, []);
    assert.equal(bad.data.failedFieldIds.length, 3);
    assert.equal(h.doc.querySelector("input:checked"), null);
    const good = await h.execute(
      await h.command("fill_answers", {
        answers: [
          { fieldId: radio.id, value: "No" },
          { fieldId: select.id, value: "referral" },
          { fieldId: yesno.id, value: "No" },
        ],
      }),
    );
    assert.equal(good.data.appliedFieldIds.length, 3);
    assert.deepEqual(good.data.failedFieldIds, []);
    assert.equal(h.doc.querySelector("input:checked").value, "no");
    assert.equal(h.doc.querySelector("select").value, "referral");
    assert.equal(
      h.doc.querySelector('[aria-pressed="true"]').dataset.option,
      "no",
    );
  } finally {
    h.close();
  }
});

test("native radios inside a labelled radiogroup remain visible as one unfilled question", async () => {
  const h = harness(
    ashby(
      '<div role="radiogroup" aria-label="Willing to work onsite?"><label><input type="radio" name="onsite" value="yes">Yes</label><label><input type="radio" name="onsite" value="no">No</label></div>',
    ),
  );
  try {
    await h.activate();
    const snapshot = await h.inspect();
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.fields.length, 1);
    assert.equal(snapshot.fields[0].type, "radio");
    assert.equal(snapshot.fields[0].question, "Willing to work onsite?");
    assert.equal(snapshot.fields[0].filled, false);
    assert.equal(snapshot.fields[0].supported, true);
  } finally {
    h.close();
  }
});

test("radio option IDs remain distinct when the website omits every native value attribute", async () => {
  const h = harness(
    ashby(
      '<fieldset><legend>Office preference</legend><label><input type="radio" name="office">Yes</label><label><input type="radio" name="office">No</label></fieldset>',
    ),
  );
  try {
    await h.activate();
    const field = (await h.inspect()).fields[0];
    assert.equal(new Set(field.options.map((option) => option.value)).size, 2);
    const result = await h.execute(
      await h.command("fill_answers", {
        answers: [
          {
            fieldId: field.id,
            value: field.options.find((option) => option.label === "No").value,
          },
        ],
      }),
    );
    assert.deepEqual(result.data.failedFieldIds, []);
    assert.equal(h.doc.querySelectorAll("input")[0].checked, false);
    assert.equal(h.doc.querySelectorAll("input")[1].checked, true);
  } finally {
    h.close();
  }
});

test("wrong document, changed revision and expired commands cannot write fields", async () => {
  const h = harness(ashby(textbox));
  try {
    await h.activate();
    const snapshot = await h.inspect(),
      args = {
        answers: [{ fieldId: snapshot.fields[0].id, value: "API answer" }],
      };
    const wrong = await h.command("fill_answers", args);
    wrong.target.documentId = "old-document";
    assert.match((await h.execute(wrong)).error, /replaced/);
    const expired = await h.command("fill_answers", args, {
      expiresAt: Date.now() - 1,
    });
    assert.match((await h.execute(expired)).error, /expired/);
    const stale = await h.command("fill_answers", args);
    h.doc.querySelector("input").value = "New manual answer";
    assert.match((await h.execute(stale)).error, /changed/);
    assert.equal(h.doc.querySelector("input").value, "New manual answer");
  } finally {
    h.close();
  }
});

test("concurrent duplicate command delivery executes once and rejects reused IDs with other content", async () => {
  const h = harness(ashby(textbox));
  let inputs = 0;
  try {
    await h.activate();
    h.doc.querySelector("input").addEventListener("input", () => inputs++);
    const snapshot = await h.inspect(),
      command = await h.command("fill_answers", {
        answers: [{ fieldId: snapshot.fields[0].id, value: "Answer once" }],
      });
    const replies = await Promise.all([h.execute(command), h.execute(command)]);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(inputs, 1);
    const reused = structuredClone(command);
    reused.args.answers[0].value = "Different answer";
    assert.match((await h.execute(reused)).error, /ID reused/);
    assert.equal(inputs, 1);
  } finally {
    h.close();
  }
});

test("submit click is pending without proof and cannot be replayed under a new command ID", async () => {
  const h = harness(
    ashby('<label>Complete<input required value="Ready"></label>' + submit),
  );
  let clicks = 0;
  try {
    await h.activate();
    h.doc.querySelector("button").addEventListener("click", () => clicks++);
    const command = await h.command("submit");
    const result = await h.execute(command);
    assert.equal(result.state, "completed");
    assert.equal(result.data.phase, "submitting");
    assert.deepEqual(result.data.evidence, { type: "none", text: "" });
    assert.equal(clicks, 1);
    assert.deepEqual(await h.execute(command), result);
    assert.equal(clicks, 1);
    assert(!(await h.inspect()).actions.includes("submit"));
    assert.match(
      (await h.execute(await h.command("submit"))).error,
      /unavailable/,
    );
    assert.equal(clicks, 1);
    h.w.JobsPageSession.confirmed();
    assert.equal((await h.inspect()).phase, "confirmed");
    assert(!(await h.inspect()).actions.includes("submit"));
  } finally {
    h.close();
  }
});

test("an interrupted submit remains unknown and blocks every automatic retry", async () => {
  const h = harness(
    ashby('<label>Complete<input required value="Ready"></label>' + submit),
  );
  let clicks = 0;
  try {
    await h.activate();
    h.doc.querySelector("button").click = () => {
      clicks++;
      throw Error("Page navigated during click");
    };
    const command = await h.command("submit"),
      result = await h.execute(command);
    assert.equal(result.state, "unknown");
    assert.equal(clicks, 1);
    assert.deepEqual(await h.execute(command), result);
    assert.equal(clicks, 1);
    assert.match(
      (await h.execute(await h.command("submit"))).error,
      /unavailable/,
    );
    assert.equal(clicks, 1);
  } finally {
    h.close();
  }
});

test("a completed newsletter form never substitutes for incomplete application fields", async () => {
  const h = harness(
    '<form id="newsletter"><label>Email<input value="newsletter@example.test"></label></form><form id="application-form" class="application-form"><label>Required job answer<input required></label><button type="button" id="btn-submit">Submit application</button></form>',
    { url: "https://jobs.lever.co/acme/test/apply" },
  );
  try {
    await h.activate("lever");
    const snapshot = await h.inspect();
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.fields[0].question, "Required job answer");
    assert(!snapshot.actions.includes("submit"));
    h.doc.querySelector("#application-form").remove();
    assert.deepEqual((await h.inspect()).actions, ["inspect"]);
  } finally {
    h.close();
  }
});

test("Workday review never exposes its shared final-submit button as Next", async () => {
  const h = harness(
    '<main data-automation-id="ApplyFlowPage"><section data-automation-id="contactInformationPage"><label>Complete<input value="Ready" required></label></section><button type="button" data-automation-id="bottom-navigation-next-button">Next</button></main>',
    { url: "https://acme.myworkdayjobs.com/en-US/jobs/apply" },
  );
  let clicks = 0;
  try {
    await h.activate("workday");
    h.doc.querySelector("button").addEventListener("click", () => clicks++);
    assert((await h.inspect()).actions.includes("next"));
    h.doc
      .querySelector("section")
      .setAttribute("data-automation-id", "reviewJobApplicationPage");
    h.doc.querySelector("button").textContent = "Submit";
    const snapshot = await h.inspect();
    assert(!snapshot.actions.includes("next"));
    assert(!snapshot.actions.includes("submit"));
    assert.match(
      (await h.execute(await h.command("next"))).error,
      /unavailable/,
    );
    assert.equal(clicks, 0);
  } finally {
    h.close();
  }
});

test("Next remains pending across command IDs until a page change or validation error is observed", async () => {
  const h = harness(
    '<main data-automation-id="ApplyFlowPage"><div role="alert"></div><label>Complete<input value="Ready" required></label><button type="button" data-automation-id="bottom-navigation-next-button">Next</button></main>',
    { url: "https://acme.myworkdayjobs.com/en-US/jobs/apply" },
  );
  let clicks = 0;
  try {
    await h.activate("workday");
    h.doc.querySelector("button").addEventListener("click", () => clicks++);
    const first = await h.execute(await h.command("next"));
    assert.equal(first.data.phase, "awaiting-transition");
    assert.match(
      (await h.execute(await h.command("next"))).error,
      /unavailable/,
    );
    assert.equal(clicks, 1);
    h.doc.querySelector("input").setAttribute("aria-invalid", "true");
    assert.equal((await h.inspect()).phase, "complete-required");
    assert(!(await h.inspect()).actions.includes("next"));
    h.doc.querySelector("input").removeAttribute("aria-invalid");
    await Promise.resolve();
    await h.execute(await h.command("next"));
    assert.equal(clicks, 2);
    h.doc.querySelector("label").innerHTML = "Next page<input required>";
    assert.equal((await h.inspect()).phase, "complete-required");
    assert(!(await h.inspect()).actions.includes("next"));
  } finally {
    h.close();
  }
});

test("page and foreign-extension senders cannot invoke the control listener", async () => {
  const h = harness(ashby(textbox));
  try {
    await h.activate();
    for (const sender of [
      { id: "foreign" },
      { id: "test-extension", tab: { id: 1 } },
    ])
      assert.match(
        (await h.send({ type: "jobs:control-inspect" }, sender)).error,
        /background only/,
      );
  } finally {
    h.close();
  }
});

test("native input setter commits an actual React controlled field and its blur state", async () => {
  const fixture = harness('<div id="react-root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: fixture.w,
    document: fixture.doc,
    HTMLElement: fixture.w.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { default: React, act } = await import("react"),
    { createRoot } = await import("react-dom/client");
  const root = createRoot(fixture.doc.getElementById("react-root"));
  function Form() {
    const [value, setValue] = React.useState(""),
      [blurred, setBlurred] = React.useState(false);
    return React.createElement(
      "form",
      { "aria-labelledby": "job-application-form" },
      React.createElement(
        "label",
        null,
        "Controlled answer",
        React.createElement("input", {
          required: true,
          value,
          onChange: (event) => setValue(event.target.value),
          onBlur: () => setBlurred(true),
        }),
      ),
      React.createElement("output", null, JSON.stringify({ value, blurred })),
    );
  }
  try {
    await act(() => root.render(React.createElement(Form)));
    await fixture.activate();
    const snapshot = await fixture.inspect(),
      command = await fixture.command("fill_answers", {
        answers: [
          {
            fieldId: snapshot.fields[0].id,
            value: "React accepted this answer",
          },
        ],
      });
    let result;
    await act(async () => {
      result = await fixture.execute(command);
    });
    assert.deepEqual(result.data.failedFieldIds, []);
    assert.equal(result.data.appliedFieldIds.length, 1);
    assert.deepEqual(
      JSON.parse(fixture.doc.querySelector("output").textContent),
      { value: "React accepted this answer", blurred: true },
    );
    assert.equal((await fixture.inspect()).counts.unfilled, 0);
  } finally {
    await act(() => root.unmount());
    fixture.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("connection invalidation releases the page and a late Profile cannot reactivate it", async () => {
  const h = harness("<form><label>First name<input required></label></form>");
  try {
    const started = Promise.withResolvers(),
      late = Promise.withResolvers();
    h.w.chrome.runtime.sendMessage = async (message) => {
      if (message.type === "jobs:tab-profile") {
        started.resolve();
        return late.promise;
      }
      return {};
    };
    const task = h.activate();
    await started.promise;
    const denied = await h.send(
      { type: "jobs:private-session-invalidated" },
      { id: "test-extension", tab: { id: 1 } },
    );
    assert.match(denied.error, /background only/);
    assert.equal(
      (await h.send({ type: "jobs:private-session-invalidated" })).ok,
      true,
    );
    late.resolve({ data: { id: "ng", profile: { profileName: "Newgrad" } } });
    await assert.rejects(task, /连接已改变/);
    const status = await h.send({ type: "jobs:document-check" });
    assert.equal(status.active, false);
    assert.match(
      (await h.send({ type: "jobs:control-inspect" })).error,
      /No active/,
    );
  } finally {
    h.dom.window.close();
  }
});

test("recovery pause releases a bound page while an answer is pending and prevents its late write or submit", async () => {
  const h = harness(ashby(textbox + submit));
  try {
    await h.activate();
    const started = Promise.withResolvers(),
      later = Promise.withResolvers();
    const session = { profile_1: { profile: { profileName: "Newgrad" } } };
    h.w.chrome.storage = {
      session: {
        getKeys: async () => Object.keys(session),
        set: async (data) => Object.assign(session, data),
        remove: async (keys) => {
          for (const key of keys) delete session[key];
        },
      },
    };
    h.w.chrome.tabs = {
      query: async () => [{ id: 1 }],
      sendMessage: async (_id, message) => h.send(message),
    };
    h.w.JobsManagementSync = { pendingSnapshot: async () => ({}) };
    h.w.eval(
      await readModule(
        new URL("../src/custom/recovery-pause.js", import.meta.url),
        "utf8",
      ),
    );
    let clicks = 0;
    h.doc.querySelector("button").addEventListener("click", () => clicks++);
    const run = h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile: { profileName: "Newgrad" },
      action: "submit",
      selector: "button",
      resolveAnswers: async () => {
        started.resolve();
        await later.promise;
        return [{ index: 0, answer: "Late synthetic answer" }];
      },
    });
    await started.promise;
    await assert.rejects(
      h.w.checkRecoveryPause(
        Response.json({ code: "recovery_application_pause" }, { status: 503 }),
      ),
      { code: "recovery_application_pause" },
    );
    later.resolve();
    assert.equal(await run, false);
    assert.equal(h.doc.querySelector("input").value, "");
    assert.equal(clicks, 0);
    assert.equal((await h.send({ type: "jobs:document-check" })).active, false);
    assert.equal(session.profile_1, undefined);
  } finally {
    h.close();
  }
});
