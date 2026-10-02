import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readModule } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const dom = new JSDOM('<div id="root"></div>', {
    url: "https://job-boards.greenhouse.io/embed/job_app?for=fixture",
    runScripts: "outside-only",
  }),
  w = dom.window;
Object.assign(globalThis, {
  window: w,
  document: w.document,
  HTMLElement: w.HTMLElement,
});
const React = await import("react"),
  { createRoot } = await import("react-dom/client"),
  { flushSync, createPortal } = await import("react-dom");
for (const name of [
  "option-match",
  "profile-answers",
  "dom-wait",
  "control-fields",
  "workday-controls",
  "greenhouse-controls",
])
  w.eval(
    await readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  );
const source = await readModule(
  new URL("../source/content/adapters/greenhouse.js", import.meta.url),
  "utf8",
);
w.J = (path) =>
  w.document.evaluate(
    path,
    w.document,
    null,
    w.XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  ).singleNodeValue;
w.eval(
  await readWithDependencies(
    new URL("../src/custom/form-pipeline.js", import.meta.url),
    "utf8",
  ),
);
// The adapter writes a labelled Greenhouse select through a pipeline binding:
// this control's own options, the shared answer rule and a verified commit.
w.greenhouseSelect = async (labelXPath, answer) => {
  const label = w.J(labelXPath),
    input = w.J(
      labelXPath + '/following-sibling::div//input[@role="combobox"]',
    );
  const spec =
    answer && typeof answer === "object"
      ? answer
      : answer
        ? w.JobsProfileAnswers.knownSpec(label?.textContent, answer)
        : null;
  return (
    await w.JobsFormPipeline.bind([
      { name: "fixture", find: () => input, answer: spec },
    ])
  )[0];
};
// The rules' one decision for a row, as the run passes it to the option reader.
const decided = (row, profile) => {
  const result = w.JobsProfileAnswers.resolve(
    row.public.question,
    profile,
    row.public,
  );
  return {
    optionSpec: result?.optionSpec,
    answer: result?.optionSpec?.query ?? result?.answer,
  };
};
const until = w.JobsDOMWait.until;
w.JobsDOMWait.until = (read, options) =>
  until(read, { ...options, timeout: Math.min(options.timeout, 250) });
after(() => w.close());

