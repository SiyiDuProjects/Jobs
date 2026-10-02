import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

// Each adapter's fill runs inside one run: its bindings, then the rules for
// every other question. The rules own age, eligibility and veteran status.
const checked = (h) =>
  [...h.doc.querySelectorAll("input:checked")].map((node) => node.value);

test("JazzHR age question no longer defaults missing age to No", async (t) => {
  for (const [age, question, expected] of [
    [undefined, "Are you at least 18 years old?", ""],
    [22, "Are you under 18 years of age?", "No"],
    [22, "Are you at least 18 years old?", "Yes"],
  ]) {
    const h = await adapterPage(t, {
      site: "jazzhr",
      html: `<form><label for="resumator-over18-value">${question}</label><select id="resumator-over18-value"><option value="">Choose</option><option>Yes</option><option>No</option></select></form>`,
    });
    const current = {
      ...profile,
      employmentData: { ...profile.employmentData, age },
    };
    await h.fill((w) => w.jazzhrFillApplication(current), { current });
    assert.equal(
      h.value("#resumator-over18-value"),
      expected,
      question + " " + age,
    );
  }
});

test("Paylocity eligibility uses the displayed country even when its fixed control ID says US", async (t) => {
  for (const [country, expected] of [
    ["Canada", ""],
    ["the United States", "Yes"],
  ]) {
    const h = await adapterPage(t, {
      site: "paylocity",
      html: `<form><label for="acknowledgements.authorizedToWorkInUs">Are you authorized to work in ${country}?</label><select id="acknowledgements.authorizedToWorkInUs"><option value="">Choose</option><option>Yes</option><option>No</option></select></form>`,
    });
    await h.fill((w) => w.paylocityFillAcknowledgements());
    assert.equal(
      h.doc.getElementById("acknowledgements.authorizedToWorkInUs").value,
      expected,
      country,
    );
  }
});

for (const site of ["ashby", "jobvite"]) {
  test(`${site}: protected veteran radios use full option semantics and never infer protected status from veteran=true`, async (t) => {
    const labels = [
      "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN",
      "I AM NOT A PROTECTED VETERAN",
      "I DECLINE SELF-IDENTIFICATION",
    ];
    const options = labels
      .map((label, index) =>
        site === "ashby"
          ? `<div><span><input type="radio" name="veteran" id="_systemfield_eeoc_veteran_status_${index}" value="${label}"></span><label for="_systemfield_eeoc_veteran_status_${index}">${label}</label></div>`
          : `<label><input type="radio" name="veteran" value="${label}">${label}</label>`,
      )
      .join("");
    for (const veteran of [true, false]) {
      const h = await adapterPage(t, {
        site,
        html: `<form><fieldset><legend>Veteran status</legend>${options}</fieldset></form>`,
        url:
          site === "ashby"
            ? "https://jobs.ashbyhq.com/fixture/1/application"
            : "https://jobs.jobvite.com/fixture/job/1/apply",
      });
      const current = {
        ...profile,
        employmentData: { ...profile.employmentData, veteran },
      };
      await h.fill(
        (w) =>
          site === "ashby"
            ? w.ashbyFillDisclosures(current)
            : w.jobviteFillDisclosures(current),
        { current },
      );
      assert.deepEqual(checked(h), veteran ? [] : [labels[1]]);
    }
  });
}

