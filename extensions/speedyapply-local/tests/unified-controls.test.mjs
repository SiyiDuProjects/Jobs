import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const files = [
  "dom-wait",
  "option-match",
  "profile-answers",
  "control-fields",
  "workday-controls",
  "ashby-controls",
  "greenhouse-controls",
  "review-presenter",
  "ai-review",
  "operation-context",
  "automatic-fill",
  "control-content",
];
const modules = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ]),
  ),
);
function fixture(entry = "reader") {
  const dom = new JSDOM(
    '<main data-automation-id="applyFlowPage"><div id="field" data-automation-id="formField-fieldOfStudy"><label for="major">Field of Study*</label><div data-automation-id="multiSelectContainer"><input id="major" aria-required="true" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="study"><ul data-automation-id="selectedItemList"></ul></div></div></main><button id="next" data-automation-id="pageFooterNextButton">Next</button>',
    {
      url: "https://fixture.myworkdayjobs.com/en-US/External/job/US/Physics-Researcher_R123/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    input = doc.querySelector("input"),
    root = doc.querySelector("main"),
    trace = [],
    events = [],
    listeners = [];
  const profile = {
    profileName: "Fixture",
    educationData: [{ fieldOfStudy: "Physics" }],
  };
  let navigations = 0,
    calls = 0;
  w.JobsControlConfig = { enabled: entry === "remote", observe: true };
  w.JobsDiagnostics = {
    note: (...args) => events.push(args),
    start() {},
    beginRun() {},
    finishRun() {},
    stop() {},
    phase() {},
    useReader() {},
    recentEvents: () => [],
  };
  w.chrome = {
    runtime: {
      id: "test",
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          calls++;
          assert.equal(message.fields.length, 1);
          assert.equal(
            message.fields[0].type,
            "combobox",
            "wire contract stays compatible with the deployed answer service",
          );
          assert(
            message.fields[0].options.some(
              (option) => option.value === "Physics",
            ),
          );
          return {
            data: {
              answers: [
                {
                  fieldId: message.fields[0].fieldId,
                  state: "answer",
                  value: "Physics",
                  source: "profile",
                  needsConfirmation: false,
                },
              ],
            },
          };
        }
        return {};
      },
    },
  };
  for (const name of [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "workday-controls",
  ])
    w.eval(modules[name]);
  // Both public entrances (exact value and semantic spec) end in the one
  // single-search writer; each entrance is entered exactly once.
  const original = w.JobsWorkdayControls;
  w.JobsWorkdayControls = {
    ...original,
    chooseFrom: async (...args) => {
      trace.push("writer");
      return original.chooseFrom(...args);
    },
  };
  const close = () => doc.querySelector("[data-uxi-popup-anchor]")?.remove();
  const popup = () => {
    let box = doc.querySelector("[data-uxi-popup-anchor]");
    if (!box) {
      box = doc.createElement("div");
      box.setAttribute("data-uxi-popup-anchor", "study");
      box.setAttribute("data-uxi-multiselectlist-issearch", "false");
      doc.body.append(box);
    }
    return box;
  };
  input.onclick = () => {
    popup();
  };
  input.onkeydown = (event) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Enter") return;
    trace.push("enter");
    const box = popup();
    box.setAttribute("data-uxi-multiselectlist-issearch", "true");
    box.replaceChildren();
    for (const label of ["Applied Physics", "Physics"]) {
      const option = doc.createElement("div");
      option.setAttribute("role", "option");
      option.innerHTML =
        '<input type="checkbox"><span data-automation-id="promptOption"></span>';
      option.lastElementChild.textContent = label;
      option.firstElementChild.onclick = () => {
        trace.push(label);
        doc.querySelector("ul").innerHTML =
          '<li data-automation-id="selectedItem"><span data-automation-id="promptOption">' +
          label +
          "</span></li>";
        input.value = "";
        close();
      };
      box.append(option);
    }
  };
  doc.querySelector("#next").onclick = () => navigations++;
  const reader = w.JobsControlFields.create(doc, () => root, { write: true });
  const dispatch = (message) =>
    new Promise((resolve) => {
      for (const listener of listeners) {
        if (listener(message, { id: "test" }, resolve) === true) return;
      }
    });
  const inspect = () => {
    let result;
    for (const listener of listeners)
      listener(
        { type: "jobs:control-inspect" },
        { id: "test" },
        (value) => (result = value),
      );
    assert(!result?.error, result?.error);
    return result.data;
  };
  return {
    w,
    doc,
    input,
    root,
    reader,
    trace,
    events,
    profile,
    dispatch,
    inspect,
    calls: () => calls,
    navigations: () => navigations,
    close: () => w.close(),
  };
}

