import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { functionBlock, menuFixture } from "./helpers/menu-fixtures.mjs";
import { legacySelectFixture } from "./helpers/legacy-select-fixtures.mjs";
import { successfactorsFixture } from "./helpers/successfactors-fixture.mjs";
import { fixture as choiceFixture } from "./helpers/ats-choice-fixtures.mjs";
const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const rules =
  (await read("src/custom/option-match.js")) +
  "\n" +
  (await read("src/custom/profile-answers.js")) +
  "\n" +
  (await read("src/custom/form-pipeline.js"));
// A whole adapter module (its helper declarations as well).
const module = (site) => read("source/content/adapters/" + site + ".js");
const controls =
  (await read("src/custom/dom-wait.js")) +
  "\n" +
  (await read("src/custom/control-fields.js"));
const adapter = async (site, name) =>
  functionBlock(await read("source/content/adapters/" + site + ".js"), name);
function harness(html) {
  const w = new JSDOM("<form>" + html + "</form>", {
    url: "https://fixture.invalid/apply",
    runScripts: "outside-only",
  }).window;
  w.eval(rules + "\n" + controls);
  w.jobsFindXPath = (path) =>
    w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  return { w, doc: w.document, close: () => w.close() };
}
test("country, region and phone rules use known equivalents and never an unrelated first choice", () => {
  const h = harness(""),
    api = h.w.JobsProfileAnswers,
    match = (labels, spec) =>
      h.w.JobsOptionMatch.pick(labels, spec)?.label || null;
  try {
    assert.equal(
      match(["Canada", "United States"], api.countrySpec("USA")),
      "United States",
    );
    assert.equal(match(["Other", "Canada"], api.countrySpec("USA")), null);
    assert.equal(
      match(["Canada", "California"], api.regionSpec("CA", "United States")),
      "California",
    );
    assert.equal(
      match(["British Columbia", "California"], api.regionSpec("BC", "Canada")),
      "British Columbia",
    );
    assert.equal(match(["California"], api.regionSpec("CA", "Canada")), null);
    // No Profile phone type: the filling default is Mobile (or its Cell wording).
    assert.equal(
      match(["Home", "Mobile"], api.phoneTypeSpec(undefined)),
      "Mobile",
    );
    assert.equal(match(["Home", "Cell"], api.phoneTypeSpec("")), "Cell");
    assert.equal(match(["Home", "Cell"], api.phoneTypeSpec("Mobile")), "Cell");
    assert.equal(match(["Main", "Other"], api.phoneTypeSpec("Mobile")), null);
    for (const [question, profile, labels, expected] of [
      [
        "Country",
        { addressData: { country: "USA" } },
        ["United States"],
        "United States",
      ],
      [
        "State",
        { addressData: { country: "Canada", state: "ON" } },
        ["Ontario"],
        "Ontario",
      ],
      [
        "Phone type",
        { contactData: { phoneDeviceType: "Mobile" } },
        ["Cell"],
        "Cell",
      ],
    ])
      assert.equal(
        api.select(api.resolve(question, profile), labels),
        expected,
        question,
      );
  } finally {
    h.close();
  }
});
test("language matching is independent of display order and cannot infer fluency or native identity", () => {
  const h = harness(""),
    api = h.w.JobsProfileAnswers,
    pick = (value, labels, extra) =>
      h.w.JobsOptionMatch.pick(labels, api.languageSpec(value, extra))?.label ||
      null;
  try {
    for (const options of [
      ["Native", "Advanced", "Beginner"],
      ["Beginner", "Native", "Advanced"],
    ])
      assert.equal(pick("Advanced", options), "Advanced");
    assert.equal(
      pick("Intermediate", [
        "Elementary",
        "Limited working",
        "Professional working",
      ]),
      "Limited working",
    );
    assert.equal(
      pick("Full Professional Proficiency", ["High", "Low"]),
      "High",
    );
    assert.equal(pick("Native", ["Fluent", "Beginner"]), "Fluent");
    assert.equal(pick("Advanced", ["Fluent", "Beginner"]), null);
    assert.equal(pick("Fluent", ["Native"]), null);
    assert.equal(pick("", ["Elementary"]), null);
    assert.equal(pick("Advanced", ["1", "2", "3", "4"]), null);
    const profile = {
      languageData: [{ language: "English", proficiency: "Intermediate" }],
    };
    assert.equal(
      api.select(api.resolve("English proficiency", profile), [
        "Elementary",
        "Limited working",
      ]),
      "Limited working",
    );
  } finally {
    h.close();
  }
});
test("semantic text writes use the labelled field and preserve existing values", async () => {
  const h = harness(
    '<label for="state">State</label><input id="state"><input id="unlabelled"><label>Password<input type="password" id="password"></label>',
  );
  try {
    const spec = h.w.JobsProfileAnswers.regionSpec("CA", "USA"),
      node = h.doc.getElementById("state");
    assert(await h.w.JobsControlFields.chooseSpec(node, spec));
    assert.equal(node.value, "CA");
    await h.w.JobsControlFields.chooseSpec(
      node,
      h.w.JobsProfileAnswers.regionSpec("NY", "USA"),
    );
    assert.equal(node.value, "CA");
    assert.equal(
      await h.w.JobsControlFields.chooseSpec(
        h.doc.getElementById("password"),
        spec,
      ),
      null,
    );
  } finally {
    h.close();
  }
});
for (const site of ["adp", "bamboohr", "dayforce"])
  test(`${site}: shared region specification commits through the actual menu`, async () => {
    const h = menuFixture(site, {
      labels: ["Alabama", "California"],
      required: true,
    });
    h.w.eval(rules);
    try {
      const target = h.doc.getElementById("target");
      assert(
        await h.w.JobsControlFields.chooseSpec(
          target,
          h.w.JobsProfileAnswers.regionSpec("CA", "United States"),
        ),
      );
      assert.equal(
        h.doc.getElementById("target-native").selectedOptions[0].text,
        "California",
      );
      assert(!h.doc.getElementById("other-native").value);
      await h.w.JobsControlFields.chooseSpec(
        target,
        h.w.JobsProfileAnswers.regionSpec("AL", "USA"),
      );
      assert.equal(
        h.doc.getElementById("target-native").selectedOptions[0].text,
        "California",
      );
    } finally {
      h.close();
    }
  });
