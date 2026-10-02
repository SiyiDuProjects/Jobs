import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { icimsFixture } from "./helpers/icims-fixture.mjs";
const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "control-fields",
    "icims-controls",
    "form-pipeline",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const source = await read("source/content/adapters/icims.js");
const select = (id, options) =>
  `<label for="${id}">${id}</label><select id="${id}"><option value="">Select</option>${options.map((value, i) => `<option value="${i + 1}">${value}</option>`).join("")}</select>`;
function fixture() {
  const html =
    "<h2>Education</h2><section><fieldset><legend><span>Education (1)</span></legend>" +
    select("CandProfileFields.EducationStartDate_Month", [
      "Jan",
      "Feb",
      "May",
    ]) +
    select("CandProfileFields.EducationStartDate_Date", ["1", "28", "29"]) +
    select("CandProfileFields.GraduationDate_Month", ["May", "December"]) +
    select("CandProfileFields.GraduationDate_Date", ["1", "31"]) +
    select("CandProfileFields.IsGraduated", ["Yes", "No"]) +
    "</fieldset></section>";
  const w = new JSDOM(html, {
    url: "https://fixture.icims.com/jobs/1/apply",
    runScripts: "outside-only",
  }).window;
  scripts.forEach((code) => w.eval(code));
  w.jobsFindXPath = (path) =>
    w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  w.eval(source);
  return {
    w,
    doc: w.document,
    selected: (id) =>
      w.document.getElementById("CandProfileFields." + id).selectedOptions[0]
        .text,
    close: () => w.close(),
  };
}
test("date specifications require real day precision and share numeric/name month equivalents", () => {
  const h = fixture(),
    api = h.w.JobsProfileAnswers;
  try {
    assert.equal(api.datePartSpec("2027-05", "day"), null);
    assert.equal(api.datePartSpec("2027-02-29", "day"), null);
    assert.equal(api.datePartSpec("2028-02-29", "day").answer, "29");
    for (const label of ["February", "Feb", "02", "2"])
      assert.equal(
        h.w.JobsOptionMatch.pick([label], api.datePartSpec("2028-02", "month"))
          .label,
        label,
      );
  } finally {
    h.close();
  }
});
test("iCIMS actual education form never fabricates the first day or graduation from a past month", async () => {
  for (const startDate of ["2028-02", "2028-02-29"]) {
    const h = fixture();
    try {
      await h.w.icimsFillEducationHistory([
        { degree: "Bachelor's", startDate, endDate: "2020-05" },
      ]);
      assert.equal(h.selected("EducationStartDate_Month"), "Feb");
      assert.equal(
        h.selected("EducationStartDate_Date"),
        startDate.length === 10 ? "29" : "Select",
      );
      assert.equal(h.selected("GraduationDate_Month"), "May");
      assert.equal(h.selected("GraduationDate_Date"), "Select");
      assert.equal(h.selected("IsGraduated"), "Select");
    } finally {
      h.close();
    }
  }
});

test("iCIMS successful degree choice still fills major and GPA and never fabricates a missing start date", async () => {
  const h = icimsFixture({
      labels: ["Bachelor of Arts", "Bachelor of Science"],
    }),
    w = h.w;
  try {
    for (const code of await Promise.all(
      ["option-match", "profile-answers", "form-pipeline"].map((name) =>
        read("src/custom/" + name + ".js"),
      ),
    ))
      w.eval(code);
    const section = h.doc.createElement("section");
    section.innerHTML =
      "<h2>Education</h2><fieldset><legend><span>Education (1)</span></legend>" +
      '<label for="CandProfileFields.GPA">GPA</label><input id="CandProfileFields.GPA">' +
      select("CandProfileFields.EducationStartDate_Month", ["Jan", "Feb"]) +
      "</fieldset>";
    h.doc.body.append(section);
    section
      .querySelector("fieldset")
      .append(h.doc.getElementById("state-field"));
    h.select.id = "CandProfileFields.Degree";
    h.trigger.id = "CandProfileFields.Degree_icimsDropdown";
    h.input.parentElement.id = "CandProfileFields.Degree_icimsDropdown_ctnr";
    w.eval(source);
    // A successful degree must not short-circuit the later bindings, and a
    // missing start date writes no start-date part.
    await w.icimsFillEducationHistory([
      {
        school: "Example University",
        degree: "Bachelor of Arts",
        fieldOfStudy: "Physics",
        gpa: "3.5",
      },
    ]);
    assert.equal(h.select.value, "Bachelor of Arts");
    assert.equal(h.doc.getElementById("CandProfileFields.GPA").value, "3.5");
    assert.equal(
      h.doc.getElementById("CandProfileFields.EducationStartDate_Month").value,
      "",
    );
  } finally {
    h.close();
  }
});

test("highest-school selection uses common degree levels and abstains on equal or unknown levels", () => {
  const h = fixture(),
    api = h.w.JobsProfileAnswers;
  try {
    assert.equal(api.highestEducation([]), null);
    const ba = { school: "BA school", degree: "Bachelor of Arts" },
      bs = { school: "BS school", degree: "Bachelor of Science" },
      ms = { school: "Graduate school", degree: "Master of Science" };
    assert.equal(api.highestEducation([ba, ms]), ms);
    assert.equal(api.highestEducation([ba, bs]), null);
    assert.equal(
      api.highestEducation([ba, { degree: "Custom qualification" }]),
      null,
    );
  } finally {
    h.close();
  }
});
