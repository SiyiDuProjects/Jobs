import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";
import { menuFixture } from "./helpers/menu-fixtures.mjs";

// Synthetic values; structure follows the Sarnova Candidate Info page. The
// footer is outside #jobPostingApplication, and its sections are separate forms.
const candidate = `
  <form id="login"><label>Email<input id="login-email"></label></form>
  <section test-id="manual-application-dayforce-jobs">
    <div class="ant-card-body">
      <div id="jobPostingApplication">
        <div test-id="application-step-candidateinfo">
          <input type="file" id="jobPostingApplication_files_resume" style="display:none">
          <form id="personalInfo">
            <label for="jobPostingApplication_personalInfo_email">Email Address</label>
            <input id="jobPostingApplication_personalInfo_email" required>
            <label for="jobPostingApplication_personalInfo_firstName">First Name</label>
            <input id="jobPostingApplication_personalInfo_firstName" required>
            <label for="jobPostingApplication_personalInfo_middleName">Middle Name</label>
            <input id="jobPostingApplication_personalInfo_middleName">
            <label for="jobPostingApplication_personalInfo_lastName">Last Name</label>
            <input id="jobPostingApplication_personalInfo_lastName" required>
          </form>
          <form id="workHistory-0"><label>Position Title<input id="work-title"></label></form>
          <form id="educationHistory-0"><label>School<input id="school-name"></label></form>
        </div>
      </div>
      <div class="ant-affix"><button type="button" test-id="application-next-step">Next</button></div>
    </div>
  </section>
  <button type="button" test-id="application-next-step">Unrelated Next</button>`;

const setup = (t, html = candidate) =>
  adapterPage(t, {
    site: "dayforce",
    html,
    url: "https://jobs.dayforcehcm.com/en-US/fixture/candidateportal/jobs/1/apply/manualApplication",
  });

test("Dayforce scopes all three forms, uploads and the outside footer to one application", async (t) => {
  const h = await setup(t),
    config = h.w.JobsPlatformConfig,
    root = config.root(h.doc, "dayforce");
  assert.equal(
    root,
    h.doc.querySelector('[test-id="manual-application-dayforce-jobs"]'),
  );
  const reader = h.w.JobsControlFields.create(h.doc, () => root),
    ids = Array.from(reader.scan(), (row) => row.node.id);
  for (const id of [
    "jobPostingApplication_personalInfo_email",
    "work-title",
    "school-name",
  ])
    assert(ids.includes(id), id);
  assert(!ids.includes("login-email"));
  assert(root.contains(h.doc.querySelector('input[type="file"]')));
  const next = config.navigation(h.doc, "dayforce", "next");
  assert.equal(next, root.querySelector('[test-id="application-next-step"]'));
  assert(!h.doc.querySelector("#jobPostingApplication").contains(next));
});

test("Dayforce questionnaire and review stay scoped while ambiguous or missing applications fail closed", async (t) => {
  const h = await setup(t),
    config = h.w.JobsPlatformConfig,
    root = config.root(h.doc, "dayforce");
  assert(root);
  root.querySelector("#jobPostingApplication").innerHTML =
    '<div test-id="application-step-questionnaire"><form><label>Question<input id="question"></label></form></div>';
  assert.equal(config.root(h.doc, "dayforce"), root);
  assert.equal(
    config.navigation(h.doc, "dayforce", "next"),
    root.querySelector("button"),
  );
  const next = root.querySelector("button");
  next.setAttribute("test-id", "application-submit");
  assert.equal(config.navigation(h.doc, "dayforce", "next"), null);
  assert.equal(config.navigation(h.doc, "dayforce", "submit"), next);
  next.disabled = true;
  assert.equal(config.navigation(h.doc, "dayforce", "submit"), null);
  next.disabled = false;
  const duplicate = root.cloneNode(true);
  h.doc.body.append(duplicate);
  assert.equal(config.root(h.doc, "dayforce"), null);
  assert.equal(config.navigation(h.doc, "dayforce", "submit"), null);
  duplicate.hidden = true;
  assert.equal(config.root(h.doc, "dayforce"), root);
  root.remove();
  assert.equal(config.root(h.doc, "dayforce"), null);
  assert.equal(config.navigation(h.doc, "dayforce", "next"), null);
});

for (const middleName of [undefined, "", "Middle"]) {
  test(`Dayforce begins filling the multi-form page and uses only its actual middle name (${String(middleName)})`, async (t) => {
    const h = await setup(t),
      current = {
        ...profile,
        nameData: {
          ...profile.nameData,
          middleName,
          preferredName: true,
          preferredFirstName: "Preferred",
        },
      },
      root = h.w.JobsPlatformConfig.root(h.doc, "dayforce");
    await h.fill((w) => w.dayforceFillPersonalInformation(current), {
      root,
      current,
    });
    assert.equal(
      h.value("#jobPostingApplication_personalInfo_email"),
      current.contactData.email,
    );
    assert.equal(
      h.value("#jobPostingApplication_personalInfo_firstName"),
      current.nameData.firstName,
    );
    assert.equal(
      h.value("#jobPostingApplication_personalInfo_lastName"),
      current.nameData.lastName,
    );
    assert.equal(
      h.value("#jobPostingApplication_personalInfo_middleName"),
      middleName || "",
    );
    assert.equal(h.value("#login-email"), "");
    assert.equal(
      h.notes.filter((note) => note.type === "auto_step_started").length,
      1,
    );
    assert(!h.notes.some((note) => note.type === "auto_blocked"));
  });
}