for (const entry of ["binding", "reader", "ai", "remote"])
  test(`Workday search through ${entry} uses the same writer, Enter and committed-pill reader`, async () => {
    const h = fixture(entry),
      { w, reader } = h;
    try {
      const initial = reader.scan()[0].public;
      assert.equal(initial.supported, true);
      assert.equal(initial.component, "workday-prompt");
      assert.equal(initial.type, "search-choice");
      assert.equal(initial.completion, "required-empty");
      if (entry === "binding") {
        assert(
          (
            await w.JobsFormPipeline.bind([
              {
                name: "major",
                find: "#major",
                answer: w.JobsProfileAnswers.literalSpec(
                  "known-answer",
                  "Physics",
                ),
              },
            ])
          )[0],
        );
      } else if (entry === "reader")
        await reader.apply(reader.scan()[0], "Physics");
      else if (entry === "ai") {
        for (const name of [
          "review-presenter",
          "ai-review",
          "operation-context",
          "automatic-fill",
        ])
          w.eval(modules[name]);
        // The rules name Physics but could not commit it; AI picks from the
        // candidates that decision's search finds.
        const resolveAnswers = async (fields, profile, { onDecision }) => {
          onDecision({
            index: 0,
            status: "needs-input",
            answer: null,
            source: "profile",
            reason: "option_not_matched",
            profileAnswer: { answer: "Physics" },
          });
          return [];
        };
        assert.equal(
          await w.JobsAutomatic.advance({
            root: h.root,
            profile: h.profile,
            action: "fill",
            resolveAnswers,
          }),
          true,
        );
        assert.equal(h.calls(), 1);
      } else {
        w.eval(modules["operation-context"]);
        w.eval(modules["control-content"]);
        await w.JobsPageSession.run(
          async (options) => {
            await options.getProfile();
            options.setMessage("autofill-complete");
          },
          {
            jobsAdapterId: "workday",
            getProfile: async () => h.profile,
            setMessage() {},
          },
        );
        const page = h.inspect();
        assert(page.actions.includes("fill_answers"));
        // Public protocol remains exact; component details travel in diagnostics.
        assert.deepEqual(
          Object.keys(page.fields[0]).sort(),
          [
            "filled",
            "id",
            "invalid",
            "question",
            "required",
            "supported",
            "type",
            "value",
          ].sort(),
        );
        const result = await h.dispatch({
          type: "jobs:control-execute",
          command: {
            id: "fill",
            target: { documentId: page.documentId, revision: page.revision },
            expiresAt: Date.now() + 10000,
            action: "fill_answers",
            args: {
              answers: [{ fieldId: page.fields[0].id, value: "Physics" }],
            },
          },
        });
        assert.equal(result.data.appliedFieldIds.length, 1);
        assert.equal(result.data.failedFieldIds.length, 0);
      }
      assert.equal(h.trace.filter((item) => item === "writer").length, 1);
      assert(h.trace.indexOf("enter") < h.trace.indexOf("Physics"));
      assert(!h.trace.includes("Applied Physics"));
      assert.equal(reader.response(reader.scan()[0]).response, "Physics");
      assert.equal(reader.state().ready, true);
      assert.equal(h.navigations(), 0);
    } finally {
      h.close();
    }
  });

test("requiredness and writing capability are separate completion decisions", () => {
  const h = fixture();
  try {
    h.root.innerHTML =
      '<div role="combobox" aria-label="Optional custom" aria-required="false"></div><div role="combobox" aria-label="Required custom" aria-required="true"></div>';
    const rows = h.reader.scan();
    assert.equal(rows[0].public.supported, false);
    assert.equal(rows[0].public.completion, "optional-empty");
    assert.equal(h.reader.state().blockers.length, 1);
    assert.equal(h.reader.state().blockers[0].reason, "required-empty");
    rows[1].node.setAttribute("aria-required", "false");
    assert.equal(h.reader.state().ready, true);
    rows[0].node.setAttribute("aria-invalid", "true");
    assert.equal(h.reader.state().ready, false);
    assert.equal(h.reader.state().blockers[0].reason, "invalid");
  } finally {
    h.close();
  }
});

