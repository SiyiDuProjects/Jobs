import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { functionBlock, menuFixture } from "./helpers/menu-fixtures.mjs";
import { fixture as choiceFixture } from "./helpers/ats-choice-fixtures.mjs";
import { legacySelectFixture } from "./helpers/legacy-select-fixtures.mjs";
import { successfactorsFixture } from "./helpers/successfactors-fixture.mjs";
import { resolverWith } from "./helpers/answer-resolver.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
// The rules and the one write path bindings use (JobsFormPipeline).
const rules =
  (await read("src/custom/option-match.js")) +
  "\n" +
  (await read("src/custom/profile-answers.js")) +
  "\n" +
  (await read("src/custom/form-pipeline.js"));
const controls =
  (await read("src/custom/dom-wait.js")) +
  "\n" +
  (await read("src/custom/control-fields.js"));
const adapter = async (site, name) =>
  functionBlock(await read("source/content/adapters/" + site + ".js"), name);
// A whole adapter module (its helper declarations as well).
const module = (site) => read("source/content/adapters/" + site + ".js");
// One run on a fixture page: the adapter's fill (if any), then the rules.
const runtime = await Promise.all(
  [
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
async function runStep(w, root, current, fill) {
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "fixture", profile: current } }
          : {
              data: {
                answers: message.fields.map((field) => ({
                  fieldId: field.fieldId,
                  state: "needs_input",
                  reason: "fixture",
                })),
              },
            },
    },
  };
  for (const code of runtime) w.eval(code);
  w.eval(resolverWith("[]"));
  return w.JobsAutomatic.advance({
    root,
    profile: current,
    action: "fill",
    resolveAnswers: w.JobsAnswerResolver.resolve,
    fill: fill && (() => fill()),
  });
}
const employment = {
  gender: "Female",
  ethnicity: "Asian",
  hispanicOrLatino: false,
  disability: false,
};
function harness(html, url = "https://fixture.invalid/apply") {
  const dom = new JSDOM("<form>" + html + "</form>", {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window;
  w.eval(rules + "\n" + controls);
  w.jobsFindXPath = (path) =>
    w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  w.jobsFindAllXPath = (path) => {
    const found = w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: found.snapshotLength }, (_, i) =>
      found.snapshotItem(i),
    );
  };
  Object.assign(w, {
    jobsFillControlAnswer: async () => null,
    jobsResolveControlAnswer: async () => null,
    jobsWaitForCssNodes: async () => [],
    jobsDelay: async () => {},
    jobsSetChecked: async () => null,
    jobsWriteText: async () => null,
    jobsFormatFullName: () => "",
  });
  return { w, doc: w.document, close: () => w.close() };
}
const select = (attrs, labels) =>
  `<select ${attrs}><option value="">Select...</option>${labels.map((label, i) => `<option value="v${i}">${label}</option>`).join("")}</select>`;

for (const site of ["jazzhr", "tesla"])
  test(`${site}: actual native EEO adapter commits shared labels and preserves existing choices`, async () => {
    const html =
      site === "jazzhr"
        ? select('id="resumator-eeo_gender-value"', [
            "Male",
            "Female",
            "Decline to answer",
          ]) +
          select('id="resumator-eeo_race-value"', [
            "Asian, not Hispanic or Latino",
            "White, not Hispanic or Latino",
            "Decline to answer",
          ])
        : select('name="eeo.eeoGender"', [
            "Male",
            "Female",
            "I choose not to disclose",
          ]) +
          select('name="eeo.eeoRaceEthnicity"', [
            "Asian",
            "White",
            "I choose not to disclose",
          ]) +
          select('name="eeo.eeoDisabilityStatus"', [
            "Yes, I have a disability",
            "No, I do not have a disability",
            "I do not wish to answer",
          ]);
    const h = harness(html);
    h.w.eval(await adapter(site, site + "FillDisclosures"));
    const fill = (data) =>
      h.w[site + "FillDisclosures"](
        site === "tesla" ? { employmentData: data, nameData: {} } : data,
      );
    try {
      await fill(employment);
      const values = () =>
        [...h.doc.querySelectorAll("select")].map(
          (node) => node.selectedOptions[0].text,
        );
      assert.deepEqual(
        values(),
        site === "jazzhr"
          ? ["Female", "Asian, not Hispanic or Latino"]
          : ["Female", "Asian", "No, I do not have a disability"],
      );
      const before = values();
      await fill({
        ...employment,
        gender: "Male",
        ethnicity: "White",
        disability: true,
      });
      assert.deepEqual(values(), before);
      for (const node of h.doc.querySelectorAll("select")) node.value = "";
      await fill({});
      assert(
        [...h.doc.querySelectorAll("select")].every((node) => !node.value),
        "absent facts stay blank",
      );
    } finally {
      h.close();
    }
  });

