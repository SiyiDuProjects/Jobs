import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const current = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const shared = await Promise.all(
  ["dom-controls", "answer-helpers", "profile-format"].map((name) =>
    readModule(
      new URL("../source/content/shared/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const codes = await Promise.all(
  [
    "answer-policy",
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "form-pipeline",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const block = functionBlock;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, details = () => undefined) {
  const end = Date.now() + 6000;
  while (!predicate() && Date.now() < end) await delay(10);
  assert(predicate(), details());
}

// Execute the current workdayRunApplication, workdayFillVoluntaryDisclosures, workdayFillSelfIdentification and shared page helpers. Only DOM
// primitives and profile transport are supplied by the fixture. Controls mount
// after the first fixed wait; the original loading predicate must still wait.
async function run(kind, legacy, patched) {
  const step =
    kind === "disclosures"
      ? "applyFlowVoluntaryDisclosuresPage"
      : "applyFlowSelfIdentifyPage";
  const dom = new JSDOM(
    `<main ${legacy ? 'data-automation-id="ApplyFlowPage"' : ""}><section data-automation-id="${step}">Loading</section><button id="next" data-automation-id="pageFooterNextButton">Save and Continue</button></main>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    root = w.document.querySelector("section"),
    trace = [],
    phases = [];
  const profile = {
    nameData: { firstName: "Fixture", lastName: "Applicant" },
    languageData: [{ language: "English" }],
    employmentData: {
      ethnicity: "Asian",
      gender: "Male",
      veteran: false,
      disability: false,
    },
  };
  let clicks = 0,
    answers = 0,
    mount;
  w.JobsAIReview = { pending: () => false };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type !== "jobs:tab-profile") {
          answers++;
          throw Error("Unexpected AI request");
        }
        return { data: { id: "fixture", profile } };
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  shared.forEach((code) => w.eval(code));
  w.eval(
    [
      "workdayFillVoluntaryDisclosures",
      "workdayFillSelfIdentification",
      "workdayRunApplication",
    ]
      .map((name) => block(current, name))
      .join("\n"),
  );
  w.jobsWaitForXPathNodes = (path) => {
    if (!path.includes(step)) return new Promise(() => {});
    if (path.includes("loading")) {
      trace.push("wait:loading");
      mount = setTimeout(mountControls, 50);
    }
    return w.JobsDOMWait.until(() => w.document && w.jobsFindXPath(path));
  };
  w.jobsDelay = async (ms) => {
    trace.push("wait:" + ms);
    await delay(ms);
  };
  // Known Profile fields use the original routines. Only optional blanks may
  // reach the rule pass (never AI); it finds no rule for them and moves on.
  installAnswerResolver(w);
  w.JobsPageSession = { root: () => root };
  w.document.querySelector("#next").onclick = () => {
    clicks++;
    trace.push("next");
  };
  function choice(name, label, options) {
    root.insertAdjacentHTML(
      "beforeend",
      `<div data-automation-id="formField-${name}"><label id="label-${name}">${label} *</label><button id="${name}" name="${name}" data-automation-id="${name}" aria-labelledby="label-${name}" aria-haspopup="listbox">Select One</button></div>`,
    );
    const button = w.document.getElementById(name),
      listId = name + "-options";
    const close = () => {
      w.document.getElementById(listId)?.remove();
      button.removeAttribute("aria-controls");
    };
    button.onkeydown = (event) => {
      if (event.key === "Escape") close();
    };
    button.onclick = () => {
      close();
      button.setAttribute("aria-controls", listId);
      w.document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="${listId}" role="listbox">${options.map((value) => `<div role="option">${value}</div>`).join("")}</div>`,
      );
      for (const option of w.document.getElementById(listId).children)
        option.onclick = () => {
          button.textContent = option.textContent;
          trace.push("answer:" + name);
          close();
        };
    };
  }
  function mountControls() {
    root.textContent = "";
    trace.push("mounted");
    if (kind === "disclosures") {
      choice("ethnicity", "Race or ethnicity", [
        "Asian (United States of America)",
        "White",
      ]);
      choice("gender", "Gender", ["Female", "Male"]);
      choice("veteranStatus", "Veteran status", [
        "I am not a veteran.",
        "Prefer not to answer",
      ]);
      root.insertAdjacentHTML(
        "beforeend",
        '<label>I agree to the privacy policy for processing my personal data<input type="checkbox" required data-automation-id="agreementCheckbox"></label>',
      );
    } else {
      choice("language", "Language", ["English", "Spanish"]);
      root.insertAdjacentHTML(
        "beforeend",
        '<label>Name<input data-automation-id="name" required></label><label>Employee ID (if applicable)<input id="employee"></label><div data-automation-id="dateInputWrapper" aria-label="Signature date"><input id="month" data-automation-id="dateSectionMonth-input" required><input id="day" data-automation-id="dateSectionDay-input" required><input id="year" data-automation-id="dateSectionYear-input" required></div><button data-automation-id="dateIcon">Calendar</button><fieldset data-automation-id="disabilityStatus-CheckboxGroup"><legend>Disability</legend><div role="cell"><label for="disability-no">No, I do not have a disability</label><input id="disability-no" type="checkbox"></div></fieldset>',
      );
      root.querySelector('[data-automation-id="dateIcon"]').onclick = () => {
        trace.push("calendar");
        w.document.body.insertAdjacentHTML(
          "beforeend",
          '<button data-automation-id="datePickerSelectedToday">Today</button>',
        );
        w.document.querySelector(
          '[data-automation-id="datePickerSelectedToday"]',
        ).onclick = (event) => {
          trace.push("today");
          w.JobsControlFields.create(w.document, () => root)
            .scan()
            .find((row) => row.dateParts).raw = "09/18/2026";
          event.target.remove();
        };
      };
    }
  }
  try {
    const options = {
      getProfile: async () => profile,
      setMessage: (phase) => phases.push(phase),
      autofillSettings: { autoClickNextPage: true, autoSubmit: false },
      accountSettings: {},
      ctx: {},
    };
    await w.workdayRunApplication(
      patched ? w.JobsAutomatic.observe(options) : options,
    );
    await until(
      () => clicks === 1,
      () =>
        JSON.stringify({
          kind,
          legacy,
          patched,
          trace,
          phases,
          fields: w.JobsControlFields.create(w.document, () => root)
            .scan()
            .map((row) => row.public),
        }),
    );
    assert.equal(answers, 0);
    assert(!phases.includes("complete-required"));
    assert(!phases.includes("ai-review"));
    assert(
      trace.indexOf("wait:loading") < trace.indexOf("mounted"),
      "loading predicate must wait for controls",
    );
    assert.equal(clicks, 1);
    const values =
      kind === "disclosures"
        ? [...root.querySelectorAll("button")]
            .map((node) => node.textContent)
            .concat(root.querySelector("input").checked)
        : [
            root.querySelector('[data-automation-id="name"]').value,
            [
              root.querySelector("#year").value,
              root.querySelector("#month").value.padStart(2, "0"),
              root.querySelector("#day").value.padStart(2, "0"),
            ].join("-"),
            root.querySelector("#disability-no").checked,
            root.querySelector("#employee").value,
          ];
    return { values, trace };
  } finally {
    clearTimeout(mount);
    w.dispatchEvent(new w.Event("pagehide"));
    w.close();
  }
}

for (const kind of ["disclosures", "self-identify"])
  for (const legacy of [false, true]) {
    test(`declarative ${kind} bindings handle delayed controls (${legacy ? "legacy" : "modern"} Workday)`, async () => {
      const after = await run(kind, legacy, true);
      // Same values and the same event order as the original; the original's
      // fixed waits are replaced by waiting for the step's fields to settle.
      const fixed = (trace) =>
          trace.filter((value) => /^wait:\d+$/.test(value)),
        events = (trace) => trace.filter((value) => !/^wait:\d+$/.test(value));

      assert.deepEqual(fixed(after.trace), []);
      if (kind === "disclosures")
        assert.deepEqual(after.values, [
          "Asian (United States of America)",
          "Male",
          "I am not a veteran.",
          true,
        ]);
      else {
        assert.equal(after.values[0], "Fixture Applicant");
        assert.match(after.values[1], /^\d{4}-\d{2}-\d{2}$/);
        assert.deepEqual(after.values.slice(2), [true, ""]);
      }
    });
  }
