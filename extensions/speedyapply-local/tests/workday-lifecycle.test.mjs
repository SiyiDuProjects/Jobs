import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const names = [
  "option-match",
  "profile-answers",
  "dom-wait",
  "control-fields",
  "workday-controls",
  "form-pipeline",
  "review-presenter",
  "ai-review",
  "operation-context",
  "automatic-fill",
];
const codes = await Promise.all(
  names.map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const bundle = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const shared = await Promise.all(
  ["dom-controls", "answer-helpers"].map((name) =>
    readModule(
      new URL("../source/content/shared/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const block = (name) => functionBlock(bundle, name);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 6000;
  while (!predicate() && Date.now() < end) await delay(10);
  assert(predicate());
}

test("Workday Add waits for the section in a hidden tab without repeating clicks, and stops on page failure or step replacement", async () => {
  for (const mode of ["delayed", "fatal", "replaced"]) {
    const dom = new JSDOM(
        '<main><section data-automation-id="applyFlowMyExpPage"><button id="add">Add Work Experience</button></section></main>',
        {
          url: "https://fixture.myworkdayjobs.com/apply",
          runScripts: "outside-only",
        },
      ),
      w = dom.window;
    Object.defineProperty(w.document, "visibilityState", { value: "hidden" });
    w.requestAnimationFrame = () => {
      throw Error("Hidden page must not need animation frames");
    };
    w.chrome ||= { runtime: {} };
    codes.forEach((code) => w.eval(code));
    shared.forEach((code) => w.eval(code));
    w.eval(block("workdayAddRepeatedSection"));
    let clicks = 0,
      intervals = 0;
    w.setInterval = () => {
      intervals++;
      throw Error("An Add operation must not leave a click loop");
    };
    w.jobsClick = (path) => {
      clicks++;
      w.jobsFindXPath(path)?.click();
    };
    w.document.querySelector("#add").onclick = () =>
      setTimeout(
        () => {
          if (mode === "delayed")
            w.document
              .querySelector("section")
              .insertAdjacentHTML("beforeend", '<div id="entry"></div>');
          if (mode === "replaced") w.document.querySelector("section").remove();
          if (mode === "fatal")
            w.document.querySelector("main").innerHTML =
              "<h2>Something went wrong</h2><p>Error Code: VPS|abe3be1e-c8f2-41ec-b14e-ff7b5bc12c08</p>";
        },
        mode === "delayed" ? 650 : 30,
      );
    try {
      const task = w.workdayAddRepeatedSection(
        '//*[@id="add"]',
        '//*[@id="entry"]',
      );
      if (mode === "delayed") {
        assert.equal((await task).id, "entry");
        assert.equal(
          (
            await w.workdayAddRepeatedSection(
              '//*[@id="add"]',
              '//*[@id="entry"]',
            )
          ).id,
          "entry",
        );
      } else await assert.rejects(task, /停止自动填写/);
      await delay(550);
      assert.equal(clicks, 1, mode);
      assert.equal(intervals, 0);
    } finally {
      w.close();
    }
  }
});

test("visible VPS page failures override both filling and navigation after the form disappears; hidden errors do not", async () => {
  for (const phase of ["in-progress", "awaiting-transition"]) {
    const dom = new JSDOM(
        '<main><section><label>Name<input value="Ready" required></label></section><div hidden><p>Error Code: VPS|abe3be1e-c8f2-41ec-b14e-ff7b5bc12c08</p></div></main>',
        {
          url: "https://fixture.myworkdayjobs.com/apply",
          runScripts: "outside-only",
        },
      ),
      w = dom.window;
    w.JobsAIReview = { pending: () => false };
    w.chrome ||= { runtime: {} };
    codes.forEach((code) => w.eval(code));
    const messages = [],
      wrapped = w.JobsAutomatic.observe({
        getProfile: async () => ({}),
        setMessage: (value) => messages.push(value),
      });
    try {
      const reader = w.JobsControlFields.create(w.document, () =>
        w.document.querySelector("section"),
      );
      assert.equal(reader.state().ready, true);
      wrapped.setMessage(phase);
      w.document.querySelector("section").remove();
      w.document
        .querySelector("main")
        .insertAdjacentHTML(
          "afterend",
          "<div><h2>Something went wrong</h2><p>Error Code: VPS|abe3be1e-c8f2-41ec-b14e-ff7b5bc12c08</p></div>",
        );
      await delay(0);
      assert.equal(messages.at(-1), "site-error");
      wrapped.setMessage("in-progress");
      wrapped.setMessage("page-complete");
      assert.equal(messages.at(-1), "site-error");
      assert.equal(reader.state().phase, "site-error");
      assert.equal(reader.state().ready, false);
      await assert.rejects(wrapped.getProfile(), /页面出错/);
    } finally {
      w.dispatchEvent(new w.Event("pagehide"));
      w.close();
    }
  }
});

test("actual Workday step lifecycle waits for committed fields and enabled footer, then advances and submits once", async () => {
  for (const [step, fill] of [
    ["contactInformationPage", "workdayFillInformationPage"],
    ["myExperiencePage", "workdayFillExperiencePage"],
    ["selfIdentificationPage", "workdayFillSelfIdentification"],
  ]) {
    const dom = new JSDOM(
      `<main data-automation-id="applyFlowPage"><div hidden><input required><p data-automation-id="inputAlert">Old step error</p></div><section data-automation-id="${step}"><label>Name<input required></label><div role="alert">Document uploaded successfully</div></section><button data-automation-id="pageFooterNextButton" disabled>Save and Continue</button></main>`,
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    );
    const w = dom.window,
      profile = { profileName: "Fixture" },
      phases = [];
    let next = 0,
      submit = 0,
      filled = 0;
    w.JobsAIReview = { pending: () => false };
    w.chrome = {
      runtime: {
        sendMessage: async () => ({ data: { id: "fixture", profile } }),
      },
    };
    w.chrome ||= { runtime: {} };
    codes.forEach((code) => w.eval(code));
    shared.forEach((code) => w.eval(code));
    w.jobsReportJobTitle = async () => false;
    w.eval(
      block("workdayTrackReviewSubmitClick") +
        "\n" +
        block("workdayRunApplication") +
        "\n" +
        block("workdayHandleReviewPage"),
    );
    w.jobsWaitForXPathNodes = (path) =>
      path.includes(step) || path.includes("reviewJobApplicationPage")
        ? w.JobsDOMWait.until(() => w.document && w.jobsFindXPath(path))
        : new Promise(() => {});
    w.JobsPageSession = { root: () => w.document.querySelector("main") };
    w[fill] = async () => {
      filled++;
      await w.JobsControlFields.writeText(
        w.document.querySelector("section input"),
        "Fixture",
      );
      const input = w.document.querySelector("section input");
      input.setAttribute("aria-invalid", "true");
      setTimeout(() => {
        input.removeAttribute("aria-invalid");
        w.document.querySelector("button").disabled = false;
      }, 120);
    };
    const wrapped = w.JobsAutomatic.observe({
      getProfile: async () => profile,
      setMessage: (m) => phases.push(m),
      autofillSettings: {
        autoClickNextPage: true,
        autoSubmit: true,
        saveApplications: false,
      },
      accountSettings: {},
      ctx: {},
    });
    w.document.querySelector("button").onclick = () => {
      if (!next) {
        next++;
        w.document.querySelector("section").remove();
        w.document
          .querySelector("main")
          .insertAdjacentHTML(
            "afterbegin",
            '<section data-automation-id="applyFlowReviewPage"><h2>Review</h2><div role="alert">Resume uploaded successfully</div></section>',
          );
        w.document.querySelector("button").textContent = "Submit";
      } else submit++;
    };
    try {
      await w.workdayRunApplication(wrapped);
      await until(() => submit === 1);
      assert.equal(next, 1);
      assert.equal(filled, 1);
      assert.equal(phases.at(-1), "submitting");
      assert(!phases.includes("complete-required"));
      assert(!phases.includes("complete-manually"));
    } finally {
      w.dispatchEvent(new w.Event("pagehide"));
      await delay(0);
      dom.window.close();
    }
  }
});

test("all text paths use a focus and settled-input cycle before blur validation", async () => {
  for (const path of ["adapter", "supplement", "generated"]) {
    const dom = new JSDOM(
        "<form><label>Permanent address<textarea required></textarea></label></form>",
        {
          url: "https://fixture.myworkdayjobs.com/apply",
          runScripts: "outside-only",
        },
      ),
      w = dom.window;
    w.chrome ||= { runtime: {} };
    codes.forEach((code) => w.eval(code));
    let editing = false,
      draft = "",
      committed = "";
    const node = w.document.querySelector("textarea");
    node.addEventListener("focus", () => (editing = true));
    node.addEventListener("input", () => {
      if (editing) {
        const value = node.value;
        setTimeout(() => (draft = value), 0);
      }
    });
    node.addEventListener("blur", () => {
      committed = draft;
      node.setAttribute("aria-invalid", String(!committed));
      editing = false;
    });
    try {
      if (path === "adapter")
        await w.JobsFormPipeline.bind([
          {
            name: "address",
            find: "textarea",
            answer: "Fixture address",
            replace: true,
          },
        ]);
      if (path === "supplement") {
        const reader = w.JobsControlFields.create(
          w.document,
          () => w.document.querySelector("form"),
          { write: true },
        );
        await reader.apply(reader.scan()[0], "Fixture address");
      }
      if (path === "generated") {
        Object.getOwnPropertyDescriptor(
          w.HTMLTextAreaElement.prototype,
          "value",
        ).set.call(node, "Fixture address");
        assert.equal(committed, "");
        await w.JobsControlFields.writeText(node, node.value);
      }
      assert.equal(node.value, "Fixture address");
      assert.equal(committed, "Fixture address", path);
      assert.equal(node.getAttribute("aria-invalid"), "false");
    } finally {
      dom.window.close();
    }
  }
});

test("manual continuation is a transition; a transient required error must not flash a stopped status or click again", async () => {
  const dom = new JSDOM(
      '<main><label>Name<input required value="Fixture"></label><button>Save and Continue</button></main>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    phases = [];
  w.JobsAIReview = { pending: () => false };
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  w.JobsPageSession = { root: () => w.document.querySelector("main") };
  let click;
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, handler, ...rest) => {
    if (type === "click") click = handler;
    return add(type, handler, ...rest);
  };
  const wrapped = w.JobsAutomatic.observe({
    setMessage: (phase) => phases.push(phase),
    getProfile: async () => ({}),
  });
  try {
    wrapped.setMessage("page-complete");
    await delay(0);
    click({ isTrusted: true, target: w.document.querySelector("button") });
    w.document.querySelector("input").setAttribute("aria-invalid", "true");
    await delay(90);
    w.document.querySelector("input").removeAttribute("aria-invalid");
    await delay(400);
    assert.equal(phases.at(-1), "awaiting-transition");
    assert(!phases.includes("complete-required"));
  } finally {
    w.dispatchEvent(new w.Event("pagehide"));
    dom.window.close();
  }
});

test("field state treats informational live regions separately from actual validation errors", () => {
  const dom = new JSDOM(
      '<section><div role="alert">Resume uploaded successfully</div></section>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("section"),
    reader = w.JobsControlFields.create(w.document, () => root);
  try {
    assert.equal(reader.state({ review: true }).ready, true);
    root.insertAdjacentHTML(
      "beforeend",
      '<p data-automation-id="inputAlert">Missing answer</p>',
    );
    assert.equal(reader.state({ review: true }).ready, false);
    assert.equal(reader.state().phase, "complete-required");
  } finally {
    dom.window.close();
  }
});

test("actual original questionnaire uses shared listbox operations for div popups and skips hidden previous steps", async () => {
  const dom = new JSDOM(
      `<div hidden data-automation-id="formField-old"><div data-automation-id="richText">Old question</div><button aria-haspopup="listbox">Select One</button></div><section id="step"><div data-automation-id="formField-current"><div data-automation-id="richText">Current question</div><button id="choice" aria-haspopup="listbox" aria-label="Current question Required">Select One</button></div></section>`,
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  shared.forEach((code) => w.eval(code));
  w.eval(block("workdayFillQuestionnaire"));
  w.jobsMountManualAnswerControls = async () => {};
  let asked,
    hiddenClicks = 0;
  const resolve = async (questions) => {
    asked = questions;
    return [{ index: 0, answer: "Yes" }];
  };
  w.document.querySelector("[hidden] button").onclick = () => hiddenClicks++;
  const button = w.document.querySelector("#choice");
  const close = () => {
    w.document.querySelector("#list")?.remove();
    button.removeAttribute("aria-controls");
  };
  button.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  button.onclick = () => {
    button.setAttribute("aria-controls", "list");
    w.document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="list" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
    );
    for (const option of w.document.querySelectorAll('[role="option"]'))
      option.onclick = () => {
        button.textContent = option.textContent;
        close();
      };
  };
  w.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { id: "fixture", profile: {} } }),
    },
  };
  try {
    await w.JobsAutomatic.advance({
      root: w.document.querySelector("#step"),
      profile: {},
      action: "fill",
      resolveAnswers: resolve,
      fill: () => w.workdayFillQuestionnaire({}, "//*[@id='step']", false, {}),
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].question, "Current question");
    assert.equal(button.textContent, "Yes");
    assert.equal(hiddenClicks, 0);
  } finally {
    w.close();
  }
});

test("actual questionnaire leaves a dropdown without options unanswered, with diagnostic evidence, for the step review", async () => {
  const dom = new JSDOM(
      '<section id="step"><div data-automation-id="formField-q"><div data-automation-id="richText">Notice period</div><button aria-haspopup="listbox" aria-label="Notice period Required">Select One</button></div></section>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    events = [];
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  shared.forEach((code) => w.eval(code));
  w.eval(block("workdayFillQuestionnaire"));
  w.jobsMountManualAnswerControls = async () => {};
  w.JobsDiagnostics = {
    note: (type, node, detail) => events.push({ type, detail }),
  };
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, options) =>
    until(read, { ...options, timeout: 20 });
  const resolve = async (questions) => {
    assert.deepEqual(JSON.parse(JSON.stringify(questions[0].options)), []);
    return [];
  };
  // The answer stage never guesses; the step's run sends this required gap to review instead of stopping every other field.
  w.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { id: "fixture", profile: {} } }),
    },
  };
  try {
    await w.JobsAutomatic.advance({
      root: w.document.querySelector("#step"),
      profile: {},
      action: "fill",
      resolveAnswers: resolve,
      fill: () => w.workdayFillQuestionnaire({}, "//*[@id='step']", false, {}),
    });
    assert.equal(w.document.querySelector("button").textContent, "Select One");
    assert(
      events.some(
        (e) => e.type === "auto_options_wait" && e.detail === "Notice period",
      ),
    );
    assert(events.some((e) => e.type === "auto_options_unavailable"));
  } finally {
    w.close();
  }
});