test("Breezy native groups use visible wording without sharing another question or form", async () => {
  const questions = [
    ["gender", ["Male", "Female", "Decline to answer"]],
    ["race", ["Asian", "White", "Decline to answer"]],
    ["disability", ["Yes", "No", "I do not wish to answer"]],
  ];
  const html = questions
    .map(
      ([name, labels]) =>
        `<fieldset><legend>${name}</legend>${labels.map((label, i) => `<label><input id="${name}_${i}" name="${name}" type="radio" value="${label}">${label}</label>`).join("")}</fieldset>`,
    )
    .join("");
  const h = harness(html, "https://fixture.breezy.hr/apply");
  h.w.eval(await adapter("breezy", "breezyFillDisclosures"));
  try {
    await h.w.breezyFillDisclosures(employment);
    assert.deepEqual(
      [...h.doc.querySelectorAll("input:checked")].map((node) => node.value),
      ["Female", "Asian", "No"],
    );
  } finally {
    h.close();
  }
});

test("Dayforce EEO menu uses the real trigger and committed backing value", async () => {
  const h = menuFixture("dayforce", {
    labels: ["Female", "Male", "Decline to answer"],
    required: true,
  });
  h.w.eval(rules);
  h.doc
    .getElementById("target")
    .parentElement.setAttribute("test-id", "personal-info-gender-dropdown");
  h.w.eval(await adapter("dayforce", "dayforceFillEqualOpportunity"));
  try {
    await h.w.dayforceFillEqualOpportunity({ employmentData: employment });
    assert.equal(
      h.doc.getElementById("target-native").selectedOptions[0].text,
      "Female",
    );
    assert(!h.doc.getElementById("other-native").value);
  } finally {
    h.close();
  }
});

test("Dayforce disability stays inside the labelled native group", async () => {
  const h = harness(
    '<fieldset><label><input type="radio" name="d" value="yes">Yes, I have a disability</label><label><input type="radio" name="d" value="no">No, I do not have a disability</label></fieldset><label><input type="radio" name="unrelated">No</label>',
  );
  h.w.eval(await adapter("dayforce", "dayforceFillDisability"));
  try {
    await h.w.dayforceFillDisability({ employmentData: employment });
    assert.deepEqual(
      [...h.doc.querySelectorAll("input:checked")].map((node) => node.value),
      ["no"],
    );
  } finally {
    h.close();
  }
});

test("Paylocity EEO chooses through its real custom dropdown component", async () => {
  const h = await choiceFixture("paylocity-dropdown");
  h.w.eval(rules);
  h.control.id = "acknowledgements.eeoGender";
  h.control.setAttribute("aria-label", "Gender");
  const options = h.control.querySelectorAll("li");
  options[0].textContent = "Female";
  options[1].textContent = "Male";
  h.w.jobsResolveControlAnswer = async () => null;
  h.w.eval(await adapter("paylocity", "paylocityFillDisclosures"));
  try {
    await h.w.paylocityFillDisclosures(employment);
    assert.equal(h.api.value(h.control), "Female");
  } finally {
    h.close();
  }
});