test("a stale row cannot overwrite a value filled by the website after inspection", async () => {
  const h = fixture();
  try {
    h.root.innerHTML = "<label>Name<input></label>";
    const row = h.reader.scan()[0];
    row.node.value = "User answer";
    await assert.rejects(h.reader.apply(row, "Stale answer"), /editable empty/);
    assert.equal(row.node.value, "User answer");
  } finally {
    h.close();
  }
});

test("bindings for text, a choice and a check use the same primitives as supplemental fields", async () => {
  const h = fixture();
  try {
    h.root.innerHTML =
      '<label>Name<input id="text"></label><label>Choice<select id="choice"><option value="">Choose</option><option value="a">Alpha</option></select></label><label>Consent<input id="check" type="checkbox"></label>';
    // Each binding's write is recorded once by the field's one setter.
    const calls = [];
    h.w.JobsDiagnostics.trace = (node, entry) => {
      if (entry.result === "committed" && entry.source?.startsWith("binding:"))
        calls.push(entry.source + ":" + node.id);
    };
    await h.w.JobsFormPipeline.bind([
      { name: "text", find: "#text", answer: "Fixture" },
      {
        name: "choice",
        find: "#choice",
        answer: h.w.JobsProfileAnswers.literalSpec("known-answer", "Alpha"),
      },
      { name: "check", find: "#check", checked: true },
    ]);
    assert.deepEqual(calls, [
      "binding:text:text",
      "binding:choice:choice",
      "binding:check:check",
    ]);
    assert.equal(h.doc.querySelector("#text").value, "Fixture");
    assert.equal(h.doc.querySelector("#choice").value, "a");
    assert.equal(h.doc.querySelector("#check").checked, true);
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("component matching is reusable across ATS hosts but does not start an application", () => {
  const dom = new JSDOM(
    '<div class="select"><label for="value">Choice</label><div class="select__single-value">Selected</div><input id="value" class="select__input" role="combobox" aria-required="false"></div>',
    { url: "https://another-ats.example/form", runScripts: "outside-only" },
  );
  try {
    for (const name of ["control-fields", "greenhouse-controls"])
      dom.window.eval(modules[name]);
    const row = dom.window.JobsControlFields.create(
      dom.window.document,
    ).scan()[0];
    assert.equal(row.public.component, "react-select");
    assert.equal(row.raw, "Selected");
    assert.equal(dom.window.JobsPageSession, undefined);
  } finally {
    dom.window.close();
  }
});

for (const needsConfirmation of [false, true])
  test(`a page-control navigation request joins the pending AI pass (confirmation=${needsConfirmation})`, async () => {
    const h = fixture();
    let release,
      requests = 0;
    const phases = [];
    try {
      h.root.innerHTML =
        "<label>Motivation*<textarea required></textarea></label>";
      h.w.chrome.runtime.sendMessage = async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile: h.profile } };
        if (message.type !== "jobs:auto-answers") return {};
        requests++;
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          data: {
            answers: [
              {
                fieldId: message.fields[0].fieldId,
                state: "answer",
                value: "Grounded fixture answer",
                source: "profile",
                needsConfirmation,
              },
            ],
          },
        };
      };
      for (const name of [
        "review-presenter",
        "ai-review",
        "operation-context",
        "automatic-fill",
        "control-content",
      ])
        h.w.eval(modules[name]);
      const node = h.doc.querySelector("#next");
      await h.w.JobsPageSession.run(
        async (options) => {
          const profile = await options.getProfile();
          void h.w.JobsAutomatic.advance({
            profile,
            action: "fill",
            setMessage: options.setMessage,
          });
        },
        {
          jobsAdapterId: "workday",
          getProfile: async () => h.profile,
          setMessage: (phase) => phases.push(phase),
        },
      );
      for (let i = 0; i < 100 && !release; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(release);
      const request = h.w.JobsPageSession.advance(node, "next");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(h.navigations(), 0);
      release();
      await request;
      assert.equal(requests, 1, "no parallel AI request");
      if (needsConfirmation) {
        assert.equal(h.navigations(), 0);
        assert(h.w.JobsAIReview.pending());
        await h.w.JobsAIReview.confirm();
      }
      assert.equal(h.navigations(), 1);
      assert.equal(
        h.doc.querySelector("textarea").value,
        "Grounded fixture answer",
      );
    } finally {
      h.close();
    }
  });