function fixture({
  id = "school--0",
  labels = ["University of California - Berkeley"],
  commit = true,
  error = false,
  initial = "",
  portal = false,
  delay = 30,
  finite = false,
  filter = () => labels,
  multi = false,
  question,
  display = (label) => label,
} = {}) {
  const root = createRoot(w.document.getElementById("root")),
    queries = [],
    clicks = [],
    keys = [];
  function Field() {
    const [query, setQuery] = React.useState(""),
      [selected, setSelected] = React.useState(
        multi ? (Array.isArray(initial) ? initial : []) : initial,
      ),
      [open, setOpen] = React.useState(false),
      [options, setOptions] = React.useState([]),
      [loading, setLoading] = React.useState(false);
    const hasValue = multi ? selected.length > 0 : !!selected;
    React.useEffect(() => {
      setOptions([]);
      setLoading(false);
      if (open && (query || finite)) {
        setLoading(true);
        const timer = setTimeout(() => {
          setOptions(filter(query));
          setLoading(false);
        }, delay);
        return () => clearTimeout(timer);
      }
    }, [query, open]);
    const choose = (label) => {
      clicks.push(label);
      if (commit) {
        setSelected(multi ? [...selected, label] : label);
        setQuery("");
        setOpen(false);
      }
    };
    const popup =
      open &&
      React.createElement(
        "div",
        { role: "listbox", id: id + "-list", "aria-multiselectable": multi },
        options
          .filter((label) => !multi || !selected.includes(label))
          .map((label, index) =>
            React.createElement(
              "div",
              { role: "option", key: index, onClick: () => choose(label) },
              label,
            ),
          ),
      );
    return React.createElement(
      "div",
      { className: "select" },
      React.createElement(
        "label",
        { id: id + "-label", htmlFor: id },
        question ||
          (id === "candidate-location" ? "Location (City)" : "School"),
      ),
      React.createElement(
        "div",
        {
          className: multi
            ? "select__value-container select__value-container--is-multi"
            : "select__value-container",
        },
        multi
          ? selected.map((label) =>
              React.createElement(
                "div",
                { className: "select__multi-value", key: label },
                React.createElement(
                  "div",
                  { className: "select__multi-value__label" },
                  label,
                ),
                React.createElement(
                  "div",
                  {
                    className: "select__multi-value__remove",
                    role: "button",
                    onClick: () => {
                      if (commit) {
                        setSelected(selected.filter((item) => item !== label));
                        setOpen(false);
                      }
                    },
                  },
                  "Remove",
                ),
              ),
            )
          : selected &&
              React.createElement(
                "div",
                { className: "select__single-value" },
                display(selected),
              ),
        React.createElement("input", {
          id,
          className: "select__input",
          role: "combobox",
          value: query,
          "aria-labelledby": id + "-label",
          "aria-controls": open ? id + "-list" : undefined,
          "aria-expanded": open,
          "aria-required": true,
          "aria-invalid": !hasValue || error,
          "aria-errormessage": id + "-error",
          onChange: (e) => {
            queries.push(e.target.value);
            setQuery(e.target.value);
          },
          // Observed Greenhouse wrapper controls menuIsOpen via onKeyUp/code.
          // React Select's own keydown handler cannot override that prop.
          onKeyDown: (e) => {
            keys.push(e.key);
            if (e.key === "Enter" && open && options.length) choose(options[0]);
          },
          onKeyUp: (e) => {
            if (e.code === "Escape" || e.code === "Tab") setOpen(false);
            else if (e.code !== "Enter") setOpen(true);
          },
          onBlur: () => {
            if (!selected) setQuery("");
            setOpen(false);
          },
        }),
        portal ? createPortal(popup, w.document.body) : popup,
        // React Select's menu notices while an async search is pending or empty.
        open &&
          (query || finite) &&
          (loading || !options.length) &&
          React.createElement(
            "div",
            {
              className:
                "select__menu-notice select__menu-notice--" +
                (loading ? "loading" : "no-options"),
            },
            loading ? "Loading..." : "No options",
          ),
      ),
      (!hasValue || error) &&
        React.createElement(
          "p",
          { id: id + "-error", className: "helper-text--error" },
          "Required",
        ),
    );
  }
  flushSync(() => root.render(React.createElement(Field)));
  const input = w.document.getElementById(id);
  const choose = (answer, options) =>
    w.greenhouseSelect(
      `//label[@id='${id}-label']`,
      options?.address
        ? w.JobsProfileAnswers.locationSpec(options.address)
        : answer,
    );
  return {
    input,
    choose,
    queries,
    clicks,
    keys,
    reader: w.JobsControlFields.create(w.document),
    close: () => flushSync(() => root.unmount()),
  };
}

test("actual Greenhouse school adapter triggers React search, waits and commits punctuation-normalized exact result", async () => {
  const f = fixture({
    labels: ["Berkeley College", "University of California - Berkeley"],
    portal: true,
  });
  try {
    assert.equal(await f.choose("University of California, Berkeley"), f.input);
    assert.deepEqual(f.clicks, ["University of California - Berkeley"]);
    assert(
      f.queries.includes("University of California, Berkeley"),
      "the full name retrieves the candidates",
    );
    assert.equal(
      f.input.value,
      "",
      "React Select clears search text after selection",
    );
    assert.equal(f.reader.scan()[0].public.filled, true);
    assert.equal(
      f.reader.response(f.reader.scan()[0]).response,
      "University of California - Berkeley",
    );
    assert.equal(f.reader.state().ready, true);
    assert(
      f.keys.includes("ArrowDown"),
      "explicit keyboard opening works when click does not",
    );
    assert(
      !f.keys.some((key) => ["Enter", "Tab"].includes(key)),
      "no key accepts a highlighted default",
    );
  } finally {
    f.close();
  }
});

test("custom college question uses profile search and shared school matching through read, resolve and commit", async () => {
  const correct = "University of California--Berkeley (CA)";
  const f = fixture({
    id: "question_college",
    question: "Which college did you attend?*",
    filter: (query) =>
      query === "Berkeley"
        ? ["Berkeley College (NJ)", "Berkeley College (NY)", correct]
        : [],
  });
  const profile = {
    educationData: [{ school: "University of California, Berkeley" }],
  };
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    const options = await writer.readOptions(
      writer.scan()[0],
      () => true,
      decided(writer.scan()[0], profile),
    );
    assert.deepEqual(
      Array.from(options, (o) => o.label),
      [correct],
    );
    const answer = w.JobsProfileAnswers.select(
      w.JobsProfileAnswers.resolve("Which college did you attend?", profile),
      options.map((o) => o.label),
    );
    assert.equal(answer, correct);
    await writer.apply(writer.scan()[0], answer);
    assert.deepEqual(f.clicks, [correct]);
    assert.equal(writer.state().ready, true);
    assert(
      !f.queries.some((q) => q.includes("(CA)")),
      "display suffix is not sent to literal name search",
    );
    assert(
      !f.keys.includes("Enter"),
      "highlighted wrong school is never accepted",
    );
  } finally {
    f.close();
  }
});

