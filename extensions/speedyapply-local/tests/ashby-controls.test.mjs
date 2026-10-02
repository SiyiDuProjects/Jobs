import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readModule } from "./helpers/module-source.mjs";
import { runAnswerStage } from "./helpers/answer-stage.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "https://jobs.ashbyhq.com/test",
  runScripts: "outside-only",
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const h = React.createElement;
const source = await readModule(
  new URL("../source/content/adapters/ashby.js", import.meta.url),
  "utf8",
);
window.eval(
  await readWithDependencies(
    new URL("../src/custom/dom-wait.js", import.meta.url),
    "utf8",
  ),
);
window.eval(
  await readWithDependencies(
    new URL("../src/custom/control-fields.js", import.meta.url),
    "utf8",
  ),
);
window.eval(
  await Promise.all(
    ["option-match", "profile-answers"].map((n) =>
      readWithDependencies(
        new URL("../src/custom/" + n + ".js", import.meta.url),
        "utf8",
      ),
    ),
  ).then((parts) => parts.join("\n")),
);
window.eval(
  await readWithDependencies(
    new URL("../src/custom/ashby-controls.js", import.meta.url),
    "utf8",
  ),
);
window.eval(
  await readWithDependencies(
    new URL("../src/custom/form-pipeline.js", import.meta.url),
    "utf8",
  ),
);
const controls = window.JobsAshbyControls;
// Run the maintained resolver, with only its storage boundary replaced.
window.eval(
  resolverWith("window.testResponses || []") +
    "\nwindow.resolveProfile = (questions, profile, options) => JobsAnswerResolver.resolve(questions, profile, options);",
);
const profile = (eligibilityUS, sponsorship) => ({
  addressData: { country: "United States" },
  employmentData: { eligibilityUS, sponsorship },
  websiteData: {},
  nameData: { firstName: "", lastName: "" },
});
const authorization =
  "Are you legally authorized to work in the United States for any employer?";
const sponsorship =
  "Will you now or will you in the future require employment visa sponsorship?";
const referral = "How did you hear about Gecko?";
const questions = [authorization, sponsorship, referral];

test("the same Ashby controls translate each Profile into year, numeric month, date and exact range options", async () => {
  for (const [date, month] of [
    ["2027-05", "05"],
    ["2027-12", "12"],
  ]) {
    document.getElementById("root").innerHTML =
      '<fieldset><label class="ashby-application-form-question-title">Graduation year</label><input type="number"></fieldset>' +
      '<fieldset><label class="ashby-application-form-question-title">Graduation month</label><select><option value="">Choose</option><option value="05">May</option><option value="12">Dec</option></select></fieldset>' +
      '<fieldset><label class="ashby-application-form-question-title">Graduation date</label><input type="month"></fieldset>';
    const current = {
      ...profile(true, true),
      educationData: [{ endDate: date }],
    };
    await runAnswerStage(window, {
      root: document.getElementById("root"),
      profile: current,
      resolveAnswers: window.resolveProfile,
    });
    assert.equal(document.querySelector('input[type="number"]').value, "2027");
    assert.equal(document.querySelector("select").value, month);
    assert.equal(document.querySelector('input[type="month"]').value, date);
  }
  document.getElementById("root").innerHTML = "";
});

function Radios({ question, options = ["Yes", "No"] }) {
  const [value, setValue] = React.useState(null);
  const name = React.useId();
  return h(
    "fieldset",
    { className: "ashby-application-form-input-radio-group" },
    h(
      "label",
      { className: "ashby-application-form-question-title" },
      question,
    ),
    options.map((answer, index) =>
      h(
        "div",
        { key: answer },
        h(
          "span",
          null,
          h("input", {
            type: "radio",
            name,
            id: `${name}-${index}`,
            checked: value === answer,
            onChange: () => flushSync(() => setValue(answer)),
          }),
        ),
        h("label", { htmlFor: `${name}-${index}` }, answer),
      ),
    ),
    h("output", null, value ?? "unanswered"),
  );
}

