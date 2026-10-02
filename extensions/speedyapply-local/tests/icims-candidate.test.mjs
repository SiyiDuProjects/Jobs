import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { replayCase } from "../scripts/repro-runner.mjs";

const codes = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "icims-controls",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
    "repro-case",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const choices = (
  id,
  label,
  required = false,
  search = false,
) => `<div class="iCIMS_FieldRow"><div class="iCIMS_InfoField"><label id="label_${id}" for="${id}">${label}</label></div><div class="iCIMS_InfoData">
<select id="${id}" icimsdropdown-enabled="1" icimsdropdown-search="${+search}" ${required ? 'i_required="true" class="iCIMS_Forms_RequiredField dropdown-hide"' : 'class="dropdown-hide"'}><option value=""></option></select>
<a id="${id}_icimsDropdown" role="combobox" aria-labelledby="label_${id}" aria-expanded="false"><span class="dropdown-text"><span class="dropdown-placeholder">— Make a Selection —</span></span></a>
<div class="dropdown-container dropdown-invisible"><input class="dropdown-search" ${search ? "" : 'aria-hidden="true"'}><ul><li role="option" dropdown-index="-1">— Make a Selection —</li>${["Yes", "No"].map((x, i) => `<li role="option" dropdown-index="${i}" title="${x}">${x}</li>`).join("")}</ul></div></div></div>`;
const date = (
  required = false,
) => `<div role="group" aria-labelledby="availability_label" class="iCIMS_FieldRow"><div class="iCIMS_InfoField"><label id="availability_label">Availability</label><label>(Month / Day / Year)</label>${required ? '<span class="Field_Required">*</span>' : ""}</div><div class="iCIMS_InfoData"><div class="iCIMS_Forms_DateOnlyField">
<label>Month<select class="iCIMS_Forms_MonthInput"><option value="0"></option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}</option>`).join("")}</select></label>
<label>Day<select class="iCIMS_Forms_DayInput"><option value="0"></option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></label>
<label>Year<input class="iCIMS_Forms_YearInput" maxlength="4"></label></div></div></div>`;
function setup(html) {
  const dom = new JSDOM(
      `<style>.dropdown-hide,.dropdown-invisible{display:none}</style><form>${html}</form>`,
      {
        url: "https://fixture.icims.com/jobs/1/candidate",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    doc = w.document;
  w.TextEncoder = TextEncoder;
  w.chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
  };
  codes.forEach((code) => w.eval(code));
  for (const trigger of doc.querySelectorAll('a[role="combobox"]')) {
    const host = trigger.parentElement,
      select = host.querySelector("select"),
      menu = host.querySelector(".dropdown-container");
    trigger.onclick = () => {
      const opened = trigger.getAttribute("aria-expanded") === "true";
      trigger.setAttribute("aria-expanded", String(!opened));
      menu.classList.toggle("dropdown-invisible", opened);
    };
    for (const li of menu.querySelectorAll("li[title]"))
      li.onclick = () => {
        select.replaceChildren(new w.Option(li.title, li.title, true, true));
        trigger.querySelector(".dropdown-text").textContent = li.title;
        trigger.setAttribute("aria-expanded", "false");
        menu.classList.add("dropdown-invisible");
      };
  }
  return {
    w,
    doc,
    reader: w.JobsControlFields.create(doc, () => doc.querySelector("form"), {
      write: true,
    }),
    close: () => w.close(),
  };
}

test("iCIMS candidate has one canonical date, optional titles, required military choices and native referral", async () => {
  const h = setup(
    choices("prefix", "Prefix") +
      choices("suffix", "Suffix") +
      choices("reserve", "Active Reservist", true) +
      choices("spouse", "Military Spouse", true) +
      date() +
      `<label>How did you hear about us?<select required><option value="">— Make a Selection —</option><option value="linkedin">LinkedIn</option></select></label>`,
  );
  try {
    const rows = h.reader.scan();
    assert.equal(rows.length, 6);
    for (const q of ["Prefix", "Suffix", "Availability"]) {
      const r = rows.find((r) => r.public.question === q);
      assert.equal(r.public.required, false);
      assert.equal(h.w.JobsControlFields.needsAnswer(r.public), false);
    }
    for (const q of ["Active Reservist", "Military Spouse"]) {
      const r = rows.find((r) => r.public.question === q);
      assert.equal(r.public.required, true);
      assert.equal(r.public.supported, true);
      assert.deepEqual(
        Array.from(await h.reader.readOptions(r), (o) => o.label),
        ["Yes", "No"],
      );
      assert.equal(r.node.getAttribute("aria-expanded"), "false");
      await h.reader.apply(r, "No");
    }
    const referral = h.reader
      .scan()
      .find((r) => r.public.question === "How did you hear about us?");
    assert.equal(referral.public.supported, true);
    await h.reader.apply(referral, "linkedin");
    assert.equal(referral.node.value, "linkedin");
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("date uses a complete profile date; rejects a name, incomplete date and impossible day before writing", async () => {
  const h = setup(date(true));
  try {
    const row = h.reader.scan()[0];
    assert.equal(row.public.question, "Availability");
    assert.equal(row.public.type, "date");
    assert.equal(row.public.required, true);
    assert.equal(row.public.filled, false);
    assert.equal(row.dateParts.length, 3);
    for (const answer of ["Example Person", "2027-05", "2027-02-30"])
      await assert.rejects(h.reader.apply(row, answer));
    assert.equal(row.dateParts[0].value, "0");
    assert.equal(row.dateParts[2].value, "");
    const known = h.w.JobsProfileAnswers.resolve(
      "Availability",
      { applicationData: { earliestStartDate: "2027-05-17" } },
      { inputType: "date" },
    );
    assert.equal(known.answer, "2027-05-17");
    assert.equal(
      h.w.JobsProfileAnswers.resolve(
        "Availability",
        { applicationData: { earliestStartDate: "2027-05-17" } },
        { inputType: "text" },
      ),
      null,
      "Generic free-form availability is not assumed to be a start date",
    );
    await h.reader.apply(row, known.answer);
    assert.equal(h.reader.scan()[0].raw, "2027-05-17");
    const year = row.dateParts[2];
    year.value = "Example Person";
    assert.equal(h.reader.scan()[0].public.invalid, true);
    assert.equal(h.reader.state().ready, false);
    year.value = "2027";
    row.node.closest(".iCIMS_FieldRow").classList.add("iCIMS_HasError");
    assert.equal(h.reader.state().phase, "complete-required");
    row.node.closest(".iCIMS_FieldRow").classList.remove("iCIMS_HasError");
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("empty and invalid iCIMS date cases export and replay without applicant values", () => {
  for (const invalid of [false, true]) {
    const h = setup(date(true));
    try {
      if (invalid) h.doc.querySelector("input").value = "Private Person";
      const rows = h.reader.scan(),
        report = {
          ats: "icims",
          startedAt: 1,
          events: [],
          fields: rows.map((r) => ({
            id: r.public.id,
            kind: r.public.type,
            component: r.public.component,
            required: r.public.required,
            hasValue: r.public.filled,
            invalid: r.public.invalid,
            completion: r.public.completion,
          })),
        };
      const data = h.w.JobsReproCase.capture({ report, rows, document: h.doc });
      assert.equal(data.fields.length, 1);
      assert(!JSON.stringify(data).includes("Private Person"));
      for (const result of replayCase(data))
        assert.deepEqual(result.actual, result.expected);
    } finally {
      h.close();
    }
  }
});

test("address cascades use their own collection and defer State until Country commits", async () => {
  const group = (index) =>
    `<fieldset class="iCIMS_CollectionGroup">${choices(index + "_country", "Country", true) + choices(index + "_state", "State/Province", true)}</fieldset>`;
  const h = setup(group(1) + group(2));
  try {
    for (const state of h.doc.querySelectorAll('select[id$="_state"]'))
      state.setAttribute("data-ddd-parent-link", "country");
    let rows = h.reader.scan();
    assert.equal(
      rows.filter((r) => h.w.JobsControlFields.needsAnswer(r.public)).length,
      2,
    );
    const country = rows.find((r) => r.node.id === "1_country_icimsDropdown");
    await h.reader.apply(country, "Yes");
    rows = h.reader.scan();
    assert.equal(
      rows.find((r) => r.node.id === "1_state_icimsDropdown").public
        .dependencyBlocked,
      false,
    );
    assert.equal(
      rows.find((r) => r.node.id === "2_state_icimsDropdown").public
        .dependencyBlocked,
      true,
    );
    assert.deepEqual(
      Array.from(
        rows.find((r) => r.node.id === "1_state_icimsDropdown").public
          .dependsOn,
      ),
      [country.public.id],
    );
  } finally {
    h.close();
  }
});

test("supplement runs the address cascade in order through the existing shared loop", async () => {
  const h = setup(
      `<fieldset class="iCIMS_CollectionGroup">${choices("country", "Country", true) + choices("state", "State/Province", true)}</fieldset>`,
    ),
    batches = [],
    profile = {};
  h.doc.getElementById("state").setAttribute("data-ddd-parent-link", "country");
  h.w.chrome.runtime.sendMessage = async (message) => {
    assert.equal(message.type, "jobs:tab-profile");
    return { data: { id: "fixture", profile } };
  };
  try {
    const done = await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      action: "fill",
      resolveAnswers: async (questions) => {
        batches.push(Array.from(questions, (q) => q.question));
        return questions.map((q, index) => ({
          index,
          answer: "Yes",
          source: "profile",
        }));
      },
    });
    assert.equal(done, true);
    assert.deepEqual(batches, [["Country"], ["State/Province"]]);
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("all iCIMS required gaps reach the shared answer pipeline with choices; optional fields never reach AI", async () => {
  const h = setup(
    choices("prefix", "Prefix") +
      choices("suffix", "Suffix") +
      choices("reserve", "Active Reservist", true) +
      choices("spouse", "Military Spouse", true) +
      choices("clearance", "Security Clearance", true, true) +
      date(true) +
      `<label>Middle Name<input></label><label>How did you hear about us?<select required><option value="">— Make a Selection —</option><option value="linkedin">LinkedIn</option></select></label>`,
  );
  const profile = { applicationData: { earliestStartDate: "2027-05-17" } },
    knownQuestions = [],
    aiQuestions = [];
  h.w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          aiQuestions.push(...message.fields);
          return {
            data: {
              answers: message.fields.map((f) =>
                f.question === "Security Clearance"
                  ? {
                      fieldId: f.fieldId,
                      state: "needs_input",
                      reason: "No confirmed clearance information",
                    }
                  : {
                      fieldId: f.fieldId,
                      state: "answer",
                      value:
                        f.question === "How did you hear about us?"
                          ? "linkedin"
                          : "No",
                      reason: "Explicit fixture answer",
                      source: "profile",
                      needsConfirmation: false,
                    },
              ),
            },
          };
        }
        return {};
      },
    },
  };
  try {
    const result = await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      action: "fill",
      resolveAnswers: async (questions) => {
        knownQuestions.push(...questions);
        const index = questions.findIndex((q) => q.question === "Availability");
        return index < 0
          ? []
          : [{ index, answer: "2027-05-17", source: "profile" }];
      },
    });
    assert.equal(result, false, "Unknown clearance remains visible in review");
    // Optional blanks reach only the rule pass (no rule for a middle name), never AI.
    assert.deepEqual(
      knownQuestions.map((q) => q.question).sort(),
      [
        "Active Reservist",
        "Availability",
        "How did you hear about us?",
        "Middle Name",
        "Military Spouse",
        "Prefix",
        "Suffix",
        "Security Clearance",
      ].sort(),
    );
    assert.deepEqual(
      aiQuestions.map((q) => q.question).sort(),
      [
        "Active Reservist",
        "How did you hear about us?",
        "Military Spouse",
        "Security Clearance",
      ].sort(),
    );
    assert(aiQuestions.every((q) => q.options.length > 0));
    assert.equal(
      h.doc.querySelector("label input:not(.iCIMS_Forms_YearInput)").value,
      "",
    );
    assert.equal(
      h.reader.scan().find((r) => r.public.question === "Availability").raw,
      "2027-05-17",
    );
    assert.equal(
      h.reader.scan().find((r) => r.public.question === "Security Clearance")
        .public.filled,
      false,
    );
    assert.equal(h.w.JobsAIReview.pending(), true);
  } finally {
    h.close();
  }
});