test("original custom college dropdown cannot fall back to the first keyword match", async () => {
  for (const labels of [
    ["Berkeley College (NJ)"],
    [
      "University of California--Berkeley (CA)",
      "University of California--Berkeley (NY)",
    ],
  ]) {
    const f = fixture({
      id: "question_college",
      question: "Which college did you attend?",
      labels,
      finite: true,
    });
    try {
      assert(
        (await f.choose("University of California, Berkeley")) === null,
        "unrelated or ambiguous schools must stay unselected",
      );
      assert.deepEqual(f.clicks, []);
    } finally {
      f.close();
    }
  }
});

test("custom school searches do not pick a profile education when several are present", async () => {
  const f = fixture({
    id: "question_college",
    question: "Which college did you attend?",
  });
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    const options = await writer.readOptions(
      writer.scan()[0],
      () => true,
      decided(writer.scan()[0], {
        educationData: [{ school: "First" }, { school: "Second" }],
      }),
    );
    assert.equal(options.length, 0);
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.clicks, []);
  } finally {
    f.close();
  }
});

test("original custom school selection uses the same full-name policy for other universities", async () => {
  const f = fixture({
    id: "question_other_college",
    question: "Which college did you attend?",
    labels: ["Example College (MA)", "Example University--North (MA)"],
  });
  try {
    assert((await f.choose("Example University, North")) === f.input);
    assert.deepEqual(f.clicks, ["Example University--North (MA)"]);
  } finally {
    f.close();
  }
});

test("indexed education school keeps its own profile entry when the profile has multiple degrees", async () => {
  const f = fixture({
    id: "school--1",
    labels: ["First University (NY)", "Second University (MA)"],
  });
  try {
    // The field's section (school--1) is a page fact; the rule picks that entry.
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    assert.equal(writer.scan()[0].public.educationIndex, 1);
    const options = await writer.readOptions(
      writer.scan()[0],
      () => true,
      decided(writer.scan()[0], {
        educationData: [
          { school: "First University" },
          { school: "Second University" },
        ],
      }),
    );
    assert.deepEqual(
      Array.from(options, (o) => o.label),
      ["Second University (MA)"],
    );
    assert.deepEqual(f.clicks, []);
  } finally {
    f.close();
  }
});

test("city waits for results and matches city, state and country rather than first result", async () => {
  const f = fixture({
    id: "candidate-location",
    labels: [
      "San Leandro, Chiapas, Mexico",
      "San Leandro, California, United States",
    ],
    delay: 80,
  });
  try {
    assert.equal(
      await f.choose("San Leandro, California", {
        address: {
          city: "San Leandro",
          state: "California",
          country: "United States of America",
        },
      }),
      f.input,
    );
    assert.deepEqual(f.clicks, ["San Leandro, California, United States"]);
    assert.equal(f.reader.state().ready, true);
  } finally {
    f.close();
  }
});

test("typed search alone is not a filled control or a saved response, even after menu closes", async () => {
  const f = fixture();
  try {
    await w.JobsControlFields.writeText(f.input, "Berkeley", { blur: false });
    f.input.setAttribute("aria-expanded", "false");
    f.input.setAttribute("aria-invalid", "false");
    const row = f.reader.scan()[0];
    assert.equal(row.public.filled, false);
    assert.equal(f.reader.response(row), null);
  } finally {
    f.close();
  }
});

test("missing and ambiguous school matches stay empty and never select a similar school", async () => {
  for (const labels of [
    ["Berkeley College"],
    [
      "University of California - Berkeley",
      "University of California, Berkeley",
    ],
  ]) {
    const f = fixture({ labels });
    try {
      assert.equal(await f.choose("University of California, Berkeley"), null);
      assert.deepEqual(f.clicks, []);
      assert.equal(f.input.value, "");
      assert.equal(f.reader.state().ready, false);
      assert(!f.keys.includes("Enter"));
    } finally {
      f.close();
    }
  }
});