for (const [site, fill, ids, wrap] of [
  [
    "adp",
    (w, p) => w.adpFillDisclosures(p.employmentData),
    ["veteranStatusIdYes", "veteranStatusIdNo", "veteranStatusIdDecline"],
  ],
  [
    "bamboohr",
    (w, p) => w.bamboohrFillDisclosures(p.employmentData),
    ["veteran", "notVeteran", "declineToAnswer"],
  ],
  [
    "breezy",
    (w, p) => w.breezyFillDisclosures(p.employmentData),
    ["vet_yes", "vet_no", "vet_nope"],
  ],
  [
    "jazzhr",
    (w, p) => w.jazzhrFillDisclosures(p.employmentData),
    [
      "resumator-eeoc_veteran-value_1",
      "resumator-eeoc_veteran-value_2",
      "resumator-eeoc_veteran-value_3",
    ],
  ],
  [
    "dayforce",
    () => null,
    [],
    (options) =>
      `<section><h2 test-id="veteran-form-questionnaire-title">Veteran status</h2>${options}</section>`,
  ],
  [
    "lever",
    (w, p) => w.leverFillAdditionalDisclosures(p),
    [],
    (options) =>
      `<section><div><div>Veteran status</div></div><div>${options}</div></section>`,
  ],
  [
    "greenhouse",
    (w, p) => w.greenhouseLegacyFillDemographicQuestions(p.employmentData),
    [],
    (options) =>
      `<div id="demographic_questions"><div class="field">Veteran status${options}</div></div>`,
  ],
]) {
  test(`${site}: the veteran question leaves protected status unknown and fills the confirmed negative`, async (t) => {
    const labels = [
      "I am a protected veteran",
      "I am not a protected veteran",
      "Prefer not to say",
    ];
    const options = `<fieldset><legend>Veteran status</legend>${labels.map((label, index) => `<label><input type="radio" name="veteran" id="${ids[index] || "vet" + index}" value="${label}">${label}</label>`).join("")}</fieldset>`;
    for (const veteran of [true, false]) {
      const h = await adapterPage(t, {
          site,
          html: `<form>${wrap ? wrap(options) : options}</form>`,
        }),
        current = {
          ...profile,
          employmentData: { ...profile.employmentData, veteran },
        };
      await h.fill((w) => fill(w, current), { current });
      assert.deepEqual(
        checked(h),
        veteran ? [] : [labels[1]],
        site + " veteran=" + veteran,
      );
    }
  });
}

test("Seek personal details: the names, calling code and phone are written before the panel is saved", async (t) => {
  const h = await adapterPage(t, {
    site: "seek",
    url: "https://www.seek.com.au/job/1/apply",
    html: '<form><label for="firstName">First name</label><input id="firstName"><label for="lastName">Last name</label><input id="lastName"><label for="phoneNumber">Phone</label><input id="phoneNumber"><label for="docs">Resume</label><select id="docs" data-testid="select-input"><option value="">Select</option><option>resume.pdf</option></select><label for="countryCallingCode">Country code</label><select id="countryCallingCode"><option value="">Select</option><option>USA</option></select><button type="button" data-testid="save-personal-details">Save</button></form>',
  });
  const events = [];
  h.doc
    .querySelector("button")
    .addEventListener("click", () =>
      events.push([
        "save",
        h.value("#firstName"),
        h.value("#lastName"),
        h.value("#phoneNumber"),
      ]),
    );
  const current = {
    ...profile,
    nameData: { firstName: "Example", lastName: "Applicant" },
    contactData: { phoneNumber: "5550100" },
    resumeData: { fileName: "resume.pdf" },
  };
  await h.fill((w) => w.seekFillDocumentsPage(current), { current });
  assert.deepEqual(events, [["save", "Example", "Applicant", "5550100"]]);
  assert.equal(h.value("#countryCallingCode"), "USA");
  assert.equal(h.value("select[data-testid]"), "resume.pdf");
});

test("the rules keep a manual selection made while saved answers load", async (t) => {
  const h = await adapterPage(t, {
    site: "paylocity",
    html: '<form><label for="eligibility">Are you authorized to work in the United States?</label><select id="eligibility"><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></form>',
  });
  const node = h.doc.querySelector("select");
  h.w.fixtureSavedResponses = {
    then(resolve) {
      Promise.resolve().then(() => {
        node.value = "N";
        resolve([]);
      });
    },
  };
  await h.fill(() => null);
  assert.equal(node.value, "N");
});

test("a rule answer is written as the native option whose label it names", async (t) => {
  const h = await adapterPage(t, {
    html: '<form><fieldset><legend>Are you authorized to work in the United States?</legend><select id="eligibility"><option value="">Choose</option><option value="Y">Yes</option><option value="N">No</option></select></fieldset></form>',
  });
  await h.fill(() => null);
  assert.equal(h.value("#eligibility"), "Y");
});
