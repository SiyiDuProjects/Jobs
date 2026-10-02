import { functionBlock, readModule } from "./helpers/module-source.mjs";
import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
const read = (name) =>
  readWithDependencies(new URL("../" + name, import.meta.url), "utf8");
const codes = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "oracle-controls",
    "control-fields",
    "form-pipeline",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const adapter = await read("source/content/adapters/oracle.js");
const grid = (name = "country", label = "Country", required = true) =>
  `<div class="input-row input-row--has-picker"><label class="input-row__label ${required ? "input-row__label--required" : ""}" for="${name}-1">${label}</label><div class="cx-select-container"><input class="cx-select-input" role="combobox" name="${name}" id="${name}-1" aria-controls="${name}-1-listbox" aria-expanded="false" aria-invalid="false"></div></div>`;
function fixture(t, html = grid()) {
  const dom = new JSDOM('<main id="main">' + html + "</main>", {
    url: "https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Test/job/1/apply/section/1",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = w.document;
  codes.forEach((code) => w.eval(code));
  w.jobsRegionAliases = (state) =>
    state === "California" ? ["California", "CA"] : [state];
  w.eval(adapter);
  const reader = w.JobsControlFields.create(
    doc,
    () => doc.querySelector("main"),
    { write: true },
  );
  return { w, doc, reader, root: doc.querySelector("main") };
}
function menu(
  f,
  labels,
  { commit = true, delay = 0, commitValue = (label) => label } = {},
) {
  const input = f.doc.querySelector(".cx-select-input");
  const show = () => {
    if (f.doc.getElementById(input.getAttribute("aria-controls"))) return;
    input.setAttribute("aria-expanded", "true");
    const box = f.doc.createElement("div");
    box.id = input.getAttribute("aria-controls");
    box.setAttribute("role", "grid");
    box.setAttribute("aria-busy", "false");
    for (const label of labels) {
      const cell = f.doc.createElement("div");
      cell.setAttribute("role", "gridcell");
      cell.textContent = label;
      cell.onclick = () => {
        if (commit) {
          input.value = commitValue(label);
          input.closest(".input-row").classList.add("input-row--filled");
          input.setAttribute("aria-expanded", "false");
          box.remove();
        }
      };
      box.append(cell);
    }
    f.root.append(box);
  };
  input.onclick = () => (delay ? setTimeout(show, delay) : show());
  return input;
}
test("Oracle labels and required markers identify pills, text and empty optional fields", (t) => {
  const f = fixture(
    t,
    `<div class="input-row"><label class="input-row__label input-row__label--required">Work authorization</label><ul role="radiogroup" aria-label="Work authorization"><button role="radio" aria-checked="false">Yes</button><button role="radio" aria-checked="false">No</button></ul></div><div class="input-row"><label class="input-row__label" for="first">First Name</label><input id="first"></div>`,
  );
  const rows = f.reader.scan();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].public.required, true);
  assert.equal(rows[0].public.question, "Work authorization");
  assert.equal(rows[1].public.required, false);
});
test("Oracle exact grid selection waits for async options and verifies model commit", async (t) => {
  const f = fixture(t);
  menu(f, ["United Kingdom", "United States"], { delay: 15 });
  await f.reader.apply(f.reader.scan()[0], "United States");
  assert.equal(f.reader.scan()[0].raw, "United States");
  assert.equal(f.reader.state().ready, true);
});
test("Oracle never chooses a containing or duplicate label", async (t) => {
  const f = fixture(t, grid("major", "Major"));
  const input = menu(f, ["Applied Physics", "Physics", "Physics"]);
  assert.equal(await chooseAnswer(input, "Physics"), null);
  assert.equal(input.value, "");
});
test("Oracle text typed into a closed dropdown is not a committed choice", (t) => {
  const f = fixture(t),
    input = f.doc.querySelector("input");
  f.reader.scan();
  input.value = "United States";
  input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  input.setAttribute("aria-expanded", "false");
  input.closest(".input-row").classList.add("input-row--filled");
  const row = f.reader.scan()[0];
  assert.equal(row.public.filled, false);
  assert.equal(row.public.commitState, "unconfirmed");
  assert.equal(f.reader.state().ready, false);
});
test("Oracle searchable grid works when the initial list has no options", async (t) => {
  const f = fixture(t, grid("educationalEstablishment", "School"));
  const input = menu(f, []);
  input.addEventListener("input", () => {
    const box = f.doc.getElementById(input.getAttribute("aria-controls"));
    if (!box) return;
    const cell = f.doc.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.textContent = "Example University";
    cell.onclick = () => {
      input.value = cell.textContent;
      input.closest(".input-row").classList.add("input-row--filled");
      input.setAttribute("aria-expanded", "false");
      box.remove();
    };
    box.replaceChildren(cell);
  });
  await f.reader.apply(f.reader.scan()[0], "Example University");
  assert.equal(f.reader.scan()[0].raw, "Example University");
});
test("Oracle shared pipeline writes pills and reflects selection, with cancellation", async (t) => {
  const f = fixture(
    t,
    `<div class="input-row"><label class="input-row__label input-row__label--required">Question</label><ul role="radiogroup" aria-label="Question"><button role="radio" aria-checked="false">Yes</button><button role="radio" aria-checked="false">No</button></ul></div>`,
  );
  for (const button of f.doc.querySelectorAll("button"))
    button.onclick = () => button.setAttribute("aria-checked", "true");
  await assert.rejects(f.reader.apply(f.reader.scan()[0], "Yes", () => false));
  await f.reader.apply(f.reader.scan()[0], "Yes");
  assert.equal(f.reader.scan()[0].public.filled, true);
  assert.equal(f.reader.state().ready, true);
});
test("Oracle filled model values are preserved and controls are host scoped", async (t) => {
  const f = fixture(t);
  const input = menu(f, ["United States"]);
  input.value = "Canada";
  input.closest(".input-row").classList.add("input-row--filled");
  await f.w.JobsFormPipeline.bind([
    f.w.oracleBinding(f.root, "country", "input", "United States"),
  ]);
  assert.equal(input.value, "Canada");
  const external = new JSDOM(grid(), { url: "https://example.org" });
  t.after(() => external.window.close());
  assert.equal(
    f.w.JobsOracleControls.isControl(
      external.window.document.querySelector("input"),
    ),
    false,
  );
});
test("Oracle signature name uses the current Profile and preserves an existing value", async (t) => {
  const f = fixture(
    t,
    '<div role="region" aria-label="E-Signature "><div class="input-row"><label class="input-row__label input-row__label--required" for="sign">Full Name</label><input id="sign" name="fullName"></div></div>',
  );
  const field = f.reader.scan()[0].public;
  assert.equal(field.supported, true);
  assert.equal(field.required, true);
  assert.equal(f.reader.state().ready, false);
  await f.w.oracleFillContact(f.root, {}, () => true);
  assert.equal(f.doc.querySelector("#sign").value, "");
  await f.w.oracleFillContact(
    f.root,
    { nameData: { firstName: "Alex", middleName: "M", lastName: "Lee" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#sign").value, "Alex M Lee");
  assert.equal(f.reader.state().ready, true);
  await f.w.oracleFillContact(
    f.root,
    { nameData: { firstName: "Other", lastName: "Profile" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#sign").value, "Alex M Lee");
});
test("Oracle first and subsequent fills use shared writes and retain populated contact fields", async (t) => {
  const f = fixture(
    t,
    '<div class="input-row"><label class="input-row__label" for="first">First Name</label><input id="first" name="firstName"></div><div class="input-row"><label class="input-row__label" for="last">Last Name</label><input id="last" name="lastName" value="Keep"></div>',
  );
  await f.w.oracleFillContact(
    f.root,
    { nameData: { firstName: "Test", lastName: "Replacement" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#first").value, "Test");
  assert.equal(f.doc.querySelector("#last").value, "Keep");
  await f.w.oracleFillContact(
    f.root,
    { nameData: { firstName: "Changed" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#first").value, "Test");
});
test("Oracle never duplicates existing history or takes over an open editor", async (t) => {
  for (const markup of [
    '<button class="apply-flow-profile-item-tile__edit-item-icon"></button>',
    '<button class="save-btn"></button>',
  ]) {
    const f = fixture(
      t,
      '<div role="region" aria-label="Education ">' +
        markup +
        '<button class="apply-flow-profile-item-tile__new-tile">Add</button></div>',
    );
    f.doc.querySelector(".apply-flow-profile-item-tile__new-tile").onclick =
      () => assert.fail("duplicate history");
    assert.equal(
      await f.w.oracleFillHistory(
        f.root,
        { educationData: [{ school: "Example" }] },
        () => true,
      ),
      false,
    );
  }
});
test("Oracle routes are application-only and appended without moving existing protocol indexes", async () => {
  const source = await readModule(
    new URL("../source/content/routing.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM("", { runScripts: "outside-only" });
  const oracle = () => {},
    dayforce = () => {};
  dom.window.oracleRunApplication = oracle;
  dom.window.dayforceRunApplication = dayforce;
  dom.window.eval(source);
  const routes = dom.window.jobsAdapterRoutes;
  const pattern = routes.find((route) => route.script === oracle).pattern;
  assert(
    routes.findIndex((route) => route.script === oracle) >
      routes.findIndex((route) => route.script === dayforce),
  );
  dom.window.close();
  assert(
    pattern.test(
      "https://icbpjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LazardStudentCareers/job/6603/apply/section/1",
    ),
  );
  for (const url of [
    "https://x.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Test/job/1",
    "https://x.taleo.net/job/1/apply",
    "https://oraclecloud.com.evil.test/hcmUI/CandidateExperience/en/sites/Test/job/1/apply",
  ])
    assert(!pattern.test(url));
});
test("Oracle adapter always uses the common fill pipeline without final submission", async (t) => {
  const f = fixture(
    t,
    '<div class="input-row"><label for="first" class="input-row__label">First Name</label><input id="first" name="firstName"></div><button class="apply-flow-pagination__submit-button">Submit</button>',
  );
  let pipeline;
  const profile = { nameData: { firstName: "Example" } };
  f.w.JobsAutomatic = {
    advance: async (options) => {
      pipeline = options;
      await options.fill(() => true);
    },
  };
  f.doc.querySelector("button").onclick = () => assert.fail("Must not submit");
  await f.w.oracleRunApplication({
    setMessage() {},
    getProfile: async () => profile,
    autofillSettings: { autoSubmit: true },
    ctx: {},
  });
  assert.equal(pipeline.action, "fill");
  assert.equal(pipeline.root, f.root);
  assert.equal(f.doc.querySelector("input").value, "Example");
});
test("Oracle free-text address is distinct from enum search text", async (t) => {
  const f = fixture(t, grid("addressLine1", "Address Line 1", false));
  const input = f.doc.querySelector("input");
  input.classList.add("cx-select-input--auto-suggest");
  input.addEventListener("focusout", () =>
    input.closest(".input-row").classList.add("input-row--filled"),
  );
  await f.reader.apply(f.reader.scan()[0], "123 Example Street");
  const field = f.reader.scan()[0].public;
  assert.equal(field.filled, true);
  assert.equal(field.commitState, undefined);
});

test("Oracle reset button alone cannot prove a selected option", (t) => {
  const f = fixture(t);
  const input = f.doc.querySelector("input");
  input.value = "Uncommitted search";
  const clear = f.doc.createElement("button");
  clear.id = input.id + "-reset-button";
  input.parentElement.append(clear);
  assert.equal(f.w.JobsOracleControls.value(input), "");
});

test("Oracle replaces leftover search text and accepts subsequent manual selection", async (t) => {
  const f = fixture(t);
  const input = menu(f, ["United States"]);
  f.reader.scan();
  input.value = "United";
  input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  assert.equal(
    await chooseAnswer(input, "United States", { replace: true }),
    input,
  );
  assert.equal(f.w.JobsOracleControls.value(input), "United States");
  input.value = "United";
  input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  input.click();
  f.doc.querySelector('[role="gridcell"]').click();
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(f.reader.scan()[0].public.filled, true);
});

test("Oracle school alias matches Berkeley without selecting its business school", async (t) => {
  const f = fixture(t, grid("educationalEstablishment", "School"));
  const input = menu(f, [
    "University of California, Berkeley (UC Berkeley)",
    "University of California, Berkeley, Haas School of Business",
  ]);
  assert.equal(
    f.w.JobsProfileAnswers.schoolMatches(
      "University of California, Berkeley, Haas School of Business",
      "University of California, Berkeley",
    ),
    false,
  );
  // The school rule (the spec), not the component, decides which label is the same school.
  assert.equal(
    await f.w.JobsControlFields.chooseSpec(
      input,
      f.w.JobsProfileAnswers.schoolSpec("University of California, Berkeley"),
    ),
    input,
  );
  assert.equal(input.value, "University of California, Berkeley (UC Berkeley)");
});

test("Oracle composite postal labels commit the short value and match city/state", async (t) => {
  const f = fixture(
    t,
    '<div role="region"><input name="region2" value="CA"><input name="city" value="San Leandro"><div class="geo-hierarchy-form-element">' +
      grid("postalCode", "ZIP Code") +
      "</div></div>",
  );
  const input = menu(f, ["94579, San Leandro, CA", "94579, Wrong City, CA"], {
    commitValue: (label) => label.split(",")[0],
  });
  assert.equal(await chooseAnswer(input, "94579"), input);
  assert.equal(f.w.JobsOracleControls.value(input), "94579");
});

test("Oracle waits for debounced remote search rather than stale options", async (t) => {
  const f = fixture(t, grid("educationalEstablishment", "School"));
  const input = menu(f, ["Old University"]);
  input.addEventListener("input", () =>
    setTimeout(() => {
      const box = f.doc.getElementById(input.getAttribute("aria-controls"));
      const cell = f.doc.createElement("div");
      cell.setAttribute("role", "gridcell");
      cell.textContent = "New University";
      cell.onclick = () => {
        input.value = cell.textContent;
        input.setAttribute("aria-expanded", "false");
        input.closest(".input-row").classList.add("input-row--filled");
        box.remove();
      };
      box.replaceChildren(cell);
    }, 500),
  );
  assert.equal(await chooseAnswer(input, "New University"), input);
});

test("Oracle address runs street before dependent geography and commits a shared state-code equivalent", async (t) => {
  const f = fixture(
    t,
    '<input name="addressLine1"><input name="city">' + grid("region2", "State"),
  );
  const calls = [],
    input = menu(f, ["CA", "NY"]);
  const choose = f.w.JobsControlFields.chooseSpec;
  f.w.JobsControlFields.chooseSpec = async (node, spec, options) => {
    if (node) calls.push([`input[name="${node.name}"]`, spec]);
    return choose(node, spec, options);
  };
  await f.w.oracleFillContact(f.root, {
    addressData: {
      line1: "Street",
      state: "California",
      city: "City",
      postalCode: "12345",
      country: "United States",
    },
  });
  const index = (name) =>
    calls.findIndex(([selector]) => selector === `input[name="${name}"]`);
  assert(index("addressLine1") < index("region2"));
  assert(index("region2") < index("city"));
  assert.equal(input.value, "CA");
});

test("Oracle history failure does not suppress unrelated question answers", async (t) => {
  const f = fixture(t, '<div class="input-row"><input name="firstName"></div>');
  let called = false;
  f.w.oracleFillHistory = async () => {
    throw Error("School is pending");
  };
  f.w.JobsAutomatic = {
    advance: async () => {
      called = true;
    },
  };
  await f.w.oracleRunApplication({
    setMessage() {},
    getProfile: async () => ({}),
    ctx: {},
  });
  assert.equal(called, true);
});

test("Oracle finite-menu misses return without typing or waiting for remote search", async (t) => {
  const f = fixture(t, grid("region2", "State"));
  const input = menu(f, ["CA", "NY"]);
  let typed = false;
  input.addEventListener("input", () => {
    typed = true;
  });
  const start = Date.now();
  assert.equal(await chooseAnswer(input, "California"), null);
  assert.equal(typed, false);
  assert(Date.now() - start < 1000);
});

test("Oracle resumes a matching education editor and adds only missing employment records", async (t) => {
  const tile = (a, b) =>
    `<article class="apply-flow-profile-item-tile"><div class="apply-flow-profile-item-tile__summary"><div class="apply-flow-profile-item-tile__summary-title">${a}</div><div class="apply-flow-profile-item-tile__summary-subtitle">${b}</div></div><button class="apply-flow-profile-item-tile__edit-item-icon"></button></article>`;
  const f = fixture(
    t,
    `<div role="region" aria-label="Education"><div class="input-row"><label class="input-row__label" for="major">Major</label><input id="major" name="major" value="Physics"></div><div class="input-row"><label class="input-row__label" for="school">School</label><input id="school" name="educationalEstablishment" value="Example University"></div><button class="save-btn">Save</button></div><div role="region" aria-label="Experience">${tile("Engineer", "Existing Co")}<button class="apply-flow-profile-item-tile__new-tile">Add</button></div>`,
  );
  f.w.eval(functionBlock(adapter, "oracleFillHistory"));
  const calls = [];
  f.w.oracleFillHistoryEntry = async (region, label, entry) => {
    calls.push(entry.school || entry.company);
    const values = f.w.oracleHistoryIdentity(label, entry);
    region.querySelector(".save-btn").onclick = () => {
      region.querySelector(".save-btn").remove();
      region.insertAdjacentHTML("afterbegin", tile(...values));
    };
  };
  f.doc.querySelector(".apply-flow-profile-item-tile__new-tile").onclick = () =>
    f.doc
      .querySelector('[aria-label="Experience"]')
      .insertAdjacentHTML(
        "beforeend",
        '<div class="input-row"><label class="input-row__label" for="job">Job Title</label><input id="job" value="Developer"></div><button class="save-btn">Save</button>',
      );
  const profile = {
    educationData: [{ fieldOfStudy: "Physics", school: "Example University" }],
    jobData: [
      { company: "Existing Co", jobTitle: "Engineer" },
      { company: "Missing Co", jobTitle: "Developer" },
    ],
  };
  assert.equal(await f.w.oracleFillHistory(f.root, profile, () => true), true);
  assert.deepEqual(calls, ["Example University", "Missing Co"]);
  assert.equal(await f.w.oracleFillHistory(f.root, profile, () => true), true);
  assert.equal(calls.length, 2);
});

test("Oracle unrelated open education editor does not block missing work records", async (t) => {
  const f = fixture(
    t,
    '<div role="region" aria-label="Education"><input name="major" value="Other"><button class="save-btn"></button></div><div role="region" aria-label="Experience"><button class="apply-flow-profile-item-tile__new-tile">Add</button></div>',
  );
  let called = false;
  f.doc.querySelector(".apply-flow-profile-item-tile__new-tile").onclick = () =>
    f.doc
      .querySelector('[aria-label="Experience"]')
      .insertAdjacentHTML(
        "beforeend",
        '<button class="save-btn">Save</button>',
      );
  f.w.eval(functionBlock(adapter, "oracleFillHistory"));
  f.w.oracleFillHistoryEntry = async () => {
    called = true;
    throw Error("Unsupported required field");
  };
  assert.equal(
    await f.w.oracleFillHistory(
      f.root,
      {
        educationData: [{ school: "Example", fieldOfStudy: "Physics" }],
        jobData: [{ company: "Company", jobTitle: "Engineer" }],
      },
      () => true,
    ),
    false,
  );
  assert.equal(called, true);
});

test("Oracle history identities strip only a date range and preserve the company", (t) => {
  const f = fixture(t);
  const entry = { jobTitle: "Engineer", company: "Example" };
  assert.equal(
    f.w.oracleHistoryMatches("Experience", entry, [
      "Engineer",
      "Example\n10/2025 - 12/2025",
    ]),
    true,
  );
  assert.equal(
    f.w.oracleHistoryMatches("Experience", entry, [
      "Engineer",
      "Example Consulting\n10/2025 - 12/2025",
    ]),
    false,
  );
});

test("Oracle month commits before its shared date row can become filled", async (t) => {
  const f = fixture(t, grid("startDate", "Start Date"));
  const input = menu(f, ["October"]);
  input.id = "month-startDate-1";
  input.addEventListener("click", () => {
    const cell = f.doc.querySelector('[role="gridcell"]');
    if (cell)
      cell.onclick = () => {
        input.value = "October";
        input.setAttribute("aria-expanded", "false");
        cell.parentElement.remove();
      };
  });
  const start = Date.now();
  assert.equal(await chooseAnswer(input, "October"), input);
  assert.equal(f.w.JobsOracleControls.value(input), "October");
  assert(Date.now() - start < 1000);
  assert.equal(
    input.closest(".input-row").classList.contains("input-row--filled"),
    false,
  );
  input.value = "November";
  input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  assert.equal(f.w.JobsOracleControls.value(input), "");
});

test("Oracle optional race choices use exact Profile facts and preserve existing selections", async (t) => {
  const f = fixture(
    t,
    '<div role="group" aria-label="Select the races you identify with."><label for="asian">Asian</label><input type="checkbox" id="asian"><label for="white">White</label><input type="checkbox" id="white"></div>',
  );
  await f.w.oracleFillDemographics(
    f.root,
    { employmentData: { ethnicity: "Asian" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#asian").checked, true);
  assert.equal(f.doc.querySelector("#white").checked, false);
  await f.w.oracleFillDemographics(
    f.root,
    { employmentData: { ethnicity: "White" } },
    () => true,
  );
  assert.equal(f.doc.querySelector("#white").checked, false);
});

test("Oracle race aliases use the shared rule inside the labelled group and honor cancellation", async (t) => {
  const f = fixture(
    t,
    '<div role="group" aria-label="Select the races you identify with."><div><label for="asian">Asian or Asian American</label><input type="checkbox" id="asian"></div><div><label for="white">White / Caucasian</label><input type="checkbox" id="white"></div></div><label for="outside">Asian</label><input type="checkbox" id="outside">',
  );
  await f.w.oracleFillDemographics(
    f.root,
    { employmentData: { ethnicity: "Asian" } },
    () => false,
  );
  assert.equal(f.doc.querySelector("input:checked"), null);
  await f.w.oracleFillDemographics(
    f.root,
    { employmentData: { ethnicity: "Asian" } },
    () => true,
  );
  assert.deepEqual(
    [...f.doc.querySelectorAll("input")].map((node) => node.checked),
    [true, false, false],
  );
});