function YesNo({ question }) {
  const [value, setValue] = React.useState(null);
  return h(
    "div",
    { className: "ashby-application-form-field-entry" },
    h(
      "label",
      { className: "ashby-application-form-question-title" },
      question,
    ),
    h(
      "div",
      { className: "ashby-application-form-input-yesno" },
      ["Yes", "No"].map((answer) =>
        h(
          "button",
          {
            key: answer,
            type: "button",
            "data-option": answer.toLowerCase(),
            "aria-pressed": value === answer,
            onClick: () => flushSync(() => setValue(answer)),
          },
          answer,
        ),
      ),
    ),
    h("output", null, value ?? "unanswered"),
  );
}
function Dropdown({
  initial = "",
  options = ["Friend or Referral", "LinkedIn Jobs"],
}) {
  const [value, setValue] = React.useState(initial);
  const [open, setOpen] = React.useState(false);
  const [committed, setCommitted] = React.useState(initial);
  return h(
    "fieldset",
    null,
    h(
      "label",
      { className: "ashby-application-form-question-title" },
      referral,
    ),
    h(
      "div",
      null,
      h("input", {
        role: "combobox",
        value,
        "aria-expanded": open,
        "aria-controls": open ? "referral-options" : undefined,
        onChange: (e) => setValue(e.target.value),
      }),
      h(
        "button",
        { type: "button", onClick: () => flushSync(() => setOpen(!open)) },
        "Toggle",
      ),
    ),
    open &&
      h(
        "div",
        { role: "listbox", id: "referral-options" },
        options.map((answer) =>
          h(
            "div",
            {
              key: answer,
              role: "option",
              "aria-selected": committed === answer,
              onClick: () =>
                flushSync(() => {
                  setValue(answer);
                  setCommitted(answer);
                  setOpen(false);
                }),
            },
            answer,
          ),
        ),
      ),
    h("output", null, committed || "unanswered"),
  );
}
async function fixture(element, run) {
  const root = createRoot(document.getElementById("root"));
  window.testResponses = [];
  try {
    await act(() => root.render(element));
    await run(document.getElementById("root"));
  } finally {
    await act(() => root.unmount());
  }
}

function SearchSchool({
  searches,
  ignoreClick = false,
  queryWithoutList = false,
  rich = false,
}) {
  const [value, setValue] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [committed, setCommitted] = React.useState("");
  const label = "Fixture University, Harbor Campus";
  const ready = value === "Harbor";
  return h(
    "fieldset",
    null,
    h(
      "label",
      { className: "ashby-application-form-question-title" },
      "School",
    ),
    h(
      "div",
      null,
      h("input", {
        role: "combobox",
        value,
        "aria-expanded": open,
        "aria-controls":
          open && (!queryWithoutList || ready) ? "school-options" : undefined,
        onChange: (e) => {
          searches.push(e.target.value);
          setValue(e.target.value);
        },
      }),
      h(
        "button",
        { type: "button", onClick: () => flushSync(() => setOpen(!open)) },
        "Toggle",
      ),
    ),
    open &&
      (!queryWithoutList || ready) &&
      h(
        "div",
        { id: "school-options", role: "listbox" },
        ready &&
          h(
            "div",
            {
              role: "option",
              onClick: () => {
                if (!ignoreClick)
                  flushSync(() => {
                    setValue(label);
                    setCommitted(label);
                    setOpen(false);
                  });
              },
            },
            rich
              ? h(
                  "div",
                  null,
                  h(
                    "div",
                    null,
                    h(
                      "span",
                      { className: "_canonicalSchoolResultName_fixture_205" },
                      label,
                    ),
                    h(
                      "span",
                      {
                        className: "_canonicalSchoolResultCountry_fixture_209",
                      },
                      "United States",
                    ),
                  ),
                  h(
                    "span",
                    { className: "_canonicalSchoolResultDomain_fixture_218" },
                    "fixture.example",
                  ),
                )
              : label,
          ),
      ),
    h("output", null, committed || "unanswered"),
  );
}

test("Ashby school searches each supplied term, then commits the exact option in React", async () => {
  const searches = [];
  await fixture(
    h(SearchSchool, { searches, queryWithoutList: true }),
    async (root) => {
      const input = root.querySelector("input");
      const spec = {
        tiers: [["Fixture University, Harbor Campus"]],
        queries: ["Fixture University", "Harbor"],
        topic: "school",
      };
      let result;
      await act(async () => {
        result = await window.JobsControlFields.chooseSpec(input, spec);
      });
      assert.ok(result);
      assert.equal(
        root.querySelector("output").textContent,
        "Fixture University, Harbor Campus",
      );
      assert.deepEqual(searches.filter(Boolean), [
        "Fixture University",
        "Harbor",
      ]);
      assert.equal(input.getAttribute("aria-expanded"), "false");
    },
  );
});