test("click without a committed selection or with remaining field error is not success", async () => {
  for (const config of [{ commit: false }, { error: true }]) {
    const f = fixture(config);
    try {
      assert.equal(await f.choose("University of California, Berkeley"), null);
      assert.equal(f.reader.state().ready, false);
    } finally {
      f.close();
    }
  }
});

test("existing committed selection is preserved without searching again", async () => {
  const f = fixture({ initial: "User Selected University" });
  try {
    assert.equal(
      await f.choose("University of California, Berkeley"),
      null,
      "A preserved different answer is not a newly committed Profile answer",
    );
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.clicks, []);
  } finally {
    f.close();
  }
});

test("candidate location needs country context and rejects same city in a different country", async () => {
  const f = fixture({
    id: "candidate-location",
    labels: ["San Leandro, California, Mexico"],
  });
  try {
    assert.equal(await f.choose("San Leandro, California"), null);
    assert.equal(
      await f.choose("San Leandro, California, United States"),
      null,
    );
    assert.equal(
      await f.choose("", {
        address: {
          city: "San Leandro",
          state: "California",
          country: "United States",
        },
      }),
      null,
    );
    assert.deepEqual(f.clicks, []);
  } finally {
    f.close();
  }
});

test("shared writer uses the same search adapter for a complete city answer", async () => {
  const f = fixture({
    id: "candidate-location",
    labels: ["San Leandro, California, United States"],
  });
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    await writer.apply(
      writer.scan()[0],
      "San Leandro, California, United States",
    );
    assert.deepEqual(f.clicks, ["San Leandro, California, United States"]);
  } finally {
    f.close();
  }
});

test("cancellation while results load never clicks a later result", async () => {
  const f = fixture({ delay: 80 });
  try {
    let active = true;
    const result = chooseAnswer(f.input, "University of California, Berkeley", {
      canProceed: () => active,
    });
    setTimeout(() => {
      active = false;
    }, 15);
    assert.equal(await result, null);
    assert.deepEqual(f.clicks, []);
  } finally {
    f.close();
  }
});

test("school search retries the campus term but chooses only the complete exact university", async () => {
  const f = fixture({
    filter: (query) =>
      query === "Berkeley"
        ? [
            "Berkeley College",
            "Acupuncture and Integrative Medicine College - Berkeley",
            "University of California - Berkeley",
          ]
        : [],
  });
  try {
    assert.equal(await f.choose("University of California, Berkeley"), f.input);
    assert.deepEqual(f.clicks, ["University of California - Berkeley"]);
    assert.deepEqual(
      f.queries.filter(Boolean),
      ["University of California, Berkeley", "Berkeley"],
      "Each term is searched once; the full identity decides the match and that result is committed without searching again",
    );
  } finally {
    f.close();
  }
});

test("ordinary Greenhouse single-select exposes actual options and verifies committed selection", async () => {
  const f = fixture({
    id: "question_123",
    finite: true,
    question: "What is your expected graduation month & year?",
    labels: ["Already graduated", "Jan - April 2027", "May - Aug 2027"],
  });
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    assert.equal(writer.scan()[0].public.supported, true);
    const options = await writer.readOptions(writer.scan()[0]);
    assert.deepEqual(
      Array.from(options, (o) => o.label),
      ["Already graduated", "Jan - April 2027", "May - Aug 2027"],
    );
    assert.equal(f.input.getAttribute("aria-expanded"), "false");
    assert.equal(
      writer.scan()[0].public.filled,
      false,
      "reading options never selects the first item",
    );
    await writer.apply(writer.scan()[0], "May - Aug 2027");
    assert.equal(writer.response(writer.scan()[0]).response, "May - Aug 2027");
  } finally {
    f.close();
  }
});

test("multi-select lists and unknown labels cannot be written as single choices", async () => {
  for (const multi of [true, false]) {
    const f = fixture({
      id: "question_124",
      finite: true,
      multi,
      labels: ["Yes", "No"],
    });
    try {
      assert.equal(
        await chooseAnswer(f.input, multi ? "Yes" : "Invented"),
        null,
      );
      assert.deepEqual(f.clicks, []);
    } finally {
      f.close();
    }
  }
});