for (const site of ["pinpoint", "rippling"])
  test(`${site}: container resolves one actual country control and commits its observed alias`, async () => {
    const h = legacySelectFixture(site, {
        options: ["Canada", "United States"],
      }),
      w = h.window;
    w.eval(rules);
    try {
      assert(
        await w.JobsControlFields.chooseSpec(
          h.canonical.parentElement,
          w.JobsProfileAnswers.countrySpec("USA"),
        ),
      );
      assert.equal(
        w.JobsLegacySelectControls.value(h.canonical),
        "United States",
      );
    } finally {
      h.close();
    }
  });
test("SuccessFactors country resolves a paged input inside the field container", async () => {
  const h = successfactorsFixture({
      pages: [
        [
          "Canada",
          ...Array.from({ length: 99 }, (_, i) => "Other country " + i),
        ],
        ["United States"],
      ],
      question: "Country",
    }),
    w = h.window;
  w.eval(rules);
  try {
    assert(
      await w.JobsControlFields.chooseSpec(
        h.doc.querySelector(".fieldComponentInput"),
        w.JobsProfileAnswers.countrySpec("USA"),
      ),
    );
    assert.equal(h.input.value, "United States");
  } finally {
    h.close();
  }
});
test("Phenom language levels wait for their options and are chosen by meaning, including reversed order", async () => {
  for (const labels of [
    ["Beginner", "Intermediate", "Advanced"],
    ["Advanced", "Beginner", "Intermediate"],
    ["1", "2", "3"],
  ]) {
    const h = harness(
      '<select id="language"><option value="">Select</option>' +
        labels
          .map((label, i) => `<option value="${i + 1}">${label}</option>`)
          .join("") +
        "</select>",
    );
    h.w.eval(await module("phenom"));
    try {
      await h.w.phenomOptionsLoaded('//*[@id="language"]');
      await h.w.JobsFormPipeline.bind([
        {
          name: "level",
          find: "#language",
          answer: h.w.JobsProfileAnswers.languageSpec("Advanced"),
        },
      ]);
      assert.equal(
        h.doc.querySelector("select").selectedOptions[0].text,
        labels.includes("Advanced") ? "Advanced" : "Select",
      );
    } finally {
      h.close();
    }
  }
});