test("Ashby school option inspection searches but never commits or leaves query text", async () => {
  const searches = [];
  await fixture(h(SearchSchool, { searches, rich: true }), async (root) => {
    const input = root.querySelector("input");
    let options;
    await act(async () => {
      options = await controls.readOptions(input, () => true, {
        answer: "Harbor",
      });
    });
    assert.equal(options[0]?.label, "Fixture University, Harbor Campus");
    assert.equal(root.querySelector("output").textContent, "unanswered");
    assert.equal(input.value, "");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(searches.filter(Boolean), ["Harbor"]);
  });
});

test("canonical Ashby school result matches and commits its name without country or domain", async () => {
  const searches = [];
  await fixture(h(SearchSchool, { searches, rich: true }), async (root) => {
    const input = root.querySelector("input");
    const spec = window.JobsProfileAnswers.schoolSpec(
      "Fixture University, Harbor Campus",
    );
    spec.queries = ["Harbor"];
    let result;
    await act(async () => {
      result = await window.JobsControlFields.chooseSpec(input, spec);
    });
    assert.ok(result);
    assert.equal(input.value, "Fixture University, Harbor Campus");
    assert.equal(root.querySelector("output").textContent, input.value);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.deepEqual(searches.filter(Boolean), ["Harbor"]);
  });
});