test("Dayforce leaves an unknown required middle name unresolved and preserves a manual answer", async (t) => {
  for (const manual of ["", "Owner entry"]) {
    const h = await setup(t),
      node = h.doc.querySelector(
        "#jobPostingApplication_personalInfo_middleName",
      );
    node.required = true;
    node.value = manual;
    await h.fill((w) => w.dayforceFillPersonalInformation(profile), {
      root: h.w.JobsPlatformConfig.root(h.doc, "dayforce"),
    });
    assert.equal(node.value, manual);
    if (!manual)
      assert(
        h.requests.some((request) =>
          request.fields.some((field) => field.question === "Middle Name"),
        ),
      );
  }
});

test("Dayforce keeps saved history entries separate from the next editor", async (t) => {
  const h = await setup(
    t,
    `<section test-id="manual-application-dayforce-jobs">
    <button type="button" test-id="add-workhistory-record">Add Employment History</button>
    <div id="records"></div></section>`,
  );
  const current = {
    ...profile,
    educationData: [],
    jobData: [
      {
        jobTitle: "Engineer",
        company: "First Example",
        description: "First duties",
        startDate: "2025-05",
        endDate: "2025-08",
      },
      {
        jobTitle: "Engineer",
        company: "Second Example",
        description: "Second duties",
        startDate: "2024-05",
        endDate: "2024-08",
      },
    ],
  };
  const saved = [];
  h.doc.querySelector("button").onclick = () => {
    const index = h.doc.querySelectorAll("form").length;
    const form = h.doc.createElement("form");
    form.id = `workHistory-${index}`;
    form.setAttribute("test-id", "workhistory-record");
    form.innerHTML =
      [
        ["title", "Position Title"],
        ["companyName", "Employer Name"],
        ["description", "Duties and Responsibilities"],
      ]
        .map(
          ([name, label]) =>
            `<label>${label}<input id="jobPostingApplication_workHistory_${index}_${name}" required></label>`,
        )
        .join("") +
      `<label>Start Date<input type="date" id="jobPostingApplication_workHistory_${index}_effectiveStart"></label>
       <label>End Date<input type="date" id="jobPostingApplication_workHistory_${index}_effectiveEnd"></label>
       <button type="button" test-id="workHistory-update-button">Update</button>`;
    form.querySelector("button").onclick = () => {
      const values = [...form.querySelectorAll("input[required]")].map(
        (n) => n.value,
      );
      if (values.some((v) => !v)) return;
      for (const date of form.querySelectorAll("input[type=date]"))
        assert.equal(
          date.value,
          "",
          "month-only Profile dates must not invent a day",
        );
      saved.push(values);
      form.replaceChildren(h.doc.createTextNode("Saved record"));
    };
    h.doc.querySelector("#records").prepend(form);
  };
  await h.fill((w, live) => w.dayforceFillApplication(current, live), {
    root: h.doc.querySelector("section"),
    current,
  });
  assert.deepEqual(saved, [
    ["Engineer", "First Example", "First duties"],
    ["Engineer", "Second Example", "Second duties"],
  ]);
  assert(!h.notes.some((n) => n.type === "auto_duplicate_decider"));
});

test("Dayforce history fields cannot borrow personal address or expected salary answers", async (t) => {
  const h = await adapterPage(t, {
    site: "dayforce",
    url: "https://jobs.dayforcehcm.com/example/apply/manualApplication",
    saved: [{ question: "Address Line 1", response: "Saved personal address" }],
    html: `<section test-id="manual-application-dayforce-jobs">
      <form id="personalInfo"><label>Address Line 1<input id="personal-address"></label></form>
      <form id="workHistory-1" test-id="workhistory-record">
        <label>Address Line 1<input id="employer-address"></label>
        <label>City<input id="employer-city"></label>
        <label>Salary<input id="past-salary"></label>
        <label>Country<select id="employer-country"><option value=""></option><option>United States</option></select></label>
      </form>
      <form id="educationHistory-0" test-id="educationhistory-record"><label>City<input id="school-city"></label></form>
    </section>`,
  });
  const current = {
    ...profile,
    applicationData: { salaryPreference: "posted_range" },
  };
  await h.fill(() => {}, { root: h.doc.querySelector("section"), current });
  assert.equal(h.value("#personal-address"), profile.addressData.line1);
  for (const id of [
    "employer-address",
    "employer-city",
    "past-salary",
    "employer-country",
    "school-city",
  ])
    assert.equal(h.value("#" + id), "", id);
});

test("Dayforce phone country matches a flag and leading dial code without confusing shared codes", async (t) => {
  const h = await setup(t);
  const options = [
    "🇨🇦 +1 Canada",
    "🇺🇸 +1 United States of America",
    "United States Minor Outlying Islands",
  ];
  const spec = h.w.JobsProfileAnswers.countrySpec("USA");
  assert.equal(h.w.JobsOptionMatch.pick(options, spec)?.label, options[1]);
  assert.equal(h.w.JobsOptionMatch.pick(["🇨🇦 +1 Canada", "+1"], spec), null);
  assert.equal(
    h.w.JobsOptionMatch.pick(["United States (+1)"], spec)?.label,
    "United States (+1)",
  );
});

test("Dayforce Ant Select commits the named country rather than the first shared-code option", async () => {
  const labels = ["🇨🇦 +1 Canada", "🇺🇸 +1 United States of America"];
  const h = menuFixture("dayforce", { labels, nativeBacking: false });
  try {
    assert(
      await h.w.JobsControlFields.chooseSpec(
        h.node,
        h.w.JobsProfileAnswers.countrySpec("USA"),
      ),
    );
    assert.equal(h.w.JobsMenuControls.value(h.node), labels[1]);
    assert.equal(
      h.trace.filter((s) => s === "target:option:click:" + labels[0]).length,
      0,
    );
    assert.equal(
      h.trace.filter((s) => s === "target:option:click:" + labels[1]).length,
      1,
    );
  } finally {
    h.close();
  }
});
