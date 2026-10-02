import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const sandbox = vm.createContext({});
vm.runInContext(
  await Promise.all(
    ["option-match", "profile-answers"].map((n) =>
      readModule(
        new URL("../src/custom/" + n + ".js", import.meta.url),
        "utf8",
      ),
    ),
  ).then((parts) => parts.join("\n")),
  sandbox,
);
const api = sandbox.JobsProfileAnswers;
const p = {
  nameData: { firstName: "Sample", lastName: "Person", preferredName: false },
  addressData: {
    city: "Example",
    state: "California",
    postalCode: "12345",
    country: "United States",
  },
  educationData: [
    {
      school: "Example University",
      degree: "Bachelor's",
      fieldOfStudy: "Physics",
      currentlyAttending: true,
      startDate: "2024-08",
      endDate: "2028-05",
      gpa: "3.8/4.0",
    },
  ],
  jobData: [
    {
      jobTitle: "Engineering Intern",
      company: "Example Co",
      startDate: "2026-01",
      endDate: "2026-04",
    },
  ],
  employmentData: {
    ethnicity: "Asian",
    hispanicOrLatino: false,
    gender: "Male",
  },
  languageData: [
    {
      language: "English",
      proficiency: "Full Professional Proficiency",
      fluent: true,
    },
  ],
  skillsData: ["Python", "React", "Java", "Git"],
  applicationData: {
    visaStatus: "F-1",
    earliestStartDate: "2028-05-17",
    highestCompletedEducation: "High School",
    interviewLanguage: "Python",
  },
};
const answer = (q, profile = p, context = {}) =>
  api.resolve(q, profile, { now: "2026-09-19", ...context })?.answer ?? null;

test("observed identity, education and experience wording resolves from existing fields", () => {
  for (const [q, expected] of [
    ["What is your current location?*", "Example, California"],
    ["Are you in school?*", "Yes"],
    ["Are you currently enrolled in a degree seeking program?*", "Yes"],
    ["Start Date at Current School:\n✱", "August 2024"],
    [
      "Please re-confirm the university you currently attend *",
      "Example University",
    ],
    [
      "What is the highest level of education you are pursuing or have completed?*",
      "Bachelor's",
    ],
    [
      "What degree level are you currently pursuing, or have you most recently completed?*",
      "Bachelor's",
    ],
    [
      "Please confirm your highest level of study.\n\n(This should be either your current study level or the most recently completed one, if you recently completed.)*",
      "Bachelor's",
    ],
    [
      "What is your current overall GPA (Please convert to 4.0 scale) ?*",
      "3.8",
    ],
    [
      "If you are currently enrolled in a degree program (BS, MS or PhD) or have just completed one, please indicate your GPA.",
      "3.8",
    ],
    [
      "For Your Current / Most Recent Education Please provide Result Scale*",
      "4.0",
    ],
    ["What is your race/ethnicity?*", "Asian"],
    ["Please select race/ethnicity:*", "Asian"],
    [
      "Which ethnicity(ies) do you identify with? Please select all that apply.",
      "Asian",
    ],
    [
      "What is your gender? Please note, you will be able to select your gender identity in the next question.*",
      "Male",
    ],
    [
      "Indicate your proficiency of the English language:*",
      "Full Professional Proficiency",
    ],
    [
      "Have you previously completed at least 1 internship or have relevant full-time experience? *",
      "Yes",
    ],
    [
      "Did you previously work or are you currently working as an intern or a co-op?*",
      "Yes",
    ],
    [
      "Which scripting / programming languages do you have experience with?*",
      "Python, Java",
    ],
  ])
    assert.equal(answer(q), expected, q);
  const term = "What term did you (or will you) graduate in?*",
    options = ["Spring (April - June)", "Fall (September - December)"];
  assert.equal(
    api.select(api.resolve(term, p, { options }), options),
    "Spring (April - June)",
  );
  assert.equal(answer(term), null);
});

test("new fields handle observed prompts without turning availability into commitments", () => {
  for (const q of [
    "When can you start a new job?*",
    "What's your earliest start date?*",
    "If offered a position, when would you be available to start?*",
    "When would you be available to start work?*",
  ])
    assert.equal(answer(q), "2028-05-17", q);
  assert.equal(
    answer(
      "What date are you available to begin employment (Month and Year) ✱",
    ),
    "May 2028",
  );
  assert.equal(answer("Please confirm your visa type?*"), "F-1");
  assert.equal(
    answer("Please indicate your current US employment visa status*"),
    "F-1",
  );
  for (const q of [
    "Please confirm the highest level of education that you have completed.*",
    "Please indicate the highest level of education you have completed:*",
    "What is your highest level of education achieved?*",
  ])
    assert.equal(answer(q), "High School", q);
  assert.equal(answer("Preferred Programming Language(s)*"), "Python");
  for (const q of [
    "Please detail the duration of your notice period?*",
    "Are you able to work full-time onsite from January through April?",
    "Are you eligible for a 24-month OPT extension based upon a US degree in STEM?",
    "If you previously answered Yes to requiring sponsorship, select your visa type",
  ])
    assert.equal(answer(q), null, q);
  const result = api.resolve(
    "If offered employment, how soon could you start work?*",
    p,
    { now: "2026-09-19" },
  );
  assert.equal(
    api.select(result, ["Immediately", "2 weeks", "Greater than 4 weeks"]),
    "Greater than 4 weeks",
  );
  assert.equal(
    api.select(result, ["Greater than 2 weeks", "Greater than 4 weeks"]),
    null,
  );
  assert.equal(api.select(result, ["May 2028", "June 2028"]), "May 2028");
  assert.equal(api.select(result, ["2028-05-01", "2028-05-17"]), "2028-05-17");
  assert.equal(
    api.select(result, ["May 17, 2028", "May 18, 2028"]),
    "May 17, 2028",
  );
  assert.equal(
    answer(
      "What are your compensation requirements? Please indicate a dollar amount.*",
      { ...p, applicationData: { salaryPreference: "posted_range" } },
    ),
    null,
  );
});

