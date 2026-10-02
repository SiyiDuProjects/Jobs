import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const source = await readWithDependencies(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
async function fixture(
  kind,
  {
    classic = true,
    reverse = false,
    placeholderOnly = false,
    uncommitted = false,
    missing = false,
  } = {},
) {
  const content =
    kind === "month"
      ? '<section id="section"><div data-automation-id="formField-startDate"><label>Start month*</label><div id="control" data-automation-id="dateInputWrapper"><input id="year" data-automation-id="dateSectionYear-input" aria-required="true"><input id="month" data-automation-id="dateSectionMonth-input" aria-required="true"></div></div></section>'
      : kind === "paste"
        ? '<div data-automation-id="formField-company"><label for="control">Company*</label><input id="control" data-automation-id="company" required></div>'
        : kind === "today"
          ? '<div data-automation-id="formField-date"><label>Date*</label><div id="control" data-automation-id="dateInputWrapper"><input id="month" data-automation-id="dateSectionMonth-input" required><input id="day" data-automation-id="dateSectionDay-input" required><input id="year" data-automation-id="dateSectionYear-input" required><button type="button" id="icon" data-automation-id="dateIcon"></button></div></div><button type="button" id="today" data-automation-id="datePickerSelectedToday">Today</button>'
          : kind === "checkbox"
            ? '<fieldset id="control" data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true"><legend>Please check one of the boxes below:*</legend><div role="cell"><input type="checkbox" id="choice0" style="display:none"><label for="choice0">First choice</label></div><div role="cell"><input type="checkbox" id="choice1" style="display:none"><label for="choice1">Second choice</label></div></fieldset>'
            : '<div data-automation-id="formField-language"><label for="control" data-automation-id="richText">Proficiency*</label><button type="button" id="control" data-automation-id="languageProficiency-0" aria-haspopup="listbox" aria-controls="levels" aria-required="true">Select one</button></div><ul id="levels" role="listbox"></ul>';
  const dom = new JSDOM(
    `<form ${classic ? 'data-automation-id="ApplyFlowPage"' : ""}>${content}</form>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    trace = [],
    control = doc.getElementById("control");
  w.DataTransfer = class {
    constructor() {
      this.data = {};
    }
    setData(type, value) {
      this.data[type] = value;
    }
    getData(type) {
      return this.data[type];
    }
  };
  w.ClipboardEvent = class extends w.Event {
    constructor(type, options) {
      super(type, options);
      this.clipboardData = options.clipboardData;
    }
  };
  const all = (query, base = doc) => {
    const result = doc.evaluate(
      query,
      base,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, index) =>
      result.snapshotItem(index),
    );
  };
  const find = (query, base) => all(query, base)[0] || null;
  const labels = reverse
    ? ["Fluent", "Advanced", "Beginner"]
    : ["Beginner", "Advanced", "Fluent"];
  const mountOptions = () => {
    doc.querySelector("ul").innerHTML =
      '<li id="select-one" role="option">Select one</li>' +
      labels
        .map(
          (label, index) =>
            `<li id="level${index}" role="option">${label}</li>`,
        )
        .join("");
    for (const option of doc.querySelectorAll("li:not(#select-one)"))
      option.onclick = () => {
        if (!uncommitted) control.textContent = option.textContent;
      };
  };
  if (kind === "language") {
    if (placeholderOnly)
      doc.querySelector("ul").innerHTML =
        '<li id="select-one" role="option">Select one</li>';
    else mountOptions();
  }
  for (const type of [
    "click",
    "focus",
    "focusin",
    "keydown",
    "keypress",
    "keyup",
    "input",
    "change",
    "blur",
    "focusout",
    "paste",
  ])
    doc.addEventListener(
      type,
      (event) => {
        if (event.target.id)
          trace.push([
            "event",
            type,
            event.target.id,
            event.key || "",
            event.keyCode || 0,
            event.cancelable,
            ...(type === "paste"
              ? [event.clipboardData.getData("text/plain")]
              : []),
          ]);
      },
      true,
    );
  const click = (query, useXPath = false) => {
    trace.push(["click", query, useXPath]);
    const element = useXPath ? find(query) : doc.querySelector(query);
    element?.click();
    return element;
  };
  Object.assign(w, {
    jobsFindXPath: find,
    jobsClick: click,
    jobsLanguageProficiencyLevels: [
      "Beginner",
      "Intermediate",
      "Advanced",
      "Fluent",
    ],
    jobsWaitAndClick: async (selector) => {
      trace.push(["waitAndClick", selector]);
      return click(selector);
    },
    jobsWaitForXPathNodes: async (query) => {
      trace.push(["waitXPath", query]);
      if (placeholderOnly && query.includes("not(@id")) mountOptions();
      return all(query);
    },
    jobsWaitForCssNodes: async (selector) => {
      trace.push(["waitCss", selector]);
      return [...doc.querySelectorAll(selector)];
    },
    jobsWriteInput: async (value, query, useXPath) => {
      trace.push(["writeInput", value, query, useXPath]);
      const input = find(query);
      if (input) input.value = value;
      return input;
    },
    jobsWriteText: async (value, query, ...args) => {
      trace.push(["writeText", value, query, ...args]);
      const input = find(query);
      if (input) input.value = value;
      return input;
    },
    jobsDelay: async (delay) => trace.push(["delay", delay]),
  });
  for (const script of scripts) w.eval(script);
  if (missing) {
    if (kind === "month") doc.getElementById("year").remove();
    else control.remove();
  }
  // Each kind is one binding, as the Workday adapter declares it.
  const answers = w.JobsProfileAnswers,
    declare = {
      month: (answer = "2027-05") => ({
        find: () => doc.getElementById("control"),
        answer,
        replace: true,
      }),
      checkbox: (answer = "Second") => ({
        find: "#control",
        answer: answers.literalSpec("known-answer", answer),
      }),
      paste: (answer = "Example company") => ({
        find: "#control",
        answer,
        replace: true,
      }),
      today: () => ({
        find: () => doc.getElementById("control"),
        answer: () => answers.today(),
        replace: true,
      }),
      language: (answer = "Advanced") => ({
        find: () =>
          w.JobsWorkdayControls.listbox(doc.getElementById("control"), {
            language: true,
          }),
        answer: answers.languageSpec(answer),
      }),
    }[kind];
  const run = async (answer) =>
    (await w.JobsFormPipeline.bind([{ name: kind, ...declare(answer) }]))[0];
  return {
    w,
    doc,
    control,
    trace,
    run,
    reader: w.JobsControlFields.create(doc, () => doc.querySelector("form"), {
      write: true,
    }),
    close: () => w.close(),
  };
}
const identity = (node) => (node?.nodeType === 1 ? node.id : node);
// Company deliberately moved to the awaited shared commit. Its independent
// model-acceptance regressions are in workday-company-commit.test.mjs.
for (const kind of ["month", "checkbox", "today"])
  test(
    "Workday " + kind + " binding commits through the shared field writer",
    async () => {
      for (const classic of [true, false]) {
        const h = await fixture(kind, { classic });
        try {
          if (kind === "checkbox") {
            assert.equal(
              await h.run("Second"),
              null,
              "partial option names no longer choose a value",
            );
            assert(await h.run("Second choice"));
            assert.equal(h.reader.scan()[0].raw, "Second choice");
          } else if (kind === "month") {
            assert(await h.run());
            assert.equal(h.reader.scan()[0].raw, "2027-05");
            assert(
              !h.trace.some((item) => item[0] === "delay"),
              "no fixed year-to-month delay",
            );
          } else {
            assert(await h.run());
            assert.equal(
              h.reader.scan()[0].raw,
              h.w.JobsProfileAnswers.today(),
            );
            assert(
              !h.trace.some(
                (item) => item[0] === "click" || item[0] === "waitAndClick",
              ),
              "the declared date uses the full-date writer",
            );
          }
        } finally {
          h.close();
        }
      }
    },
  );

test("Workday two-part month is one real month field in both layouts; no invented day", async () => {
  for (const classic of [true, false]) {
    const h = await fixture("month", { classic });
    try {
      let rows = h.reader.scan();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].public.type, "month");
      assert.equal(h.reader.state().ready, false);
      for (const answer of ["2027", "2027-13", "2027-05-01"])
        await assert.rejects(h.reader.apply(rows[0], answer));
      await h.reader.apply(rows[0], "2027-05");
      rows = h.reader.scan();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].raw, "2027-05");
      assert.equal(h.reader.response(rows[0]).response, "2027-05");
      assert.equal(h.reader.state().ready, true);
      assert.equal(h.doc.getElementById("year").value, "2027");
      assert.equal(h.doc.getElementById("month").value, "05");
    } finally {
      h.close();
    }
  }
});

test("a full calendar temporarily missing Day is not reclassified as a month picker", async () => {
  const h = await fixture("today");
  try {
    h.doc.getElementById("day").remove();
    assert.equal(h.w.JobsWorkdayControls.isMonth(h.control), false);
    assert.equal(h.w.JobsWorkdayControls.describe(h.control), null);
    assert.equal(
      h.reader.scan().some((row) => row.public.type === "month"),
      false,
    );
  } finally {
    h.close();
  }
});
test("Workday checkbox label operation and shared group use one question and verified checked value", async () => {
  for (const classic of [true, false]) {
    const h = await fixture("checkbox", { classic });
    try {
      const rows = h.reader.scan();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].public.type, "custom-radio");
      assert.equal((await h.reader.readOptions(rows[0])).length, 2);
      await h.reader.apply(rows[0], "Second choice");
      assert.equal(h.reader.scan()[0].raw, "Second choice");
      assert.equal(h.reader.state().ready, true);
      assert.equal(h.doc.getElementById("choice1").checked, true);
    } finally {
      h.close();
    }
  }
});
test("Workday shared caller selects exact observed language label", async () => {
  const h = await fixture("language");
  try {
    const rows = h.reader.scan();
    assert.equal(rows.length, 1);
    const options = await h.reader.readOptions(rows[0]);
    assert(options.some((option) => option.label === "Advanced"));
    await h.reader.apply(rows[0], "Advanced");
    assert.equal(h.reader.scan()[0].raw, "Advanced");
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});
test("Workday semantic language click with no readback is unconfirmed and does not trigger a second fill", async () => {
  const h = await fixture("language", { uncommitted: true });
  try {
    assert.equal(await h.run(), null);
    const row = h.reader.scan()[0];
    assert.equal(row.public.completion, "unconfirmed");
    assert.equal(h.w.JobsControlFields.needsAnswer(row.public), false);
    await assert.rejects(h.reader.apply(row, "Advanced"));
    const count = h.trace.length;
    assert.equal(await h.run(), null);
    assert.equal(h.trace.length, count);
  } finally {
    h.close();
  }
});

test("Workday language adapter uses meaning across display orders and preserves existing answers", async () => {
  for (const reverse of [false, true]) {
    const h = await fixture("language", { reverse });
    try {
      assert(await h.run());
      assert.equal(h.control.textContent, "Advanced");
      await h.run("Beginner");
      assert.equal(h.control.textContent, "Advanced");
    } finally {
      h.close();
    }
  }
});

test("Workday company binding and scanner writer share the awaited paste commit", async () => {
  const before = await fixture("paste"),
    after = await fixture("paste");
  try {
    const row = after.reader.scan()[0];
    assert.equal(after.reader.scan().length, 1);
    assert.equal(row.public.component, "workday-company-paste");
    await before.run();
    await after.reader.apply(row, "Example company");
    assert.deepEqual(after.trace, before.trace);
    assert.equal(after.reader.scan()[0].raw, "Example company");
    assert.equal(after.reader.state().ready, true);
    assert.equal(after.trace.filter((item) => item[1] === "paste").length, 1);
    assert.equal(
      (await after.reader.readOptions(after.reader.scan()[0])).length,
      0,
    );
  } finally {
    before.close();
    after.close();
  }
});

test("Workday paste binding preserves existing text for missing facts and commits a same-value replacement", async () => {
  for (const value of [null, "", "Example company"]) {
    const h = await fixture("paste");
    try {
      h.control.value = "Example company";
      await h.run(value);
      assert.equal(h.control.value, "Example company");
      assert.equal(
        h.trace.filter((item) => item[1] === "paste").length,
        value ? 1 : 0,
      );
      assert.equal(
        h.trace.filter((item) => item[1] === "focusout").length,
        value ? 1 : 0,
      );
    } finally {
      h.close();
    }
  }
});

test("Workday full-date writer keeps true day precision and cancellation between native writes", async () => {
  for (const cancel of [false, true]) {
    const h = await fixture("today");
    try {
      const api = h.w.JobsWorkdayControls,
        row = h.reader.scan().find((row) => row.node === h.control);
      assert(row.dateParts);
      assert.equal(api.describe(h.control), null);
      assert.equal(await chooseAnswer(h.control, "2027-05"), null);
      let proceed = true;
      if (cancel)
        h.doc
          .getElementById("month")
          .addEventListener("change", () => (proceed = false), { once: true });
      if (cancel) {
        assert.equal(
          await chooseAnswer(h.control, "2027-05-09", {
            canProceed: () => proceed,
          }),
          null,
        );
        assert.equal(h.doc.getElementById("year").value, "");
      } else {
        assert.equal(await chooseAnswer(h.control, "2027-05-09"), h.control);
        assert.equal(
          h.reader.scan().find((row) => row.node === h.control).raw,
          "2027-05-09",
        );
      }
    } finally {
      h.close();
    }
  }
});

test("Workday month stops after a manual edit between its year and month writes", async () => {
  const h = await fixture("month");
  try {
    const pending = chooseAnswer(h.control, "2027-05");
    h.doc.getElementById("year").value = "2030";
    h.doc
      .getElementById("year")
      .dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.equal(await pending, null);
    assert.equal(h.doc.getElementById("year").value, "2030");
    assert.equal(h.doc.getElementById("month").value, "");
  } finally {
    h.close();
  }
});

test("Workday extra discovery does not capture a same-named company input on other platforms", async () => {
  const h = await fixture("paste");
  try {
    h.w.history.replaceState(null, "", "/other-question");
    const other = new JSDOM(
      '<form><label for="company">Company</label><input id="company" name="companyName"></form>',
      { url: "https://jobs.example.test/apply", runScripts: "outside-only" },
    );
    try {
      for (const script of scripts) other.window.eval(script);
      const api = other.window.JobsWorkdayControls,
        input = other.window.document.querySelector("input");
      assert.equal(api.isControl(input), false);
      assert.equal(api.find(other.window.document).length, 0);
      const row = other.window.JobsControlFields.create(
        other.window.document,
      ).scan()[0];
      assert.equal(row.node, input);
      assert.equal(row.public.component, "text");
    } finally {
      other.window.close();
    }
  } finally {
    h.close();
  }
});

test("Workday native checkbox group preserves optional and required completion after component migration", async () => {
  const h = await fixture("checkbox");
  try {
    h.control.removeAttribute("aria-required");
    h.control.querySelector("legend").textContent = "Disability";
    let row = h.reader.scan()[0];
    assert.equal(row.public.required, false);
    assert.equal(row.public.requiredKnown, true);
    assert.equal(row.public.completion, "optional-empty");
    await h.reader.apply(row, ["Second choice"]);
    row = h.reader.scan()[0];
    assert.equal(row.public.completion, "filled");
    assert.equal(h.reader.state().ready, true);
    h.doc.getElementById("choice1").checked = false;
    h.control.setAttribute("aria-required", "true");
    row = h.reader.scan()[0];
    assert.equal(row.public.required, true);
    assert.equal(row.public.completion, "required-empty");
    assert.equal(h.reader.state().ready, false);
  } finally {
    h.close();
  }
});