test("remote continuation uses the same validation barrier and refuses page-level errors", async () => {
  const h = fixture("remote");
  try {
    h.root.innerHTML =
      '<label>Name<input value="Fixture"></label><div class="error-message">Fix this application</div><button data-automation-id="pageFooterNextButton">Next</button>';
    h.doc.querySelector("#next").remove();
    h.w.eval(modules["operation-context"]);
    h.w.eval(modules["control-content"]);
    await h.w.JobsPageSession.run(
      async (options) => {
        await options.getProfile();
        options.setMessage("autofill-complete");
      },
      {
        jobsAdapterId: "workday",
        getProfile: async () => h.profile,
        setMessage() {},
      },
    );
    assert.equal(h.reader.scan()[0].public.filled, true);
    assert(!h.inspect().actions.includes("next"));
    h.root.querySelector(".error-message").remove();
    assert(h.inspect().actions.includes("next"));
  } finally {
    h.close();
  }
});

test("an unsupported optional control stays empty and does not prevent navigation or request AI", async () => {
  const h = fixture();
  try {
    h.root.innerHTML =
      '<div role="combobox" aria-label="Optional survey" aria-required="false"></div><label>Cover letter<input type="file"></label>';
    for (const name of [
      "review-presenter",
      "ai-review",
      "operation-context",
      "automatic-fill",
      "control-content",
    ])
      h.w.eval(modules[name]);
    await h.w.JobsPageSession.run(
      async (options) => {
        await options.getProfile();
        options.setMessage("autofill-complete");
      },
      {
        jobsAdapterId: "workday",
        getProfile: async () => h.profile,
        setMessage() {},
      },
    );
    assert.equal(
      h.reader.scan().every((row) => !row.public.supported),
      true,
    );
    await h.w.JobsPageSession.advance(h.doc.querySelector("#next"), "next");
    assert.equal(h.navigations(), 1);
    assert.equal(h.calls(), 0);
    assert.equal(h.w.JobsAIReview.pending(), false);
  } finally {
    h.close();
  }
});

test("a Workday list the adapter names is read without formField wrappers or initial ARIA popup attributes", async () => {
  const h = fixture();
  try {
    h.root.innerHTML =
      '<label id="label">Country</label><button type="button" id="legacy" aria-labelledby="label">Select One</button>';
    const button = h.doc.querySelector("#legacy");
    button.onclick = () => {
      button.setAttribute("aria-controls", "list");
      h.doc.body.insertAdjacentHTML(
        "beforeend",
        '<ul role="listbox" id="list"><li role="option">United States</li></ul>',
      );
      h.doc.querySelector('[role="option"]').onclick = () => {
        button.textContent = "United States";
        h.doc.querySelector("#list").remove();
      };
    };
    assert(
      (
        await h.w.JobsFormPipeline.bind([
          {
            name: "country",
            find: () => h.w.JobsWorkdayControls.listbox(button),
            answer: h.w.JobsProfileAnswers.countrySpec("United States"),
          },
        ])
      )[0],
    );
    const row = h.reader.scan()[0];
    assert.equal(row.public.component, "workday-listbox");
    assert.equal(h.reader.response(row).response, "United States");
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("a Workday degree list also refuses to invent a subtype", async () => {
  const h = fixture();
  try {
    h.root.innerHTML =
      '<label id="label">Degree</label><button type="button" id="legacy" aria-labelledby="label">Select One</button>';
    const button = h.doc.querySelector("#legacy");
    button.onclick = () => {
      button.setAttribute("aria-controls", "list");
      h.doc.body.insertAdjacentHTML(
        "beforeend",
        '<ul role="listbox" id="list"><li role="option">Bachelor of Arts</li><li role="option">Bachelor of Science</li></ul>',
      );
      for (const option of h.doc.querySelectorAll('#list [role="option"]'))
        option.onclick = () => {
          button.textContent = option.textContent;
          h.doc.querySelector("#list").remove();
        };
    };
    const degree = (answer) =>
      h.w.JobsFormPipeline.bind([
        {
          name: "degree",
          find: () => h.w.JobsWorkdayControls.listbox(button),
          answer: h.w.JobsProfileAnswers.degreeSpec(answer),
        },
      ]).then((results) => results[0]);
    assert.equal(await degree("Bachelor"), null);
    assert.equal(button.textContent, "Select One");
    assert(await degree("Bachelor of Arts"));
    assert.equal(button.textContent, "Bachelor of Arts");
  } finally {
    h.close();
  }
});