test("BambooHR disclosure opens its menu instead of writing its hidden select directly", async () => {
  const h = menuFixture("bamboohr", { labels: ["Male", "Female", "Decline"] });
  h.w.eval(rules);
  h.doc.getElementById("target-native").name = "genderId";
  h.w.jobsFillControlAnswer = async () => null;
  h.w.eval(await adapter("bamboohr", "bamboohrFillDisclosures"));
  try {
    await h.w.bamboohrFillDisclosures(employment);
    assert.equal(
      h.doc.getElementById("target-native").selectedOptions[0].text,
      "Female",
    );
    assert(h.trace.some((event) => event === "target:option:click:Female"));
  } finally {
    h.close();
  }
});

for (const site of ["pinpoint", "rippling"])
  test(`${site}: actual disclosure uses committed search control value`, async () => {
    const h = legacySelectFixture(site, {
        options: ["Male", "Female", "I choose not to disclose"],
      }),
      w = h.window;
    w.eval(rules);
    w.jobsFillControlAnswer = async () => null;
    w.jobsFindXPath = (path) =>
      h.doc.evaluate(
        path,
        h.doc,
        null,
        w.XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
    if (site === "pinpoint") {
      const field = h.canonical.parentElement,
        label = field.previousElementSibling,
        wrapper = h.doc.createElement("div");
      wrapper.id = "application_form_equality_monitoring_Gender";
      field.before(wrapper);
      wrapper.append(label, field);
      wrapper.querySelector("label").textContent = "Gender";
    } else
      h.input
        .closest("[data-testid]")
        .setAttribute("data-testid", "eeoc.gender");
    w.eval(await adapter(site, site + "FillDisclosures"));
    try {
      await w[site + "FillDisclosures"](employment);
      assert.equal(h.controls.value(h.canonical), "Female");
    } finally {
      h.close();
    }
  });

for (const [gender, label, code] of [
  ["Female", "Female", "f"],
  ["I choose not to disclose", "Opt Out", "o"],
])
  test(`iCIMS EEO search commits visible and hidden values for ${label}`, async () => {
    const h = harness(
      '<div><label for="CandProfileFields.Gender">Gender*</label><select id="CandProfileFields.Gender" icimsdropdown-enabled="1" style="display:none"><option value="-1">Select</option><option value="m">Male</option><option value="f">Female</option><option value="o">Opt Out</option></select><a role="combobox" id="CandProfileFields.Gender_icimsDropdown" aria-label="Gender" aria-expanded="false"><span class="dropdown-text">Select</span></a><div class="dropdown-container"><input><ul></ul></div></div>',
      "https://fixture.icims.com/jobs/1/candidate",
    );
    const w = h.w,
      trigger = h.doc.querySelector("a"),
      search = h.doc.querySelector("input"),
      backing = h.doc.querySelector("select"),
      list = h.doc.querySelector("ul");
    w.eval(await read("src/custom/icims-controls.js"));
    w.jobsWaitForXPathNodesWithRetry = async () => [];
    trigger.onclick = () =>
      trigger.setAttribute(
        "aria-expanded",
        String(trigger.getAttribute("aria-expanded") !== "true"),
      );
    search.oninput = () => {
      if (search.value !== label) return;
      const li = h.doc.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("dropdown-index", "1");
      li.textContent = label;
      li.title = label;
      li.onclick = () => {
        backing.value = code;
        trigger.querySelector("span").textContent = label;
        trigger.setAttribute("aria-expanded", "false");
        search.value = "";
      };
      list.replaceChildren(li);
    };
    w.eval(await adapter("icims", "icimsFillDisclosures"));
    try {
      await w.icimsFillDisclosures({ ...employment, gender });
      assert.equal(backing.value, code);
      assert.equal(w.JobsIcimsControls.value(trigger), label);
      backing.value = "-1";
      trigger.querySelector("span").textContent = "Select";
      list.replaceChildren();
      // The shared entrance passes the rule's spec; the component reads this list for it.
      const options = await w.JobsIcimsControls.readOptions(
        trigger,
        () => true,
        {
          optionSpec: w.JobsProfileAnswers.eeoSpec(
            "gender",
            { ...employment, gender },
            { knownQuestion: true },
          ),
        },
      );
      assert.deepEqual(
        Array.from(options, (option) => option.label),
        [label],
        "supplement searches the same site wording",
      );
      assert.equal(
        backing.value,
        "-1",
        "reading candidates does not select them",
      );
    } finally {
      h.close();
    }
  });

test("ADP semantic gender uses its menu component and preserves its committed value", async () => {
  const h = menuFixture("adp", {
    labels: ["Man", "Woman", "Prefer not to say"],
  });
  h.w.eval(rules);
  h.doc.querySelector("label").innerHTML = "<text>Gender</text>";
  const trigger = h.doc.getElementById("target"),
    wrapper = h.doc.createElement("div");
  trigger.before(wrapper);
  wrapper.append(trigger);
  h.w.jobsFillControlAnswer = async () => null;
  h.w.jobsSetChecked = async () => null;
  h.w.eval(await adapter("adp", "adpFillDisclosures"));
  try {
    await h.w.adpFillDisclosures(employment);
    assert.equal(
      h.doc.getElementById("target-native").selectedOptions[0].text,
      "Woman",
    );
  } finally {
    h.close();
  }
});

test("ADP paired opt-out respects an existing ethnicity selection", async () => {
  const h = menuFixture("adp", {
    labels: ["Hispanic or Latino", "Not Hispanic or Latino"],
  });
  h.w.eval(rules);
  h.doc.querySelector("label").textContent = "Ethnicity";
  const trigger = h.doc.getElementById("target"),
    wrapper = h.doc.createElement("div");
  trigger.before(wrapper);
  wrapper.append(trigger);
  h.doc.body.insertAdjacentHTML(
    "beforeend",
    '<div id="enthinicityAndRaceId"><label><input type="checkbox">Prefer not to say</label></div>',
  );
  h.w.jobsFillControlAnswer = async () => null;
  h.w.jobsSetChecked = async (selector) =>
    h.w.JobsControlFields.writeChecked(h.doc.querySelector(selector), true);
  h.w.eval(await adapter("adp", "adpFillDisclosures"));
  try {
    await h.w.adpFillDisclosures(employment);
    assert.equal(
      h.doc.getElementById("target-native").selectedOptions[0].text,
      "Not Hispanic or Latino",
    );
    await h.w.adpFillDisclosures({ ethnicity: "I choose not to disclose" });
    assert.equal(
      h.doc.querySelector("#enthinicityAndRaceId input").checked,
      false,
    );
    assert.equal(
      h.doc.getElementById("target-native").selectedOptions[0].text,
      "Not Hispanic or Latino",
    );
  } finally {
    h.close();
  }
});

test("Jobvite numeric radio values are selected from labels, and unrelated questions are untouched", async () => {
  const h = harness(
    '<fieldset><legend>Gender</legend><label><input name="gender" type="radio" value="1">Male</label><label><input name="gender" type="radio" value="2">Female</label></fieldset><fieldset><legend>Race / ethnicity</legend>' +
      select('name="input-race"', [
        "Asian",
        "White",
        "Decline to Self Identify",
      ]) +
      '</fieldset><label><input name="unrelated" type="checkbox">Yes</label>',
  );
  h.w.jobsFormatToday = () => "";
  h.w.eval(await adapter("jobvite", "jobviteFillDisclosures"));
  try {
    await h.w.jobviteFillDisclosures({
      employmentData: employment,
      nameData: {},
    });
    assert.equal(h.doc.querySelector("input:checked").value, "2");
    assert.equal(
      h.doc.querySelector("select").selectedOptions[0].text,
      "Asian",
    );
    assert.equal(h.doc.querySelector('[name="unrelated"]').checked, false);
  } finally {
    h.close();
  }
});

test("Phenom split ethnicity and race use separate known facts through native options", async () => {
  const h = harness(
    select('id="ethnicity"', ["Hispanic or Latino", "Not Hispanic or Latino"]) +
      select('id="race"', ["Asian", "White"]) +
      select('id="gender"', ["Male", "Female"]) +
      select('id="disabilities"', ["Yes", "No", "I do not wish to answer"]),
  );
  h.w.jobsLowercaseXPath = (value) =>
    `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  h.w.eval(await adapter("phenom", "phenomFillDisclosuresAndAgreements"));
  try {
    await h.w.phenomFillDisclosuresAndAgreements({
      employmentData: employment,
      nameData: {},
    });
    assert.deepEqual(
      [...h.doc.querySelectorAll("select")].map(
        (node) => node.selectedOptions[0].text,
      ),
      ["Not Hispanic or Latino", "Asian", "Female", "No"],
    );
  } finally {
    h.close();
  }
});

test("Phenom disability reads the adjacent option caption instead of an encoded value", async () => {
  const h = harness(
    '<fieldset><input id="disability.yes" name="disability" type="radio" value="code-1"><span>Yes, I have a disability</span><input id="disability.no" name="disability" type="radio" value="code-2"><span>No, I do not have a disability</span><input id="disability.decline" name="disability" type="radio" value="code-3"><span>I do not wish to answer</span></fieldset>',
  );
  h.w.jobsLowercaseXPath = (value) =>
    `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  h.w.eval(await adapter("phenom", "phenomFillDisclosuresAndAgreements"));
  try {
    await h.w.phenomFillDisclosuresAndAgreements({
      employmentData: employment,
      nameData: {},
    });
    assert.equal(h.doc.querySelector("input:checked")?.value, "code-2");
  } finally {
    h.close();
  }
});

test("UltiPro decline checkbox is a rule decision and never replaces an existing select answer", async () => {
  const h = harness(
    select('data-automation="country-questions-gender"', ["Male", "Female"]) +
      '<label><input type="checkbox" data-automation="gender-decline-checkbox">Prefer not to say</label>',
  );
  h.w.jobsSetChecked = async (path) =>
    h.w.JobsControlFields.writeChecked(h.w.jobsFindXPath(path), true);
  h.w.eval(await adapter("ultipro", "ultiproFillDisclosures"));
  try {
    await h.w.ultiproFillDisclosures({ gender: "I choose not to disclose" });
    assert.equal(h.doc.querySelector("input").checked, true);
    h.doc.querySelector("input").checked = false;
    h.doc.querySelector("select").value = "v0";
    await h.w.ultiproFillDisclosures({ gender: "I choose not to disclose" });
    assert.equal(h.doc.querySelector("input").checked, false);
    assert.equal(h.doc.querySelector("select").value, "v0");
  } finally {
    h.close();
  }
});

test("TikTok EEO commits an exact semantic choice from the virtual disclosure list", async () => {
  const h = await choiceFixture("tiktok-disclosure");
  h.w.eval(rules);
  const box = h.doc.createElement("div");
  box.setAttribute("data-form-field-i18n-name", "gender");
  box.append(...h.root.children);
  h.root.append(box);
  h.control.setAttribute("aria-label", "Gender");
  h.doc.getElementById("option-0").querySelector("span").textContent = "Woman";
  h.doc.getElementById("option-1").querySelector("span").textContent = "Man";
  h.w.eval(await adapter("tiktok", "tiktokFillDisclosures"));
  try {
    await h.w.tiktokFillDisclosures({ employmentData: employment });
    assert.equal(h.api.value(h.control), "Woman");
  } finally {
    h.close();
  }
});

test("SuccessFactors EEO reads all pages before selecting the semantic option", async () => {
  const h = successfactorsFixture({
      pages: [
        [
          "Male",
          ...Array.from({ length: 99 }, (_, i) => "Unrelated option " + i),
        ],
        ["Female", "Prefer not to say"],
      ],
    }),
    w = h.window;
  w.eval(rules);
  w.jobsFindXPath = (path) =>
    h.doc.evaluate(
      path,
      h.doc,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  w.jobsLowercaseXPath = (value) =>
    `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  Object.assign(w, { jobsFormatFullName: () => "" });
  const field = h.doc.getElementById("field"),
    label = field.querySelector("label");
  label.textContent = "Gender";
  const section = h.doc.createElement("div");
  section.id = "sectionContent";
  const header = h.doc.createElement("div");
  header.innerHTML = '<button class="topBar">Job Questions</button>';
  field.before(header, section);
  section.append(field);
  w.eval(await module("successfactors"));
  try {
    await w.successfactorsFillJobQuestions({
      employmentData: employment,
      nameData: {},
    });
    assert.equal(h.controls.value(h.input), "Female");
  } finally {
    h.close();
  }
});

for (const site of ["successfactors", "tiktok"])
  for (const answer of ["Yes", "No"])
    test(`${site}: the rules' sponsorship answer commits through the actual component (${answer})`, async () => {
      const h =
        site === "successfactors"
          ? successfactorsFixture({
              pages: [["No", "Yes"]],
              question: "Do you currently require sponsorship?",
            })
          : await choiceFixture("tiktok-disclosure");
      const w = h.window || h.w,
        doc = h.doc;
      w.eval(rules);
      w.eval(resolverWith("[]"));
      w.jobsFindAllXPath = (path) => {
        const found = doc.evaluate(
          path,
          doc,
          null,
          w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        return Array.from({ length: found.snapshotLength }, (_, i) =>
          found.snapshotItem(i),
        );
      };
      Object.assign(w, {
        jobsFormatFullName: () => "",
        jobsLowercaseXPath: (value) =>
          `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
      });
      w.jobsFindXPath = (path) =>
        doc.evaluate(
          path,
          doc,
          null,
          w.XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
      if (site === "successfactors") {
        const field = doc.getElementById("field"),
          section = doc.createElement("div"),
          header = doc.createElement("div");
        section.id = "sectionContent";
        header.innerHTML = '<button class="topBar">Job Questions</button>';
        field.before(header, section);
        section.append(field);
      } else {
        const box = doc.createElement("div");
        box.setAttribute("data-form-field-i18n-name", "sponsorship");
        box.append(...h.root.children);
        h.root.append(box);
        h.control.setAttribute(
          "aria-label",
          "Do you currently require sponsorship?",
        );
        doc.getElementById("option-0").querySelector("span").textContent = "No";
        doc.getElementById("option-1").querySelector("span").textContent =
          "Yes";
      }
      w.eval(await module(site));
      const current = {
        addressData: { country: "United States" },
        employmentData: {},
        nameData: {},
        applicationData: { sponsorshipNow: answer === "Yes" },
      };
      try {
        await runStep(
          w,
          doc.querySelector("form") || doc.body,
          current,
          site === "successfactors"
            ? () => w.successfactorsFillJobQuestions(current)
            : null,
        );
        assert.equal(
          site === "successfactors"
            ? h.controls.value(h.input)
            : h.api.value(h.control),
          answer,
        );
      } finally {
        h.close();
      }
    });

test("Eightfold EEO groups resolve through the same question pipeline as supplementation", async () => {
  const h = await choiceFixture("eightfold-choice");
  h.w.eval(rules);
  h.w.eval(resolverWith("[]"));
  h.doc.getElementById("question").textContent = "Gender";
  h.control.setAttribute("aria-label", "Gender");
  h.doc.getElementById("option-0").textContent = "Female";
  h.doc.getElementById("option-1").textContent = "Male";
  try {
    await runStep(h.w, h.root, { employmentData: employment }, null);
    assert.deepEqual(
      [...h.doc.querySelectorAll("input")].map((node) => node.checked),
      [true, false],
    );
  } finally {
    h.close();
  }
});

test("Eightfold alternate application keeps its own combobox protocol for semantic EEO writes", async () => {
  const h = await choiceFixture("eightfold-combobox");
  h.w.eval(rules);
  h.control.closest("[data-test-id]").setAttribute("data-test-id", "gender");
  h.control.setAttribute("aria-label", "Gender");
  h.doc.getElementById("option-0").textContent = "Female";
  h.doc.getElementById("option-1").textContent = "Male";
  Object.assign(h.w, {
    jobsFormatFullName: () => "",
    jobsLowercaseXPath: (value) =>
      `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
  });
  h.w.eval(await adapter("eightfold", "eightfoldFillAlternateApplication"));
  try {
    await h.w.eightfoldFillAlternateApplication({
      employmentData: employment,
      nameData: {},
      addressData: {},
      contactData: {},
      websiteData: {},
    });
    assert.equal(h.api.value(h.control), "Female");
  } finally {
    h.close();
  }
});
