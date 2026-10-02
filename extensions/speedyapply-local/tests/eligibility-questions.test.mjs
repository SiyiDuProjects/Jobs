import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

// Sponsorship, work authorization and age are the rules' answers on every
// ATS: an adapter declares none of them. Each question below is answered (or
// left alone) by one run, from the full question and the Profile's facts.
const oldProfile = {
  ...profile,
  addressData: { country: "United States" },
  employmentData: {
    age: 22,
    sponsorship: true,
    eligibilityUS: false,
    gender: "Male",
    ethnicity: "Asian",
  },
};
const select = (question, extra = "") =>
  `<form><label for="q">${question}</label><select id="q"><option value="">Choose</option><option>Yes</option><option>No</option></select>${extra}</form>`;
async function answer(t, question, current, { extra } = {}) {
  const h = await adapterPage(t, { html: select(question, extra) });
  await h.fill(() => null, { current });
  return h.value("#q");
}

test("a saved sponsorship fact answers the question; a missing fact is never No", async (t) => {
  for (const [value, expected] of [
    [true, "Yes"],
    [false, "No"],
    [undefined, ""],
  ]) {
    const current = {
      ...oldProfile,
      employmentData: { ...oldProfile.employmentData, sponsorship: value },
      applicationData: { sponsorshipNow: value },
    };
    assert.equal(
      await answer(t, "Do you currently require sponsorship?", current),
      expected,
      String(value),
    );
  }
});

test("explicit current and future facts answer their own question; an unresolved scope stays empty", async (t) => {
  const current = {
    ...oldProfile,
    applicationData: { sponsorshipNow: false, sponsorshipFuture: true },
  };
  for (const [question, expected, extra] of [
    ["Do you currently require sponsorship?", "No"],
    ["Will you require sponsorship in the future?", "Yes"],
    [
      "Do you currently require sponsorship?",
      "",
      '<label for="c">Are you legally authorized to work in Canada?</label><input id="c">',
    ],
    [
      "Do you require sponsorship of an immigration case already in progress?",
      "",
    ],
    ["Do you require sponsorship and a security clearance?", ""],
  ])
    assert.equal(
      await answer(t, question, current, { extra }),
      expected,
      question,
    );
});

test("authorization country and reversed age wording are decided from the full question", async (t) => {
  const current = {
    ...oldProfile,
    employmentData: { ...oldProfile.employmentData, eligibilityUS: true },
  };
  for (const [question, expected] of [
    ["Are you authorized to work in Canada?", ""],
    ["Are you authorized to work in the United States?", "Yes"],
    ["Are you under 18 years of age?", "No"],
    ["Are you at least 18 years of age?", "Yes"],
  ])
    assert.equal(await answer(t, question, current), expected, question);
});

test("Tesla legal questions stay blank without facts and take exact saved answers", async (t) => {
  const questions = [
    [
      "legalConsiderOtherPositions",
      "Would you like to be considered for other positions?",
    ],
    ["legalFormerTeslaEmployee", "Have you previously been employed by Tesla?"],
    [
      "legalFormerTeslaInternOrContractor",
      "Have you previously been a Tesla intern or contractor?",
    ],
    ["legalReceiveNotifications", "Would you like to receive notifications?"],
  ];
  const html =
    '<form><label>What is your notice period?<select name="legal.legalNoticePeriod"><option value="">Select</option><option value="now">Immediately</option><option value="month">One month</option></select></label>' +
    questions
      .map(
        ([key, question]) =>
          `<fieldset><legend>${question}</legend><label><input type="radio" name="legal.${key}" value="yes">Yes</label><label><input type="radio" name="legal.${key}" value="no">No</label></fieldset>`,
      )
      .join("") +
    '<label><input type="checkbox" name="legal.legalAcknowledgment">I acknowledge</label><label>Full name<input name="legal.legalAcknowledgmentName"></label></form>';
  const blank = await adapterPage(t, {
    site: "tesla",
    html,
    url: "https://www.tesla.com/careers/search/job/apply/1",
  });
  await blank.fill((w) => w.teslaFillLegalPage(oldProfile), {
    current: oldProfile,
  });
  assert.equal(blank.doc.querySelector("select").value, "");
  assert.equal(
    blank.doc.querySelectorAll('input[type="radio"]:checked').length,
    0,
  );
  assert.equal(
    blank.doc.querySelector('[name="legal.legalAcknowledgment"]').checked,
    false,
  );
  assert.equal(
    blank.value('[name="legal.legalAcknowledgmentName"]'),
    "Example Applicant",
  );
  const saved = [
    { question: "What is your notice period?", response: "One month" },
    ...questions.map(([, question]) => ({ question, response: "No" })),
  ];
  const known = await adapterPage(t, {
    site: "tesla",
    html,
    url: "https://www.tesla.com/careers/search/job/apply/1",
    saved,
  });
  await known.fill((w) => w.teslaFillLegalPage(oldProfile), {
    current: oldProfile,
  });
  assert.equal(known.doc.querySelector("select").value, "month");
  for (const [key] of questions)
    assert.equal(
      known.doc.querySelector(`input[name="legal.${key}"]:checked`)?.value,
      "no",
      key,
    );
});