test("Paylocity actual education adapter does not infer graduation or vocational schooling from degree/date", async () => {
  const h = await choiceFixture("paylocity-dropdown");
  h.w.eval(rules);
  const group = h.doc.createElement("div");
  group.className = "education-history-group";
  h.control.before(group);
  group.append(h.control);
  h.control.id = "educationHistory.degreeId.0";
  h.control.setAttribute("aria-label", "Degree");
  h.control.querySelectorAll("li")[0].textContent = "Bachelor";
  h.control.querySelectorAll("li")[1].textContent = "Master";
  const add = h.doc.createElement("button");
  add.setAttribute("data-automation-id", "btnAddEducationHistory");
  h.root.append(add);
  Object.assign(h.w, { jobsFormatProfileMonth: () => "05/2020" });
  h.w.eval(await module("paylocity"));
  try {
    await h.w.paylocityFillEducationHistory([
      {
        school: "University",
        degree: "Bachelor of Arts",
        fieldOfStudy: "Physics",
        endDate: "2020-05",
      },
    ]);
    assert.equal(h.api.value(h.control), "Bachelor");
    assert.equal(
      h.w.JobsProfileAnswers.resolve("Have you graduated?", {
        educationData: [{ endDate: "2020-05" }],
      }).answer,
      null,
    );
    const api = h.w.JobsProfileAnswers,
      pick = (entry, labels) =>
        h.w.JobsOptionMatch.pick(labels, api.educationTypeSpec(entry))?.label ||
        null;
    assert.equal(
      pick({ degree: "Associate's" }, [
        "Vocational College",
        "College / University",
      ]),
      "College / University",
    );
    assert.equal(
      pick({ degree: "PhD" }, ["Specialized", "Graduate School"]),
      "Graduate School",
    );
    assert.equal(pick({ degree: "" }, ["Other"]), null);
  } finally {
    h.close();
  }
});

test("Phenom personal form shares country, region and phone choices with supplementation", async () => {
  const choice = (id, question, labels) =>
    `<label>${question}<select id="${id}"><option value="">Select</option>${labels.map((label, i) => `<option value="${i + 1}">${label}</option>`).join("")}</select></label>`;
  const h = harness(
    choice("country", "Country", ["Canada", "United States"]) +
      choice("region", "State", ["New York", "California"]) +
      choice("deviceType", "Phone type", ["Home", "Cell"]),
  );
  const profile = {
    nameData: {},
    contactData: { phoneDeviceType: "Mobile" },
    addressData: { country: "USA", state: "CA" },
    websiteData: {},
  };
  Object.assign(h.w, {
    jobsUploadResume: () => null,
    jobsLowercaseXPath: (value) =>
      `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
  });
  h.w.eval(await module("phenom"));
  try {
    await h.w.phenomFillPersonalInformation(profile);
    assert.deepEqual(
      [...h.doc.querySelectorAll("select")].map(
        (node) => node.selectedOptions[0].text,
      ),
      ["United States", "California", "Cell"],
    );
    for (const row of h.w.JobsControlFields.create(h.doc).scan()) {
      const resolved = h.w.JobsProfileAnswers.resolve(
        row.public.question,
        profile,
        row.public,
      );
      assert.equal(
        h.w.JobsProfileAnswers.select(
          resolved,
          row.public.options.map((item) => item.label),
        ),
        row.node.selectedOptions[0].text,
      );
    }
  } finally {
    h.close();
  }
});
