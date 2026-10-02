import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const code = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "review-presenter",
    "ai-review",
    "answer-memory",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Flow did not reach expected state");
}
function setup(html = "<label>Answer<input required></label>", resolveAnswers) {
  const dom = new JSDOM(
    `<main><section>${html}</section><button id="next" type="button">Next</button></main>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    profile = { profileName: "Fixture" },
    phases = [],
    requests = [],
    learned = [],
    storage = new Set();
  let invalidate,
    clicks = 0;
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
          return { data: { id: "fixture", profile, tabId: 1 } };
        return new Promise((resolve) => requests.push({ message, resolve }));
      },
    },
  };
  code.forEach((source) => w.eval(source));
  w.JobsPageSession = { root: () => w.document.querySelector("main") };
  w.JobsAnswerMemory.start(w.document, true, (rows) => {
    learned.push(...rows);
    return { ok: true };
  });
  w.document.querySelector("#next").onclick = () => clicks++;
  const wrapped = w.JobsAutomatic.observe({
    getProfile: async () => profile,
    setMessage: (phase) => phases.push(phase),
    ctx: { onInvalidated: (fn) => (invalidate = fn) },
  });
  const run = (options = {}) =>
    w.JobsAutomatic.advance({
      root: w.document.querySelector("section"),
      profile,
      action: "next",
      selector: "#next",
      setMessage: wrapped.setMessage,
      ...(resolveAnswers ? { resolveAnswers } : {}),
      ...options,
    });
  const reply = (request = 0, custom) =>
    requests[request].resolve({
      data: {
        answers: requests[request].message.fields.map((field) =>
          custom
            ? custom(field)
            : {
                fieldId: field.fieldId,
                state: "answer",
                value: "Answer",
                source: "profile",
                needsConfirmation: false,
              },
        ),
      },
    });
  return {
    w,
    profile,
    phases,
    requests,
    learned,
    wrapped,
    run,
    reply,
    clicks: () => clicks,
    invalidate: () => invalidate(),
    changeProfile: () => {
      for (const fn of storage)
        fn(
          {
            profile_1: {
              newValue: {
                id: "different",
                profile: { profileName: "Different" },
              },
            },
          },
          "session",
        );
    },
    close: () => {
      invalidate();
      w.close();
    },
  };
}

test("passive status watching batches mutation bursts and cancels queued scans on release", async () => {
  const h = setup(
    '<label>Answer<input required value="Known"></label><span id="validation">Ready</span>',
  );
  try {
    h.wrapped.setMessage("complete-manually");
    const api = h.w.JobsControlFields;
    const before = api.scans();
    for (let i = 0; i < 40; i++) {
      h.w.document.getElementById("validation").className = "state-" + i;
      await Promise.resolve();
    }
    const input = h.w.document.querySelector("input");
    input.value = "";
    input.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    await until(() => h.phases.at(-1) === "complete-required");
    assert(
      api.scans() - before <= 2,
      `passive observer performed ${api.scans() - before} scans`,
    );
    assert.equal(h.clicks(), 0);
    h.w.document.getElementById("validation").className = "queued";
    await Promise.resolve();
    const released = api.scans();
    h.invalidate();
    await delay(150);
    assert.equal(api.scans(), released);
  } finally {
    h.close();
  }
});

test("the run answers from the resolver before considering AI", async () => {
  let resolved = 0;
  const h = setup(undefined, async (fields) => {
    resolved++;
    assert.equal(fields.length, 1);
    return [{ index: 0, answer: "Saved answer" }];
  });
  try {
    assert.equal(await h.run(), true);
    assert.equal(resolved, 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.document.querySelector("input").value, "Saved answer");
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("Upbound Degree selects the explicit Profile degree without an AI request or confirmation", async () => {
  const h = setup(
    '<div data-automation-id="formField-degree"><label for="degree">Degree*</label><button id="degree" name="degree" aria-haspopup="listbox" aria-label="Degree Select One Required">Select One</button></div>',
  );
  try {
    h.profile.educationData = [
      { degree: "Bachelor of Arts", fieldOfStudy: "Physics" },
    ];
    h.w.eval(resolverWith("[]"));
    const button = h.w.document.getElementById("degree");
    const close = () => {
      h.w.document.getElementById("degree-options")?.remove();
      button.removeAttribute("aria-expanded");
    };
    button.onclick = () => {
      close();
      button.setAttribute("aria-controls", "degree-options");
      button.setAttribute("aria-expanded", "true");
      const list = h.w.document.createElement("ul");
      list.id = "degree-options";
      list.setAttribute("role", "listbox");
      for (const label of [
        "Bachelor of Science (B.S)",
        "Bachelor of Arts (B.A)",
      ]) {
        const option = h.w.document.createElement("li");
        option.setAttribute("role", "option");
        option.textContent = label;
        option.onclick = () => {
          button.textContent = label;
          button.setAttribute("aria-label", "Degree " + label + " Required");
          close();
        };
        list.append(option);
      }
      h.w.document.body.append(list);
    };
    button.onkeydown = (e) => {
      if (e.key === "Escape") close();
    };
    assert.equal(
      await h.run({ resolveAnswers: h.w.JobsAnswerResolver.resolve }),
      true,
    );
    assert.equal(button.textContent, "Bachelor of Arts (B.A)");
    assert.equal(h.requests.length, 0);
    assert.equal(h.w.document.querySelector("#jobs-ai-review"), null);
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("only an explicitly clear whole batch auto-confirms; uncertain profile deductions stay editable for confirmation", async () => {
  for (const flag of [false, true, undefined, "false"]) {
    const h = setup(
      '<label>Known answer<input required></label><label>Experience<select required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>',
    );
    try {
      const task = h.run();
      await until(() => h.requests.length === 1);
      h.reply(0, (field) => ({
        fieldId: field.fieldId,
        state: "answer",
        value: field.type === "text" ? "Known" : "no",
        source: "profile",
        ...(field.type === "text"
          ? { needsConfirmation: false }
          : flag === undefined
            ? {}
            : { needsConfirmation: flag }),
      }));
      assert.equal(await task, flag === false);
      assert.equal(h.clicks(), flag === false ? 1 : 0);
      assert.equal(
        h.w.document.querySelector("select").value,
        "no",
        "reviewable drafts still fill",
      );
      if (flag !== false) {
        assert.equal(h.phases.at(-1), "ai-review");
        assert.match(
          h.w.document.querySelector("#jobs-ai-review").shadowRoot.textContent,
          /待你确认/,
        );
        assert.equal(await h.w.JobsAIReview.confirm(), true);
        assert.equal(h.clicks(), 1);
      }
      assert.equal(h.requests.length, 1);
      assert.equal(h.learned.length, 0);
    } finally {
      h.close();
    }
  }
});

test("temporary empty renders before supplementation do not request AI or prevent continuation", async () => {
  for (const initiallyEmpty of [false, true]) {
    const h = setup(
      `<label>Answer<input required value="${initiallyEmpty ? "" : "Ready"}"></label>`,
    );
    try {
      const field = h.w.document.querySelector("input"),
        task = h.run();
      if (!initiallyEmpty) {
        await delay(50);
        field.value = "";
      }
      await delay(80);
      field.value = "Ready";
      assert.equal(await task, true);
      assert.equal(h.requests.length, 0);
      assert.equal(h.clicks(), 1);
      assert.equal(h.phases.at(-1), "awaiting-transition");
    } finally {
      h.close();
    }
  }
});

test("navigation authorization cannot strand a completed step when the site changes after settling", async () => {
  for (const mode of ["gap", "busy", "replacement", "button"]) {
    const h = setup('<label>Answer<input required value="Ready"></label>');
    try {
      let authorizations = 0;
      h.w.JobsQueuePage = {
        guard: (fn) => fn,
        allowed: () => true,
        verify: async () => {},
        clickNavigate: (action, button) => h.w.JobsPageActions.click(button),
        beforeNavigate: async () => {
          if (++authorizations === 1) {
            const field = h.w.document.querySelector("input"),
              root = field.parentElement;
            if (mode === "gap") {
              field.value = "";
              setTimeout(() => {
                field.value = "Ready";
                field.dispatchEvent(new h.w.Event("change", { bubbles: true }));
              }, 31);
            }
            if (mode === "busy") {
              root.setAttribute("aria-busy", "true");
              setTimeout(() => root.removeAttribute("aria-busy"), 31);
            }
            if (mode === "replacement") field.replaceWith(field.cloneNode());
            if (mode === "button") {
              const button = h.w.document.querySelector("#next");
              button.disabled = true;
              setTimeout(() => {
                button.disabled = false;
              }, 31);
            }
          }
        },
      };
      assert.equal(await h.run(), true, mode);
      assert(authorizations > 0, "the late mutation actually ran");
      assert.equal(h.clicks(), 1, mode);
      assert.equal(h.requests.length, 0, mode);
      assert.equal(h.phases.at(-1), "awaiting-transition", mode);
      assert(!h.phases.includes("complete-required"), mode);
      await h.run();
      assert.equal(
        h.clicks(),
        1,
        "rechecking readiness must not create a second navigation",
      );
    } finally {
      h.close();
    }
  }
});

test("final readiness still stops for persistent errors, changed Profile or manual edits", async () => {
  for (const mode of ["error", "profile", "manual"]) {
    const h = setup('<label>Answer<input required value="Ready"></label>');
    try {
      const add = h.w.document.addEventListener.bind(h.w.document);
      let authorizations = 0,
        manual;
      h.w.document.addEventListener = (type, handler, ...rest) => {
        if (type === "keydown") manual = handler;
        return add(type, handler, ...rest);
      };
      h.w.JobsQueuePage = {
        guard: (fn) => fn,
        allowed: () => true,
        verify: async () => {},
        clickNavigate: (action, button) => h.w.JobsPageActions.click(button),
        beforeNavigate: async () => {
          if (++authorizations === 1) {
            const field = h.w.document.querySelector("input");
            if (mode === "error") field.setAttribute("aria-invalid", "true");
            if (mode === "profile") h.changeProfile();
            if (mode === "manual") manual({ isTrusted: true, target: field });
          }
        },
      };
      assert.equal(await h.run(), false, mode);
      assert(authorizations > 0, "the late invalidation actually ran");
      assert.equal(h.clicks(), 0, mode);
      assert.equal(h.requests.length, 0, mode);
    } finally {
      h.close();
    }
  }
});

test("site-filled or rebuilt controls during AI retain their value and continue once without review", async () => {
  for (const rebuild of [false, true]) {
    const h = setup();
    try {
      const task = h.run();
      await until(() => h.requests.length === 1);
      let field = h.w.document.querySelector("input");
      if (rebuild) {
        const replacement = field.cloneNode();
        field.replaceWith(replacement);
        field = replacement;
      }
      field.value = "Original adapter answer";
      field.dispatchEvent(new h.w.Event("change", { bubbles: true }));
      h.reply();
      assert.equal(await task, true);
      assert.equal(field.value, "Original adapter answer");
      assert.equal(h.clicks(), 1);
      assert.equal(h.requests.length, 1);
      assert.equal(h.w.JobsAIReview.pending(), false);
      assert.equal(h.learned.length, 0);
      assert.equal(h.phases.at(-1), "awaiting-transition");
    } finally {
      h.close();
    }
  }
});

test("a site-filled field with real validation errors does not continue after discarding AI", async () => {
  const h = setup();
  try {
    const task = h.run();
    await until(() => h.requests.length === 1);
    const field = h.w.document.querySelector("input");
    field.value = "Rejected answer";
    field.setAttribute("aria-invalid", "true");
    h.reply();
    assert.equal(await task, false);
    assert.equal(h.clicks(), 0);
    assert.equal(h.phases.at(-1), "complete-required");
  } finally {
    h.close();
  }
});

test("an empty replacement control gets a fresh request and never receives an obsolete answer", async () => {
  const h = setup();
  try {
    const task = h.run();
    await until(() => h.requests.length === 1);
    const field = h.w.document.querySelector("input"),
      replacement = field.cloneNode();
    field.replaceWith(replacement);
    h.reply();
    await until(() => h.requests.length === 2);
    assert.equal(replacement.value, "");
    assert.equal(h.clicks(), 0);
    h.reply(1);
    assert.equal(await task, true);
    assert.equal(h.clicks(), 1);
    assert.equal(replacement.value, "Answer");
  } finally {
    h.close();
  }
});

test("late adapter errors cannot override AI or start a second parent-form request", async () => {
  const h = setup();
  try {
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.wrapped.setMessage("complete-manually");
    h.wrapped.setMessage("page-complete");
    await delay(20);
    assert.equal(h.phases.at(-1), "ai-thinking");
    assert.equal(h.requests.length, 1);
    const duplicate = h.w.JobsAutomatic.advance({
      root: h.w.document.querySelector("main"),
      profile: h.profile,
      action: "fill",
      setMessage: h.wrapped.setMessage,
    });
    assert.equal(duplicate, task);
    h.reply();
    assert.equal(await task, true);
    assert.deepEqual(h.phases, [
      "in-progress",
      "ai-thinking",
      "ai-filling",
      "checking",
      "awaiting-transition",
    ]);
    assert.equal(h.clicks(), 1);
    assert.equal(h.w.JobsAIReview.pending(), false);
    assert.equal(h.w.document.querySelector("#jobs-ai-review"), null);
    h.w.JobsAnswerMemory.flush();
    assert.equal(h.learned.length, 0);
    h.wrapped.setMessage("complete-required");
    assert.equal(h.phases.at(-1), "awaiting-transition");
    await h.run();
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("unknown personal answer stops once and remains blank for user input", async () => {
  const h = setup();
  try {
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.reply(0, (field) => ({
      fieldId: field.fieldId,
      state: "needs_input",
      value: null,
    }));
    await task;
    assert.equal(h.phases.at(-1), "ai-review");
    assert.equal(h.clicks(), 0);
    assert.equal(h.w.document.querySelector("input").value, "");
    assert(h.w.document.querySelector("#jobs-ai-review"));
    h.wrapped.setMessage("complete-manually");
    assert.equal(h.phases.at(-1), "ai-review");
    const field = h.w.document.querySelector("input");
    field.value = "User answer";
    field.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await h.w.JobsAIReview.confirm();
    assert.equal(h.clicks(), 1);
    assert.equal(h.requests.length, 1);
  } finally {
    h.close();
  }
});

test("optional explicit omissions auto-confirm without a popup or remembered empty value", async () => {
  const h = setup(
    "<label>Answer<input required></label><label>Optional detail<input></label>",
  );
  try {
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.reply(0, (field) => ({
      fieldId: field.fieldId,
      state: "answer",
      value: field.required ? "Answer" : "",
      source: "profile",
      needsConfirmation: false,
      reason: "Not applicable",
    }));
    assert.equal(await task, true);
    assert.equal(h.clicks(), 1);
    assert.equal(h.learned.length, 0);
    assert.equal(h.w.document.querySelector("#jobs-ai-review"), null);
  } finally {
    h.close();
  }
});

test("late validation prevents automatic confirmation and never clicks Next", async () => {
  const h = setup();
  try {
    h.w.document
      .querySelector("input")
      .addEventListener("change", () =>
        setTimeout(
          () =>
            h.w.document
              .querySelector("input")
              .setAttribute("aria-invalid", "true"),
          15,
        ),
      );
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.reply();
    assert.equal(await task, false);
    assert.equal(h.clicks(), 0);
    assert.equal(h.learned.length, 0);
    assert.equal(h.phases.at(-1), "ai-review");
    assert(h.w.document.querySelector("#jobs-ai-review"));
  } finally {
    h.close();
  }
});

test("invalidated runs cannot publish failures into a new page status", async () => {
  const h = setup();
  try {
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.invalidate();
    const count = h.phases.length;
    h.requests[0].resolve({ error: "Old request" });
    await task;
    assert.equal(h.phases.length, count);
    assert.equal(h.clicks(), 0);
    h.wrapped.setMessage("complete-required");
    await delay(0);
    assert.equal(h.phases.length, count);
  } finally {
    h.close();
  }
});

test("actual submit has a submission phase; delayed completion cannot turn it into a field prompt", async () => {
  const h = setup('<label>Answer<input required value="Ready"></label>');
  try {
    await h.wrapped.getProfile();
    assert.equal(await h.run({ action: "submit" }), true);
    assert.deepEqual(h.phases, ["in-progress", "submitting"]);
    h.wrapped.setMessage("page-complete");
    h.wrapped.setMessage("complete-manually");
    await delay(0);
    assert.equal(h.phases.at(-1), "submitting");
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("a real ATS validation error after navigation exits the pending phase without retrying", async () => {
  const h = setup('<label>Answer<input required value="Ready"></label>');
  try {
    await h.wrapped.getProfile();
    await h.run({ action: "submit" });
    h.w.document.querySelector("input").setAttribute("aria-invalid", "true");
    await until(() => h.phases.at(-1) === "complete-required");
    assert.equal(h.clicks(), 1);
    h.w.document.querySelector("input").removeAttribute("aria-invalid");
    await until(() => h.phases.at(-1) === "page-complete");
    assert.equal(h.clicks(), 1);
    assert.equal(h.requests.length, 0);
  } finally {
    h.close();
  }
});

test("the next step gets a new flow while the previous step cannot publish a delayed result", async () => {
  const h = setup();
  try {
    await h.wrapped.getProfile();
    const old = h.run();
    await until(() => h.requests.length === 1);
    h.w.document.querySelector("section").remove();
    h.w.document
      .querySelector("main")
      .insertAdjacentHTML(
        "afterbegin",
        '<section><label>Next answer<input required value="Ready"></label></section>',
      );
    const next = h.run();
    await next;
    assert.equal(h.clicks(), 1);
    const count = h.phases.length;
    h.requests[0].resolve({ error: "Old step failed" });
    await old;
    assert.equal(h.phases.length, count);
    assert.equal(h.phases.at(-1), "awaiting-transition");
  } finally {
    h.close();
  }
});

test("leaving the AI step at the same URL clears its abandoned busy banner without filling or navigation", async () => {
  for (const remove of [true, false]) {
    const h = setup();
    try {
      await h.wrapped.getProfile();
      const task = h.run();
      await until(() => h.requests.length === 1);
      const old = h.w.document.querySelector("section");
      if (remove) old.remove();
      else old.hidden = true;
      h.w.document
        .querySelector("main")
        .insertAdjacentHTML(
          "afterbegin",
          '<section><label>Previous step<input value="Keep"></label></section>',
        );
      h.reply();
      assert.equal(await task, false);
      assert.equal(h.phases.at(-1), null);
      assert.equal(h.clicks(), 0);
      assert.equal(h.requests.length, 1);
      assert.equal(h.w.document.querySelector("section input").value, "Keep");
    } finally {
      h.close();
    }
  }
});

test("synchronous adapter completion can close the submission status", async () => {
  const h = setup('<label>Answer<input required value="Ready"></label>');
  try {
    h.w.document
      .querySelector("#next")
      .addEventListener("click", () => h.wrapped.setMessage(null));
    await h.wrapped.getProfile();
    assert.equal(await h.run({ action: "submit" }), true);
    assert.equal(h.phases.at(-1), null);
    assert.equal(h.clicks(), 1);
  } finally {
    h.close();
  }
});

test("a delayed parent-form callback after AI failure does not retry the same questions", async () => {
  const h = setup();
  try {
    await h.wrapped.getProfile();
    const task = h.run();
    await until(() => h.requests.length === 1);
    h.requests[0].resolve({ error: "Provider unavailable" });
    await task;
    assert.equal(h.phases.at(-1), "complete-required");
    h.wrapped.setMessage("complete-manually");
    await delay(30);
    assert.equal(h.requests.length, 1);
    assert.equal(h.phases.at(-1), "complete-required");
    assert.equal(h.clicks(), 0);
  } finally {
    h.close();
  }
});