test("explicit replacement verifies the new label; ordinary fill preserves an existing answer", async () => {
  const f = fixture({
    id: "question_125",
    finite: true,
    initial: "Yes",
    labels: ["Yes", "No"],
  });
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    await assert.rejects(
      writer.apply(writer.scan()[0], "No"),
      /editable empty/,
    );
    await writer.apply(writer.scan()[0], "No", () => true, { replace: true });
    assert.equal(writer.response(writer.scan()[0]).response, "No");
  } finally {
    f.close();
  }
});

test("the rules answer school and place searches; other gaps reach AI with real candidates", async () => {
  w.chrome = { runtime: {} };
  for (const name of [
    "option-match",
    "profile-answers",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ])
    w.eval(
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    );
  installAnswerResolver(w, []);
  const profile = {
    addressData: {
      city: "San Leandro",
      state: "California",
      country: "United States",
    },
    educationData: [
      { school: "University of California, Berkeley", endDate: "2027-05" },
    ],
  };
  const cases = [
    {
      id: "candidate-location",
      labels: [
        "San Leandro, Chiapas, Mexico",
        "San Leandro, California, United States",
      ],
      answer: "San Leandro, California, United States",
      rule: true,
    },
    {
      id: "school--0",
      filter: (query) =>
        query === "Berkeley"
          ? ["Berkeley College", "University of California - Berkeley"]
          : [],
      answer: "University of California - Berkeley",
      rule: true,
    },
    {
      id: "question_college",
      question: "Which college did you attend?",
      filter: (query) =>
        query === "Berkeley"
          ? ["Berkeley College", "University of California--Berkeley (CA)"]
          : [],
      answer: "University of California--Berkeley (CA)",
      rule: true,
    },
    {
      id: "question_12678689007",
      finite: true,
      question: "What is your expected graduation month & year?",
      labels: ["Already graduated", "May - Aug 2027"],
      answer: "May - Aug 2027",
      rule: true,
    },
    {
      id: "question_12678500007",
      finite: true,
      question: "Will you now or in the future require company sponsorship?",
      labels: ["Yes, now", "Yes, in the future", "No"],
      answer: "Yes, in the future",
    },
    {
      id: "tenant_defined_question",
      multi: true,
      finite: true,
      question: "Which languages do you use?",
      labels: ["A", "B", "C"],
      answer: ["A", "C"],
    },
  ];
  for (const config of cases) {
    const f = fixture(config),
      requests = [],
      events = [];
    w.JobsDiagnostics = { note: (...args) => events.push(args) };
    w.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "jobs:tab-profile")
            return { data: { id: "test-profile", profile } };
          assert.equal(message.type, "jobs:auto-answers");
          requests.push(message);
          assert.equal(message.fields.length, 1);
          const desired = Array.isArray(config.answer)
            ? config.answer
            : [config.answer];
          assert(
            desired.every((answer) =>
              message.fields[0].options.some(
                (option) => option.label === answer,
              ),
            ),
          );
          assert(
            !message.fields[0].options.some(
              (option) => option.label === "Berkeley College",
            ),
          );
          return {
            data: {
              answers: [
                {
                  fieldId: message.fields[0].fieldId,
                  state: "answer",
                  value: config.answer,
                  source: "profile",
                  reason: "Confirmed fixture fact",
                  needsConfirmation: false,
                },
              ],
            },
          };
        },
      },
    };
    try {
      assert.equal(
        await w.JobsAutomatic.advance({
          root: w.document.getElementById("root"),
          profile,
          action: "fill",
          autoConfirm: true,
        }),
        true,
        JSON.stringify(events.map(([type, , detail]) => ({ type, detail }))),
      );
      assert.equal(requests.length, config.rule ? 0 : 1, config.id);
      assert.deepEqual(
        f.clicks,
        Array.isArray(config.answer) ? config.answer : [config.answer],
      );
      assert.equal(
        f.reader.response(f.reader.scan()[0]).response,
        Array.isArray(config.answer) ? config.answer.join("; ") : config.answer,
      );
    } finally {
      w.JobsAIReview.release(w.document.getElementById("root"));
      f.close();
    }
  }
});

