import test from "node:test";
import assert from "node:assert/strict";
import { readModule } from "./helpers/module-source.mjs";
import vm from "node:vm";
const sandbox = vm.createContext({});
vm.runInContext(
  (
    await Promise.all(
      ["option-match", "profile-answers"].map((n) =>
        readModule(
          new URL("../src/custom/" + n + ".js", import.meta.url),
          "utf8",
        ),
      ),
    )
  ).join("\n"),
  sandbox,
);
const api = sandbox.JobsProfileAnswers;
const profile = {
  applicationData: {
    willingToRelocate: true,
    willingToWorkOnsite: true,
    willingToTravel: true,
    hasRelatedPeopleAtWork: false,
  },
};
const answer = (question, p = profile) =>
  api.resolve(question, p)?.answer ?? null;

test("explicit work preferences answer variable companies and office schedules", () => {
  for (const q of [
    "Are you willing to relocate?",
    "Are you available to relocate to Boston for this position?*",
    "Do you currently reside in commutable proximity to an office or are you open to relocating?*",
    "If no, would you be open to relocation? Please explain.",
    "Are you willing to work four days per week in our office?",
    "Are you able to work onsite at our Chicago office 5 days a week?",
    "Are you able to work a hybrid schedule in office?",
    "We work in a hybrid model, Mon, Wed & Thurs. in office. Tues & Fridays work from home. Are you able to adhere to this work schedule?",
    "This position is based out of Plano, TX, and will require four days working onsite, and the fifth day may be remote. Is this acceptable to you?",
    "Are you willing/able to travel, if required?",
    "Are you able to attend onsite interviews in Santa Barbara, if selected?",
  ])
    assert.equal(answer(q), "Yes", q);
});

test("confirmed absence of relevant relationships works across names, definitions and job scopes", () => {
  for (const q of [
    "Do you have any relatives employed at Example Corp?",
    "Are you related to, or in a close personal relationship with, anyone who currently works for Example or any affiliated studios?",
    "Do you know anyone that works for one of our companies?",
    "To the best of your knowledge, is any member of your family or household a current Example employee or member of the Board of Directors?",
    "Are you a relative of a current senior level person or senior commercial person for a company other than Example?",
    "Question BodyDo you have family members and/or close friends working at Example, or at any competitor, customer, supplier or business partner?",
    "Do you have any immediate family members or members of the same household that are currently or were formerly employed by Example?",
  ])
    assert.equal(answer(q), "No", q);
  assert.equal(
    answer("Do you have any relatives employed at Example Corp?", {
      applicationData: { hasRelatedPeopleAtWork: true },
    }),
    null,
  );
});

test("preferences do not invent residence, dates, hours, work authorization or personal job history", () => {
  for (const q of [
    "Do you currently live within 50 miles of the office?",
    "Which office location do you prefer?",
    "Do you need relocation assistance?",
    "If this position does not include relocation assistance, are you willing to relocate at your own expense to the job location?",
    "Are you able to work in New York City without relocation assistance?",
    "Are you able to work full-time (40 hours) in-person at one of our offices during January-April?",
    "Are you willing to relocate and legally authorized to work in Canada?",
    "Are you willing to relocate within 14 days?",
    "Are you unwilling to work onsite?",
    "Have you, or a close family member, ever been employed by Example?",
    "Do you have: a) any Personal/Familial Relationships (current employees or vendors); b) any Outside Business Activities; c) any investment; or d) any Intellectual Property Ownership?",
    "Do you have relatives employed here and are you authorized to work in this country?",
    "Do you have a disability or a family member employed here?",
    "Please acknowledge the nepotism policy for relatives employed here.",
  ])
    assert.equal(answer(q), null, q);
  assert.equal(
    answer("Are you willing to relocate?", { applicationData: {} }),
    null,
  );
  assert.equal(
    answer("Are you willing to relocate?", {
      applicationData: { willingToRelocate: false },
    }),
    "No",
  );
  assert.equal(
    answer("Do you live nearby or are you willing to relocate?", {
      applicationData: { willingToRelocate: false },
    }),
    null,
  );
  assert.equal(
    api.covers(
      { question: "Are you willing to relocate?", response: "No" },
      profile,
    ),
    false,
  );
  assert.equal(
    api.covers(
      { question: "Are you willing to relocate?", response: "Yes" },
      profile,
    ),
    true,
  );
});

test("office policy dates are distinguished from work availability dates", () => {
  assert.equal(
    answer(
      "As of January 1st, 2024, all onsite employees are required to be onsite 3x/week. Are you able to comply, or are you seeking fully remote opportunities?",
    ),
    "Yes",
  );
  assert.equal(
    answer("Are you willing to work onsite during May through August?"),
    null,
  );
  assert.equal(
    answer(
      "Do you acknowledge that this is a hybrid role and you will be required to come into the office four days a week?",
    ),
    "Yes",
  );
  assert.equal(
    answer(
      "Do you currently live within commutable distance to the office or intend to relocate to a commutable distance?",
    ),
    "Yes",
  );
});