test("fields mounted after adapter return reenter supplementation before one continuation", async () => {
  const dom = new JSDOM(
      '<section id="step"><label>Existing answer<input value="Keep"></label></section><button id="next" disabled>Save and Continue</button>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    profile = { profileName: "Fixture" },
    phases = [],
    events = [];
  w.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { id: "fixture", profile } }),
    },
  };
  w.JobsAIReview = { pending: () => false };
  w.JobsDiagnostics = {
    note: (type, node, detail) => events.push({ type, detail }),
  };
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("#step");
  let clicks = 0,
    resolved = 0,
    fills = 0;
  w.document.querySelector("#next").onclick = () => clicks++;
  try {
    const ok = await w.JobsAutomatic.advance({
      root,
      profile,
      action: "next",
      selector: "#next",
      setMessage: (p) => phases.push(p),
      fill: async () => {
        fills++;
        setTimeout(() => {
          root.insertAdjacentHTML(
            "beforeend",
            '<label>Late required choice<select required><option value="">Select One</option><option value="known">Fixture choice</option></select></label>',
          );
          w.document.querySelector("#next").disabled = false;
        }, 100);
      },
      resolveAnswers: async (fields) => {
        resolved++;
        assert.equal(fields.length, 1);
        return [{ index: 0, answer: "Fixture choice" }];
      },
    });
    assert.equal(ok, true, JSON.stringify(events));
    assert.equal(fills, 1);
    assert.equal(resolved, 1);
    assert.equal(clicks, 1);
    assert.equal(root.querySelector("input").value, "Keep");
    assert.equal(root.querySelector("select").value, "known");
    assert(!phases.includes("complete-required"));
    assert(events.some((e) => e.type === "auto_fields_discovered"));
  } finally {
    w.close();
  }
});