test("optional upload and readable Greenhouse surveys do not block completion; real gaps still do", async () => {
  const survey = (id, markup = "") =>
    `<div class="select"><label for="${id}">Optional survey ${id}</label>${markup}<input id="${id}" class="select__input" role="combobox" aria-required="false" aria-invalid="false"></div>`;
  const d = new JSDOM(
    '<form><label>Cover Letter<input type="file"></label>' +
      [
        survey(
          "101",
          '<div class="select__multi-value"><div class="select__multi-value__label">Man</div></div>',
        ),
        survey(
          "102",
          '<div class="select__multi-value"><div class="select__multi-value__label">East Asian</div></div>',
        ),
        survey("103"),
        survey("104"),
        survey("105", '<div class="select__single-value">No</div>'),
        survey(
          "106",
          '<div class="select__single-value">No, I am not a veteran or active member</div>',
        ),
      ].join("") +
      "</form>",
    {
      url: "https://job-boards.greenhouse.io/example/jobs/1",
      runScripts: "outside-only",
    },
  );
  try {
    for (const name of [
      "control-fields",
      "workday-controls",
      "greenhouse-controls",
    ])
      d.window.eval(
        await readWithDependencies(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        ),
      );
    const reader = d.window.JobsControlFields.create(d.window.document),
      doc = d.window.document;
    assert.equal(reader.state().ready, true);
    assert.equal(reader.state().phase, "page-complete");
    assert.equal(
      reader.scan().filter((row) => !row.public.supported).length,
      1,
      "all dropdowns have writers; native upload remains adapter-owned",
    );
    assert.equal(
      reader.scan().filter((row) => row.public.filled).length,
      4,
      "selected pills are actual answers",
    );
    const blank = doc.getElementById("103");
    blank.value = "Uncommitted search";
    blank.setAttribute("aria-required", "true");
    assert.equal(
      reader.state().ready,
      false,
      "required search text alone does not count",
    );
    blank.setAttribute("aria-required", "false");
    blank.setAttribute("aria-invalid", "true");
    assert.equal(
      reader.state().ready,
      false,
      "optional validation errors still block",
    );
    blank.setAttribute("aria-invalid", "false");
    doc.querySelector("[type=file]").required = true;
    assert.equal(
      reader.state().ready,
      false,
      "required empty attachment still blocks",
    );
    doc.querySelector("[type=file]").required = false;
    const unknown = doc.createElement("div");
    unknown.setAttribute("contenteditable", "true");
    unknown.setAttribute("aria-label", "Unknown widget");
    doc.querySelector("form").append(unknown);
    assert.equal(
      reader.state().ready,
      false,
      "unknown controls remain conservative",
    );
  } finally {
    d.window.close();
  }
});

test("Greenhouse multiple choices read committed pills, add exact options and replace only when requested", async () => {
  const f = fixture({
    id: "12345",
    multi: true,
    finite: true,
    labels: ["A", "B", "C"],
    question: "Choose skills",
  });
  try {
    const writer = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    assert.equal(writer.scan()[0].public.type, "select-multiple");
    assert.equal(writer.scan()[0].public.filled, false);
    const options = await writer.readOptions(writer.scan()[0]);
    assert.deepEqual(
      Array.from(options, (o) => o.value),
      ["A", "B", "C"],
    );
    await writer.apply(writer.scan()[0], ["A", "C"]);
    assert.deepEqual(Array.from(writer.scan()[0].raw), ["A", "C"]);
    assert.equal(writer.response(writer.scan()[0]).response, "A; C");
    await assert.rejects(
      writer.apply(writer.scan()[0], ["B"]),
      /editable empty/,
    );
    await writer.apply(writer.scan()[0], ["B", "C"], () => true, {
      replace: true,
    });
    assert.deepEqual(Array.from(writer.scan()[0].raw).sort(), ["B", "C"]);
    assert.equal(writer.state().ready, true);
    await assert.rejects(
      writer.apply(writer.scan()[0], ["Unknown"], () => true, {
        replace: true,
      }),
      /not committed/,
    );
    assert.deepEqual(
      Array.from(writer.scan()[0].raw).sort(),
      ["B", "C"],
      "unknown answer cannot erase existing selections",
    );
  } finally {
    f.close();
  }
});

test("multi-select clicks without a committed value report failure", async () => {
  const f = fixture({
    id: "12346",
    multi: true,
    finite: true,
    labels: ["A", "B"],
    commit: false,
  });
  try {
    assert.equal(await chooseAnswer(f.input, ["B"]), null);
    assert.equal(f.reader.scan()[0].public.filled, false);
  } finally {
    f.close();
  }
});