test("school abbreviations retain exact campus identity and reject ambiguous catalogs", () => {
  const q = "Current University*",
    profile = {
      ...p,
      educationData: [
        {
          ...p.educationData[0],
          school: "University of California, Los Angeles",
        },
      ],
    };
  const result = api.resolve(q, profile);
  assert.equal(
    api.select(result, ["UC Los Angeles", "UC Berkeley"]),
    "UC Los Angeles",
  );
  assert.equal(
    api.select(result, [
      "UC Los Angeles",
      "University of California, Los Angeles",
    ]),
    null,
  );
  assert.equal(
    api.select(result, [
      "University of California",
      "Berkeley College",
      "UC Berkeley",
    ]),
    null,
  );
  assert(api.covers({ question: q, response: "UC Los Angeles" }, profile));
  assert(
    !api.schoolMatches(
      "Berkeley College",
      "University of California, Berkeley",
    ),
  );
});

test("known numeric scales and demographic aliases do not infer different facts", () => {
  const result = api.resolve(
    "For Your Current / Most Recent Education Please provide Result Scale*",
    p,
  );
  assert.equal(api.select(result, ["1.0 to 5.0", "1.0 to 4.0"]), "1.0 to 4.0");
  assert.equal(api.select(result, ["1.0 to 5.0"]), null);
  assert.equal(
    answer(
      "What is your current overall GPA (Please convert to 4.0 scale) ?*",
      { ...p, educationData: [{ gpa: "4.5/5.0" }] },
    ),
    null,
  );
  const ethnicity = api.resolve("Please select race/ethnicity:*", p);
  assert.equal(
    api.select(ethnicity, ["Asian (not Hispanic or Latino)", "White"]),
    "Asian (not Hispanic or Latino)",
  );
  assert.equal(
    api.select(
      api.resolve("Please select race/ethnicity:*", {
        ...p,
        employmentData: { ethnicity: "Asian" },
      }),
      ["Asian (not Hispanic or Latino)"],
    ),
    null,
  );
  assert.equal(
    answer("Are you currently enrolled in an accredited college program? *"),
    null,
  );
  assert.equal(
    answer("Have you received a competitive academic scholarship?"),
    null,
  );
  assert.equal(
    api.select(ethnicity, ["Asian (United States of America)", "White"]),
    "Asian (United States of America)",
  );
  assert.equal(
    api.select(ethnicity, ["Asian or Asian American", "White"]),
    "Asian or Asian American",
  );
  const english = api.resolve(
    "Indicate your proficiency of the English language:*",
    p,
  );
  assert.equal(
    api.select(english, ["Fluent / Native Speaker", "Intermediate"]),
    "Fluent / Native Speaker",
  );
  assert.equal(api.select(english, ["Native speaker"]), null);
  assert.equal(
    answer("Website", {
      ...p,
      websiteData: { github: "https://github.example/profile", websites: [] },
    }),
    "https://github.example/profile",
  );
  assert.equal(
    answer("Company website", {
      ...p,
      websiteData: { github: "https://github.example/profile" },
    }),
    null,
  );
});

test("required preferred-name fields reuse legal names only with an explicit no-alternate-name setting", () => {
  assert.equal(
    answer("Preferred First Name*", p, { required: true }),
    "Sample",
  );
  assert.equal(answer("Preferred Last Name*", p, { required: true }), "Person");
  assert.equal(
    answer("What is your preferred name?*", p, { required: true }),
    "Sample Person",
  );
  assert.equal(answer("Preferred First Name", p, { required: false }), null);
  assert.equal(
    answer(
      "Preferred First Name*",
      { ...p, nameData: { firstName: "Sample" } },
      { required: true },
    ),
    null,
  );
});

test("moving-from address gives only the requested parts and makes no relocation promise", () => {
  const q =
    "Relocation assistance may be available for this role. If you would need to relocate, please tell us the city, state, and zip code you’d be moving from*";
  assert.equal(answer(q), "Example, California, 12345");
  assert.equal(
    answer("Are you willing to relocate at your own expense?"),
    null,
  );
});
