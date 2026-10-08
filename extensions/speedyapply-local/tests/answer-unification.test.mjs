import test from "node:test";
import assert from "node:assert/strict";
import { initializeOptionMatch } from "../src/custom/option-match.js";
import { initializeProfileAnswers } from "../src/custom/profile-answers.js";
import {
  initializeAnswerResolver,
  JobsAnswerResolver,
} from "../src/custom/answer-resolver.js";
initializeOptionMatch();
initializeProfileAnswers();
initializeAnswerResolver();
// These regressions protect the new boundary: the deleted whole-question
// classifier and keyword memory engine must not decide compound personal facts.
// Retained typed answer/option behavior has the frozen 1,074-case matrix.
const cases = [
  "Do you require sponsorship and a security clearance?",
  "Are you authorized to work in the United States and hold a security clearance?",
  "Are you authorized to work in the United States or Canada?",
  "Will you be 18 years of age by the internship start date?",
  "Do you require sponsorship and relocation assistance?",
  "Are you authorized to work in Canada?",
  "Are you a current Federal, State or Local Government employee, including military, or have you at any time in the past 5 years been an employee of one of these entities?",
  "Do you now, or in the future, require Intel to sponsor you for a visa to work in the United States? NOTE: Individuals with work authorization issued pursuant to their student visa (e.g., F-1, J-1, M-1) should answer Yes.",
  "How many years of experience do you have programming in C or C++?",
  "What percentage of your time is currently spent doing direct coding?",
  "If your response to question 9 is No, please specify the country or countries where you have citizenship or lawful permanent resident status.",
];
for (const question of cases)
  test(`complete question delegated: ${question}`, async () => {
    const profile = {
      nameData: { firstName: "Example", lastName: "Applicant" },
      employmentData: {
        eligibilityUS: true,
        sponsorship: false,
        veteran: true,
        age: 22,
      },
      applicationData: {
        sponsorshipNow: false,
        sponsorshipFuture: false,
        onsite: true,
        relocate: true,
      },
    };
    const saved = [
      { origin: "person", question, response: "No" },
      {
        origin: "person",
        keywords: ["sponsorship", "response", "employee"],
        appearances: 1,
        response: "Yes",
      },
    ];
    const original = structuredClone(saved);
    let decision;
    const answers = await JobsAnswerResolver.resolve(
      [{ question, options: ["Yes", "No"], required: true }],
      profile,
      { saved, onDecision: (value) => (decision = value) },
    );
    assert.deepEqual(answers, []);
    assert.equal(decision.status, "unmatched");
    assert.equal(decision.reason, "server_decision_required");
    assert.deepEqual(saved, original);
  });