test("Greenhouse ordinary dropdown needs a semantic answer and cannot use a legacy predicate to invent one", async () => {
  const f = fixture({
    id: "gender",
    finite: true,
    question: "Gender",
    labels: ["Female", "Male"],
  });
  try {
    const result = await w.greenhouseSelect('//label[@id="gender-label"]', "");
    assert.equal(result, null);
    assert.deepEqual(f.clicks, []);
    assert((await f.choose("Male")) === f.input);
    assert.deepEqual(f.clicks, ["Male"]);
    assert.equal(f.reader.state().ready, true);
  } finally {
    f.close();
  }
});

test("original demographic multi-select and supplemental replacement share the committed-pill writer", async () => {
  const f = fixture({
    id: "demographic",
    finite: true,
    multi: true,
    question: "Identity",
    labels: ["Man", "Woman", "Other"],
  });
  try {
    assert(
      (await w.greenhouseSelect(
        '//label[@id="demographic-label"]',
        w.JobsProfileAnswers.eeoSpec("gender", { gender: "Male" }),
      )) === f.input,
    );
    assert.deepEqual(f.clicks, ["Man"]);
    const reader = w.JobsControlFields.create(w.document, () => w.document, {
      write: true,
    });
    await reader.apply(reader.scan()[0], ["Other"], () => true, {
      replace: true,
    });
    assert.deepEqual(Array.from(reader.scan()[0].raw), ["Other"]);
    assert.equal(reader.state().ready, true);
  } finally {
    f.close();
  }
});

test("Greenhouse initial degree selection uses the same specification and refuses invented subtypes", async () => {
  const f = fixture({
    id: "degree",
    finite: true,
    question: "Degree",
    labels: ["Bachelor of Arts", "Bachelor of Science"],
  });
  try {
    assert.equal(
      await f.choose("Bachelor"),
      null,
      "A level alone cannot choose Arts or Science",
    );
    assert.deepEqual(f.clicks, []);
    assert((await f.choose("Bachelor of Arts")) === f.input);
    assert.deepEqual(f.clicks, ["Bachelor of Arts"]);
  } finally {
    f.close();
  }
});

test('a school search with no results ends at the "No options" notice instead of the timeout, then tries the next term', async () => {
  const f = fixture({
    filter: (query) =>
      query === "Example" ? ["Example State University"] : [],
  });
  w.JobsDOMWait.until = (read, options) =>
    until(read, { ...options, timeout: Math.min(options.timeout, 5000) });
  try {
    const start = Date.now();
    assert.equal(await f.choose("Example State University"), f.input);
    assert.deepEqual(f.queries.filter(Boolean), [
      "Example State University",
      "Example",
    ]);
    assert(
      Date.now() - start < 2000,
      "each empty search ends at its notice, not a 5 s timeout",
    );
  } finally {
    w.JobsDOMWait.until = (read, options) =>
      until(read, { ...options, timeout: Math.min(options.timeout, 250) });
    f.close();
  }
});

test("a phone country picker longer than the option limit is filtered by the answer and matches without its dialing code", async () => {
  const labels = [
    "United States +1",
    ...Array.from({ length: 240 }, (_, i) => `Country ${i} +${i + 2}`),
    "United States Minor Outlying Islands +1",
    "Canada +1",
  ];
  // Like the real page, the chosen country displays only its dialing code.
  const f = fixture({
    id: "country",
    question: "Country*",
    finite: true,
    labels,
    filter: (query) =>
      labels.filter((label) =>
        label.toLowerCase().includes(query.toLowerCase()),
      ),
    display: (label) => label.split(" ").at(-1),
  });
  try {
    assert.equal(
      await w.greenhouseSelect(
        `//label[@id='country-label']`,
        w.JobsProfileAnswers.countrySpec("United States"),
      ),
      f.input,
    );
    assert.deepEqual(f.clicks, ["United States +1"]);
    assert.equal(
      f.input.closest(".select").querySelector(".select__single-value")
        .textContent,
      "+1",
    );
    assert.equal(f.reader.state().ready, true);
    // Kept, not chosen again, when the field already shows its code.
    assert.equal(
      await w.greenhouseSelect(
        `//label[@id='country-label']`,
        w.JobsProfileAnswers.countrySpec("United States"),
      ),
      f.input,
    );
    assert.deepEqual(f.clicks, ["United States +1"]);
  } finally {
    f.close();
  }
});