test("Next validation reports the remaining gap without starting a second filling chain", async () => {
  const dom = new JSDOM(
      '<main><label>Existing answer<input value="Keep"></label></main><button id="next">Save and Continue</button>',
      {
        url: "https://fixture.myworkdayjobs.com/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    profile = { profileName: "Fixture" },
    phases = [];
  w.chrome = {
    runtime: {
      sendMessage: async () => ({ data: { id: "fixture", profile } }),
    },
  };
  w.JobsAIReview = { pending: () => false };
  w.chrome ||= { runtime: {} };
  codes.forEach((code) => w.eval(code));
  const root = w.document.querySelector("main");
  w.JobsPageSession = { root: () => root };
  const wrapped = w.JobsAutomatic.observe({
    getProfile: async () => profile,
    setMessage: (p) => phases.push(p),
  });
  let clicks = 0,
    fills = 0,
    resolved = 0;
  w.document.querySelector("#next").onclick = () => {
    clicks++;
    if (clicks === 1)
      root.insertAdjacentHTML(
        "beforeend",
        '<label>Late choice<select required><option value="">Select One</option><option value="known">Fixture choice</option></select></label>',
      );
    else root.remove();
  };
  try {
    await w.JobsAutomatic.advance({
      root,
      profile,
      action: "next",
      selector: "#next",
      setMessage: wrapped.setMessage,
      fill: async () => fills++,
      resolveAnswers: async (fields) => {
        resolved++;
        assert.equal(fields.length, 1);
        return [{ index: 0, answer: "Fixture choice" }];
      },
    });
    await until(() => phases.at(-1) === "complete-required");
    assert.equal(clicks, 1);
    assert.equal(fills, 1);
    assert.equal(resolved, 0);
    assert.equal(root.querySelector("input").value, "Keep");
    assert.equal(root.querySelector("select").value, "");
  } finally {
    w.dispatchEvent(new w.Event("pagehide"));
    w.close();
  }
});

test("post-navigation observation never retries Next or Submit or overrides a manual edit", async () => {
  for (const mode of ["submit", "next"]) {
    const dom = new JSDOM(
        '<main><label>Existing answer<input value="Keep"></label></main><button id="next">Continue</button>',
        {
          url: "https://fixture.myworkdayjobs.com/apply",
          runScripts: "outside-only",
        },
      ),
      w = dom.window,
      profile = { profileName: "Fixture" };
    w.chrome = {
      runtime: {
        sendMessage: async () => ({ data: { id: "fixture", profile } }),
      },
    };
    w.JobsAIReview = { pending: () => false };
    w.chrome ||= { runtime: {} };
    codes.forEach((code) => w.eval(code));
    const root = w.document.querySelector("main");
    w.JobsPageSession = { root: () => root };
    const wrapped = w.JobsAutomatic.observe({
      getProfile: async () => profile,
      setMessage: () => {},
    });
    let clicks = 0,
      resolved = 0;
    w.document.querySelector("#next").onclick = () => {
      clicks++;
      root.insertAdjacentHTML(
        "beforeend",
        `<label>Late choice ${clicks}<select required><option value="">Select One</option><option value="known">Fixture choice</option></select></label>`,
      );
    };
    try {
      await w.JobsAutomatic.advance({
        root,
        profile,
        action: mode === "submit" ? "submit" : "next",
        selector: "#next",
        setMessage: wrapped.setMessage,
        resolveAnswers: async () => {
          resolved++;
          return [{ index: 0, answer: "Fixture choice" }];
        },
      });
      root.querySelector("input").value = "Manual edit";
      await delay(600);
      assert.equal(clicks, 1, mode);
      assert.equal(resolved, 0, mode);
      assert.equal(root.querySelector("input").value, "Manual edit");
    } finally {
      w.dispatchEvent(new w.Event("pagehide"));
      w.close();
    }
  }
});
