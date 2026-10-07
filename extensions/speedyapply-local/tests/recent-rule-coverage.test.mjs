import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const c = vm.createContext({});
for (const name of ["option-match", "profile-answers"])
  vm.runInContext(
    await readModule(
      new URL(`../src/custom/${name}.js`, import.meta.url),
      "utf8",
    ),
    c,
  );
const resolve = installAnswerResolver(c);
const profile = {
  nameData: { firstName: "Alex", lastName: "Example" },
  addressData: { country: "United States of America", state: "California" },
  employmentData: { eligibilityUS: true, veteran: false },
  applicationData: {
    sponsorshipNow: false,
    sponsorshipFuture: true,
    earliestStartDate: "2027-06-01",
    pronouns: "He/him",
  },
  educationData: [
    {
      school: "Example University",
      fieldOfStudy: "Physics",
      currentlyAttending: true,
      endDate: "2028-05",
    },
  ],
};

test("observed cross-platform factual wording resolves without supplemental AI", async () => {
  const cases = [
    ["Please state your full legal name:✱", "Alex Example"],
    ["School / University Name", "Example University"],
    ["Major / Field of Study", "Physics"],
    ["Personal Pronouns*", "He/him"],
    ["Which U.S. State or Canadian Province do you reside in?*", "California"],
    ["Are you currently enrolled and actively pursuing a degree?*", "Yes"],
    ["When would you be available to start?*", "2027-06-01"],
    ["When would you be available if an offer was accepted?*", "2027-06-01"],
    [
      "Please indicate the specific date you anticipate you’d be available to start a fulltime internship.*",
      "2027-06-01",
    ],
    ["When do you expect to complete your degree program?*", "May 2028"],
  ];
  for (const [question, expected] of cases) {
    const result = await resolve([{ question, required: true }], profile);
    assert.equal(result[0]?.answer, expected, question);
    assert.equal(result[0]?.source, "profile", question);
  }
});

test("observed veteran headings retain the protected-status distinction", async () => {
  for (const question of [
    "Please select from the Veteran Statuses below:*",
    "Veteran/Military Status*",
    "Are you a protected veteran? (Veteran status definitions can be found in the instructions above)*",
    "Do you identify as one of the following protected veterans (Disabled Veteran, Recently Separated Veteran, Active Duty Wartime or Campaign Badge Veteran, Armed Forces Service Medal Veteran)?*",
  ]) {
    const result = await resolve(
      [
        {
          question,
          required: true,
          options: ["I am a protected veteran", "I am not a protected veteran"],
        },
      ],
      profile,
    );
    assert.equal(result[0]?.answer, "I am not a protected veteran", question);
    const unknown = await resolve(
      [
        {
          question,
          required: true,
          options: ["I am a protected veteran", "I am not a protected veteran"],
        },
      ],
      { ...profile, employmentData: { veteran: true } },
    );
    assert.equal(
      unknown.length,
      0,
      "veteran=true does not prove protected status",
    );
  }
});

test("catalog decoration and explicit fluency use one proficiency policy", () => {
  const api = c.JobsProfileAnswers,
    pick = c.JobsOptionMatch.pick;
  for (const label of ["Fluent", "3 - Fluent", "4. Fluent", "Fluent (4)"])
    assert.equal(
      pick(
        ["1 - Basic", "2 - Intermediate", label],
        api.languageSpec("Full Professional Proficiency", { fluent: true }),
      )?.label,
      label,
    );
  assert.equal(
    pick(["Basic", "Fluent"], api.languageSpec("", { fluent: true }))?.label,
    "Fluent",
  );
  assert.equal(
    pick(
      ["Basic", "Fluent"],
      api.languageSpec("Intermediate", { fluent: false }),
    ),
    null,
  );
  assert.equal(
    pick(
      ["Native Speaker"],
      api.languageSpec("Full Professional Proficiency", { fluent: true }),
    ),
    null,
  );
  assert.equal(
    pick(
      ["3 - Fluent", "4 - Fluent"],
      api.languageSpec("Full Professional Proficiency"),
    ),
    null,
    "ambiguous levels remain unresolved",
  );
});

test("observed source wording reuses the existing recruiting-source rule", async () => {
  for (const question of [
    "How did you hear about this internship?",
    "How did you first learn about Example as an employer?",
    "Tell us how you heard about Example and this job!*",
  ]) {
    const result = await resolve(
      [
        {
          question,
          required: true,
          options: ["LinkedIn", "Employee Referral"],
        },
      ],
      profile,
    );
    assert.equal(result[0]?.answer, "LinkedIn", question);
  }
});

test("employer and visa phrases do not turn the documented US jurisdiction into UNKNOWN", async () => {
  for (const question of [
    "Do you require immigration sponsorship to work for Affirm in the United States?",
    "Will you now or in the future require sponsorship for a U.S. employment visa (e.g. H-1B)?",
    "Are you legally authorized to work in the country for which you are applying?",
    "Do you now, or will you in the future, require sponsorship for employment to work legally in the country where the job will be based?",
  ]) {
    assert.equal(
      c.JobsProfileAnswers.requestedCountry(question, {}, "US"),
      "US",
      question,
    );
    const result = await resolve(
      [{ question, required: true, options: ["Yes", "No"] }],
      profile,
    );
    assert.equal(result[0]?.answer, "Yes", question);
  }
  assert.equal(
    c.JobsProfileAnswers.requestedCountry(
      "Do you need sponsorship to work for Example in Chile?",
      {},
      "US",
    ),
    "UNKNOWN",
  );
  assert.equal(
    c.JobsProfileAnswers.requestedCountry(
      "Do you need sponsorship to work for Example in Canada?",
      {},
      "US",
    ),
    "CA",
  );
});
