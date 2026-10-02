import test from "node:test";
import assert from "node:assert/strict";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";

// The actual Tesla legal step: its acknowledgement bindings, then the rules
// for the sponsorship question, from the Profile the run is bound to.
const html =
  '<form><fieldset><legend>Do you currently require sponsorship to work in the United States?</legend><label><input type="radio" name="legal.legalImmigrationSponsorship" value="yes">Yes</label><label><input type="radio" name="legal.legalImmigrationSponsorship" value="no">No</label></fieldset>' +
  '<label><input type="checkbox" name="legal.legalAcknowledgment">I acknowledge</label><label>Full name<input name="legal.legalAcknowledgmentName"></label></form>';
async function legalStep(t, employmentData, applicationData = {}) {
  const h = await adapterPage(t, {
    site: "tesla",
    html,
    url: "https://www.tesla.com/careers/search/job/apply/1",
  });
  const current = {
    ...profile,
    applicationData,
    nameData: { firstName: "Example", lastName: "Applicant" },
    addressData: { country: "United States" },
    ...(employmentData === undefined
      ? { employmentData: {} }
      : { employmentData }),
  };
  await h.fill((w) => w.teslaFillLegalPage(current), { current });
  return h;
}

test("Tesla sponsorship uses the bound Profile and the actual question, with the other legal-page actions", async (t) => {
  for (const value of [true, false]) {
    const h = await legalStep(
      t,
      { sponsorship: value },
      { sponsorshipNow: value },
    );
    assert.deepEqual(h.checked('input[type="radio"]'), [value ? "yes" : "no"]);
    assert.equal(
      h.doc.querySelector('[name="legal.legalAcknowledgment"]').checked,
      false,
    );
    assert.equal(
      h.value('[name="legal.legalAcknowledgmentName"]'),
      "Example Applicant",
    );
  }
});

test("Tesla leaves sponsorship untouched when the Profile has no confirmed Boolean", async (t) => {
  for (const employmentData of [
    undefined,
    {},
    { sponsorship: undefined },
    { sponsorship: null },
    { sponsorship: "" },
    { sponsorship: "false" },
    { sponsorship: "true" },
    { sponsorship: 0 },
    { sponsorship: 1 },
  ]) {
    const h = await legalStep(t, employmentData);
    assert.deepEqual(
      h.checked('input[type="radio"]'),
      [],
      JSON.stringify(employmentData),
    );
  }
});