test("Ashby school ignored choice clears its search and remains unanswered", async () => {
  const searches = [];
  await fixture(
    h(SearchSchool, { searches, ignoreClick: true }),
    async (root) => {
      const input = root.querySelector("input");
      let result;
      await act(async () => {
        result = await window.JobsControlFields.chooseSpec(input, {
          tiers: [["Fixture University, Harbor Campus"]],
          queries: ["Harbor"],
        });
      });
      assert.equal(result, null);
      assert.equal(input.value, "");
      assert.equal(root.querySelector("output").textContent, "unanswered");
      assert.equal(input.getAttribute("aria-expanded"), "false");
    },
  );
});
test("native setter updates real React state: direct value + input reproduces the empty-state bug", async () => {
  function Form() {
    const [value, setValue] = React.useState("");
    const [blurred, setBlurred] = React.useState(false);
    return h(
      "div",
      null,
      h("input", {
        "aria-label": "First Name",
        value,
        onChange: (e) => setValue(e.target.value),
        onBlur: () => setBlurred(true),
      }),
      h("output", null, JSON.stringify({ value, blurred })),
    );
  }
  await fixture(h(Form), async (root) => {
    const input = root.querySelector("input");
    await act(() => {
      input.value = "Example";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(
      JSON.parse(root.querySelector("output").textContent).value,
      "",
    );
  });
  await fixture(h(Form), async (root) => {
    await act(() => chooseAnswer(root.querySelector("input"), "Example"));
    assert.deepEqual(JSON.parse(root.querySelector("output").textContent), {
      value: "Example",
      blurred: true,
    });
  });
});

test("native Generate Answer button commits controlled textareas and preserves text on provider failure", async () => {
  function Form() {
    const [value, setValue] = React.useState("Previous text");
    return h(
      "div",
      null,
      h(
        "label",
        null,
        "Which languages?",
        h("textarea", { value, onChange: (e) => setValue(e.target.value) }),
      ),
      h("output", null, value),
    );
  }
  for (const successful of [true, false])
    await fixture(h(Form), async (root) => {
      let listener;
      const port = {
        onMessage: { addListener: (fn) => (listener = fn) },
        onDisconnect: { addListener() {} },
        postMessage() {},
        disconnect() {},
      };
      window.chrome = { runtime: { connect: () => port } };
      window.eval(
        await readWithDependencies(
          new URL("../src/custom/manual-answer.js", import.meta.url),
          "utf8",
        ),
      );
      window.jobsFindAllXPath = () => [root.querySelector("textarea")];
      window.jobsFindXPath = () => root.querySelector("label");
      window.eval(
        await readModule(
          new URL("../source/content/shared/answer-ui.js", import.meta.url),
          "utf8",
        ),
      );
      await window.jobsMountManualAnswerControls({}, [
        ["//textarea", "../label"],
      ]);
      await act(() => root.querySelector("button").click());
      if (successful) {
        await act(() =>
          listener({ type: "STREAM_UPDATE", text: "I use Python and SQL." }),
        );
        await act(() => listener({ type: "STREAM_END", responseId: "test" }));
        assert.equal(
          root.querySelector("output").textContent,
          "I use Python and SQL.",
        );
      } else {
        await act(() =>
          listener({
            type: "STREAM_ERROR",
            error: "需要你确认：work authorization",
          }),
        );
        assert.equal(root.querySelector("textarea").value, "Previous text");
        assert.equal(root.querySelector("output").textContent, "Previous text");
        assert.match(
          root.querySelector('[role="status"]').textContent,
          /需要你确认/,
        );
      }
    });
});

test("opposite selected profiles produce opposite Yes/No answers via the upstream resolver", async () => {
  for (const values of [
    [true, false],
    [false, true],
  ])
    await fixture(
      h(
        "div",
        null,
        h(YesNo, { question: authorization }),
        h(YesNo, { question: sponsorship }),
      ),
      async (root) => {
        await act(() =>
          runAnswerStage(window, {
            root: root,
            profile: profile(...values),
            resolveAnswers: window.resolveProfile,
          }),
        );
        assert.deepEqual(
          Array.from(root.querySelectorAll("output"), (e) => e.textContent),
          values.map((v) => (v ? "Yes" : "No")),
        );
      },
    );
});
test("Saved Response clicks the complete dropdown option and commits React state", async () => {
  await fixture(h(Dropdown), async (root) => {
    let opens = 0;
    root.querySelector("button").addEventListener("click", () => opens++);
    window.testResponses = [
      {
        question: referral,
        keywords: ["hear about"],
        appearances: 1,
        response: "Friend or Referral",
      },
    ];
    await act(() =>
      runAnswerStage(window, {
        root: root,
        profile: profile(),
        resolveAnswers: window.resolveProfile,
      }),
    );
    assert.equal(
      root.querySelector("output").textContent,
      "Friend or Referral",
    );
    assert.equal(opens, 1, "one open for the entire rule transaction");
    assert.equal(
      root.querySelector("input").getAttribute("aria-expanded"),
      "false",
    );
  });
});
test("unknown profile / source answers remain unanswered and do not open dropdown", async () => {
  await fixture(
    h("div", null, h(YesNo, { question: authorization }), h(Dropdown)),
    async (root) => {
      await act(() =>
        runAnswerStage(window, {
          root: root,
          profile: profile(),
          resolveAnswers: window.resolveProfile,
        }),
      );
      assert.deepEqual(
        Array.from(root.querySelectorAll("output"), (e) => e.textContent),
        ["unanswered", "unanswered"],
      );
      assert.equal(root.querySelector('[role="listbox"]'), null);
    },
  );
});
test("partial or loosely similar Saved Response never selects a different answer", async () => {
  await fixture(h(Dropdown), async (root) => {
    window.testResponses = [
      {
        question: referral,
        keywords: ["hear about"],
        appearances: 1,
        response: "Friend",
      },
    ];
    await act(() =>
      runAnswerStage(window, {
        root: root,
        profile: profile(),
        resolveAnswers: window.resolveProfile,
      }),
    );
    assert.equal(root.querySelector("output").textContent, "unanswered");
    assert.equal(root.querySelector("input").value, "");
    assert.equal(root.querySelector('[role="listbox"]'), null);
  });
});
test("preserves already selected buttons, dropdowns and typed text", async () => {
  await fixture(
    h(
      "div",
      null,
      h(YesNo, { question: authorization }),
      h(Dropdown, { initial: "LinkedIn Jobs" }),
      h("input", { defaultValue: "User text" }),
    ),
    async (root) => {
      await act(() => root.querySelector('[data-option="no"]').click());
      window.testResponses = [
        {
          question: referral,
          keywords: ["hear about"],
          appearances: 1,
          response: "Friend or Referral",
        },
      ];
      await act(() =>
        runAnswerStage(window, {
          root: root,
          profile: profile(true),
          resolveAnswers: window.resolveProfile,
        }),
      );
      assert.deepEqual(
        Array.from(root.querySelectorAll("output"), (e) => e.textContent),
        ["No", "LinkedIn Jobs"],
      );
      const input = root.querySelector("input:not([role])");
      assert.equal(await chooseAnswer(input, "Replacement"), null);
      assert.equal(input.value, "User text");
    },
  );
});
test("does not change disabled or readonly fields, and does not stringify missing values", async () => {
  await fixture(
    h(
      "div",
      null,
      h("input", { disabled: true }),
      h("input", { readOnly: true }),
      h("input"),
    ),
    async (root) => {
      const inputs = root.querySelectorAll("input");
      assert.equal(await chooseAnswer(inputs[0], "Example"), null);
      assert.equal(await chooseAnswer(inputs[1], "Example"), null);
      assert.equal(await chooseAnswer(inputs[2], undefined), null);
      assert.ok(Array.from(inputs).every((input) => input.value === ""));
    },
  );
});
test("only the combobox-owned listbox is eligible; never a stray matching popup or submit", async () => {
  await fixture(
    h(
      "div",
      null,
      h(Dropdown, { options: ["Other"] }),
      h(
        "div",
        { role: "listbox", id: "unrelated" },
        h("div", { role: "option" }, "Friend or Referral"),
      ),
      h("button", { type: "submit" }, "Submit Application"),
    ),
    async (root) => {
      let submits = 0;
      root
        .querySelector('[type="submit"]')
        .addEventListener("click", () => submits++);
      window.testResponses = [
        {
          question: referral,
          keywords: ["hear about"],
          appearances: 1,
          response: "Friend or Referral",
        },
      ];
      await act(() =>
        runAnswerStage(window, {
          root: root,
          profile: profile(),
          resolveAnswers: window.resolveProfile,
        }),
      );
      assert.equal(root.querySelector("output").textContent, "unanswered");
      assert.equal(submits, 0);
    },
  );
});
test("ordinary radio group commits React state and preserves an existing selection", async () => {
  await fixture(h(Radios, { question: authorization }), async (root) => {
    await act(() =>
      runAnswerStage(window, {
        root: root,
        profile: profile(true),
        resolveAnswers: window.resolveProfile,
      }),
    );
    assert.equal(root.querySelector("output").textContent, "Yes");
    await act(() =>
      runAnswerStage(window, {
        root: root,
        profile: profile(false),
        resolveAnswers: window.resolveProfile,
      }),
    );
    assert.equal(root.querySelector("output").textContent, "Yes");
  });
});
test("saved Yes selects the unique long Yes option; multiple Yes variants remain unanswered", async () => {
  for (const [options, expected] of [
    [
      [
        "Yes, I am able and willing to work in the office.",
        "No, I am unable to work in the office.",
      ],
      "Yes, I am able and willing to work in the office.",
    ],
    [
      [
        "Yes - previous intern",
        "Yes - previous employee",
        "No - never worked here",
      ],
      "unanswered",
    ],
  ])
    await fixture(
      h(Radios, { question: "Office willingness", options }),
      async (root) => {
        window.testResponses = [
          {
            question: "Office willingness",
            keywords: ["office"],
            appearances: 1,
            response: "Yes",
          },
        ];
        await act(() =>
          runAnswerStage(window, {
            root: root,
            profile: profile(),
            resolveAnswers: window.resolveProfile,
          }),
        );
        assert.equal(root.querySelector("output").textContent, expected);
      },
    );
});
test("US profile does not answer Canadian eligibility or its adjacent sponsorship question", async () => {
  const canada =
    "Are you currently authorized to work for any employer in Canada?";
  await fixture(
    h(
      "div",
      null,
      h(Radios, { question: canada }),
      h(Radios, { question: sponsorship }),
    ),
    async (root) => {
      await act(() =>
        runAnswerStage(window, {
          root: root,
          profile: profile(true, false),
          resolveAnswers: window.resolveProfile,
        }),
      );
      assert.deepEqual(
        Array.from(root.querySelectorAll("output"), (e) => e.textContent),
        ["unanswered", "unanswered"],
      );
    },
  );
});
test("explicit Canada Saved Response answers only its question; missing country stays unresolved", async () => {
  window.testResponses = [
    {
      keywords: ["authorized to work", "Canada"],
      appearances: 2,
      response: "No",
    },
  ];
  const result = await window.resolveProfile(
    [
      { question: "Are you authorized to work in Canada?" },
      { question: sponsorship },
    ],
    profile(true, false),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].index, 0);
  assert.equal(result[0].answer, "No");
  window.testResponses = [];
  assert.equal(
    (
      await window.resolveProfile(
        [{ question: "Are you authorized to work in France?" }],
        profile(true),
      )
    ).length,
    0,
  );
});

test("already-filled Canadian authorization still supplies country context to an empty sponsorship question", async () => {
  const root = document.getElementById("root");
  root.innerHTML =
    '<fieldset><label class="ashby-application-form-question-title">Are you currently authorized to work for any employer in Canada?</label><select><option value="no" selected>No</option></select></fieldset>' +
    '<fieldset><label class="ashby-application-form-question-title">' +
    sponsorship +
    '</label><select><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select></fieldset>';
  window.testResponses = [];
  try {
    await runAnswerStage(window, {
      root: root,
      profile: profile(false, true),
      resolveAnswers: window.resolveProfile,
    });
    assert.deepEqual(
      [...root.querySelectorAll("select")].map((node) => node.value),
      ["no", ""],
    );
  } finally {
    root.replaceChildren();
  }
});
