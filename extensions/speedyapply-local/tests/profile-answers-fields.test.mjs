import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const code = await Promise.all(
  ["option-match", "profile-answers"].map((n) =>
    readModule(new URL("../src/custom/" + n + ".js", import.meta.url), "utf8"),
  ),
).then((parts) => parts.join("\n"));
const sandbox = vm.createContext({});
vm.runInContext(code, sandbox);
const api = sandbox.JobsProfileAnswers;
const profile = (extra = {}) => ({
  nameData: {
    firstName: "Alex",
    middleName: "Lee",
    lastName: "Example",
    preferredName: true,
    preferredFirstName: "Lex",
    preferredLastName: "Example",
  },
  addressData: {
    line1: "12 Test Street",
    city: "Sample City",
    state: "California",
    postalCode: "12345",
    country: "United States",
  },
  contactData: {
    phoneDeviceType: "Mobile",
    phoneCountryCode: "+1",
    phoneNumber: "1234567890",
    email: "alex@example.test",
  },
  websiteData: { personal: "https://example.test", websites: [] },
  employmentData: {
    eligibilityUS: true,
    sponsorship: true,
    age: 21,
    gender: "Male",
    ethnicity: "Asian",
    hispanicOrLatino: false,
    veteran: false,
    disability: false,
  },
  educationData: [
    {
      school: "Sample University",
      degree: "Bachelor's",
      fieldOfStudy: "Physics",
      startDate: "2023-09",
      endDate: "2027-05",
      graduationDate: "2027-05-14",
      currentlyAttending: true,
    },
  ],
  applicationData: {
    earliestStartDate: "2027-06-01",
    highestCompletedEducation: "High School",
    visaStatus: "F-1",
    sponsorshipNow: false,
    sponsorshipFuture: true,
    pronouns: "He/him",
    interviewLanguage: "Python",
    salaryPreference: "custom",
    salaryCurrency: "USD",
    salaryPeriod: "annual_base",
    salaryMin: "100000",
    salaryMax: "120000",
  },
  ...extra,
});
const answer = (question, p = profile(), context) =>
  api.resolve(question, p, context)?.answer ?? null;

test("existing identity/contact/address/links fields use actual values, including preferred-name switch", () => {
  for (const [question, expected] of [
    ["First name", "Alex"],
    ["Last name", "Example"],
    ["Full legal name", "Alex Lee Example"],
    ["Preferred full name", "Lex Example"],
    ["Phone device type", "Mobile"],
    ["Phone country code", "+1"],
    ["Current location", "Sample City, California"],
    ["State", "California"],
    ["Website", "https://example.test"],
    ["Electronic signature", "Alex Lee Example"],
  ])
    assert.equal(answer(question), expected, question);
  assert.equal(
    answer(
      "Preferred first name",
      profile({
        nameData: {
          firstName: "Alex",
          preferredName: false,
          preferredFirstName: "stale",
        },
      }),
    ),
    null,
  );
  assert.equal(api.select(api.resolve("State", profile()), ["CA", "NY"]), "CA");
  assert.equal(
    answer(
      "Current location",
      profile({ addressData: { state: "California" } }),
    ),
    null,
  );
  assert.equal(answer("Please enter your full name"), "Alex Lee Example");
  assert.equal(
    answer("Please provide a link to your portfolio"),
    "https://example.test",
  );
  assert.equal(
    answer(
      "Please provide your LinkedIn profile URL",
      profile({ websiteData: { linkedin: "https://linkedin.example/alex" } }),
    ),
    "https://linkedin.example/alex",
  );
  for (const question of [
    "Company website",
    "Country where your school is located",
    "Have you ever used another legal name?",
  ])
    assert.equal(api.resolve(question, profile()), null, question);
});

test("graduation day precision is opt-in and is never invented from a month", () => {
  assert.equal(answer("Graduation date"), "May 2027");
  assert.equal(
    answer("Graduation date", profile(), { inputType: "date" }),
    "2027-05-14",
  );
  assert.equal(
    answer("Graduation date", profile(), { inputType: "month" }),
    "2027-05",
  );
  assert.equal(answer("Graduation date (MM/DD/YYYY)"), "05/14/2027");
  assert.equal(answer("Graduation date (DD/MM/YYYY)"), "14/05/2027");
  const month = profile({ educationData: [{ endDate: "2027-05" }] });
  assert.equal(answer("Graduation date", month), "May 2027");
  assert.equal(answer("Graduation date", month, { inputType: "date" }), null);
  assert.equal(
    api.resolve("Graduation date", month, { inputType: "date" }).reason,
    "missing_day_precision",
  );
  assert.equal(
    answer(
      "Graduation date",
      profile({
        educationData: [{ endDate: "2027-05", graduationDate: "2027-05-32" }],
      }),
      { inputType: "date" },
    ),
    null,
  );
  assert.equal(
    answer(
      "Graduation date",
      profile({
        educationData: [{ endDate: "2027-06", graduationDate: "2027-05-14" }],
      }),
      { inputType: "date" },
    ),
    null,
  );
  assert.equal(
    answer(
      "Graduation year",
      profile({ educationData: [{ endDate: "2027-05" }, {}] }),
    ),
    "2027",
  ); // preserve original selection until explicit education scoping is supplied
});

test("graduation ranges and enrollment dates retain previous component-independent selection", () => {
  const result = api.resolve("Graduation date", profile());
  for (const label of [
    "May/June 2027",
    "May–Aug 2027",
    "January 2027 - June 2027",
  ])
    assert.equal(api.select(result, [label]), label);
  assert.equal(api.select(result, ["May/June 2027", "May–Aug 2027"]), null);
  assert.equal(answer("School start date"), "September 2023");
  assert.equal(
    answer("School start date", profile(), { inputType: "date" }),
    null,
  );
});

test("completed degree and attending are independent facts with conflicts blocked", () => {
  assert.equal(answer("Highest completed education"), "High School");
  assert.equal(
    answer("What is the highest degree you have completed?"),
    "High School",
  );
  assert.equal(answer("What degree are you currently pursuing?"), "Bachelor's");
  assert.equal(answer("Are you currently enrolled in a university?"), "Yes");
  const contradictory = profile({
    educationData: [{ currentlyAttending: false, endDate: "2027-05" }],
  });
  assert.equal(
    api.resolve("Are you currently a student?", contradictory, {
      now: "2026-09",
    }).reason,
    "education_status_conflict",
  );
  assert.equal(
    answer("Highest completed education", profile({ applicationData: {} })),
    null,
  );
  assert.equal(
    answer("Have you graduated?", profile(), { now: "2028-01" }),
    null,
  );
});

test("new direct factual and preference fields do not turn qualifications into guesses", () => {
  for (const [question, expected] of [
    ["What is your earliest available start date?", "2027-06-01"],
    ["When can you start working?", "2027-06-01"],
    ["Visa type", "F-1"],
    ["Please share your gender pronouns.", "He/him"],
    ["Preferred interview programming language", "Python"],
  ])
    assert.equal(answer(question), expected, question);
  assert.equal(
    answer("When can you start working?", profile({ applicationData: {} })),
    null,
  );
  for (const question of [
    "Can you start before May 2027?",
    "Can you transfer your F-1 visa?",
    "Are you an advanced Python programmer?",
    "Are you eligible for STEM OPT?",
  ])
    assert.equal(api.resolve(question, profile()), null, question);
});

test("sponsorship current/future/combined semantics use tri-state data and only scoped legacy fallback", () => {
  const p = profile();
  assert.equal(answer("Do you currently need sponsorship?", p), "No");
  assert.equal(answer("Will you need sponsorship in the future?", p), "Yes");
  assert.equal(
    answer("Will you now or in the future require sponsorship?", p),
    "Yes",
  );
  const legacy = profile({
    applicationData: {},
    employmentData: { sponsorship: true },
  });
  assert.equal(answer("Will you require sponsorship?", legacy), "Yes");
  assert.equal(answer("Do you currently need sponsorship?", legacy), null);
  assert.equal(
    answer("Will you need sponsorship in the future?", legacy),
    null,
  );
  const partial = profile({ applicationData: { sponsorshipNow: false } });
  assert.equal(
    answer("Will you now or in the future require sponsorship?", partial),
    null,
  );
  assert.equal(
    answer(
      "Will you now or in the future require sponsorship?",
      profile({ applicationData: { sponsorshipNow: true } }),
    ),
    "Yes",
  );
  assert.equal(
    answer(
      "Will you now or in the future require sponsorship?",
      profile({
        applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
      }),
    ),
    "No",
  );
  for (const country of ["Canada", "Japan", "Denmark"])
    assert.equal(
      answer(`Will you require sponsorship to work in ${country}?`, p),
      null,
      country,
    );
  assert.equal(
    answer("Will you require sponsorship?", p, { country: "MIXED" }),
    null,
  );
});

test("sponsorship long options need the actual timing, not the first Yes", () => {
  const question = "Will you now or in the future require sponsorship?";
  const now =
    "Yes, I will require immigration sponsorship now to legally work in the country where the job is located.";
  const future =
    "Yes, I will require immigration sponsorship in the future to legally work in the country where the job is located.";
  const no =
    "No, I do not and will not require immigration sponsorship now or in the future.";
  assert.equal(
    api.select(api.resolve(question, profile()), [now, future, no]),
    future,
  );
  assert.equal(
    api.select(api.resolve(question, profile({ applicationData: {} })), [
      now,
      future,
      no,
    ]),
    null,
  );
  assert.equal(
    api.select(
      api.resolve(
        question,
        profile({
          applicationData: { sponsorshipNow: true, sponsorshipFuture: false },
        }),
      ),
      [now, future, no],
    ),
    now,
  );
  assert.equal(
    api.select(
      api.resolve(
        question,
        profile({
          applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
        }),
      ),
      [now, future, no],
    ),
    no,
  );
});

test("US work authorization uses named fact, rejects different countries and compound permissions", () => {
  assert.equal(answer("Are you eligible to work in the United States?"), "Yes");
  assert.equal(
    answer(
      "Are you eligible to work in the country where the job is located?",
      profile(),
      { country: "US" },
    ),
    "Yes",
  );
  assert.equal(answer("Are you eligible to work in Canada?"), null);
  assert.equal(
    answer("Are you eligible to work?", profile(), { country: "MIXED" }),
    null,
  );
  assert.equal(
    api.resolve(
      "Are you legally authorized to work without restrictions?",
      profile(),
    ),
    null,
  );
  for (const label of [
    "Yes, I am a U.S. citizen",
    "Yes, I am a permanent resident",
    "Yes, I am authorized to work in Canada",
  ])
    assert.equal(
      api.select(
        api.resolve(
          "Are you eligible to work in the United States?",
          profile(),
        ),
        [label, "No"],
      ),
      null,
    );
  assert.equal(
    api.select(
      api.resolve(
        "Are you legally authorized to work in the United States?",
        profile(),
      ),
      [
        "Yes, I am currently legally authorized to work in the United States.",
        "No",
      ],
    ),
    "Yes, I am currently legally authorized to work in the United States.",
  );
  assert.equal(
    api.scope([{ question: "Are you authorized to work in Malaysia?" }]),
    "UNKNOWN",
  ); // explicit unknown place must not inherit the home country
});

test("additional authorization wording preserves the original stored-country boundary", () => {
  const canada = profile({ addressData: { country: "Canada" } }),
    unknown = profile({ addressData: { country: "" } });
  for (const p of [canada, unknown]) {
    assert.equal(
      api.resolve("Are you eligible to work in the United States?", p),
      null,
    );
    assert.equal(
      api.resolve("Are you eligible to work?", p, { country: "US" }),
      null,
    );
    assert.equal(
      answer(
        "Will your employment require sponsorship now or in the future to work in the United States?",
        p,
      ),
      null,
    );
  }
  assert.equal(
    answer("Are you eligible to work in the United States?", profile()),
    "Yes",
  );
  assert.equal(
    answer("Are you eligible to work?", profile(), { country: "US" }),
    "Yes",
  );
  assert.equal(
    answer("Will you require sponsorship?", canada, { country: "US" }),
    null,
  );
});

test("salary preserves units/currency/ranges and refuses conversion or number-only ambiguity", () => {
  assert.equal(
    answer("What are your salary expectations?"),
    "USD 100000–120000 annual base salary",
  );
  assert.equal(answer("What is your expected hourly pay?"), null);
  assert.equal(
    answer("What is your expected annual base salary in CAD?"),
    null,
  );
  assert.equal(
    answer("What is your expected annual total compensation?"),
    null,
  );
  assert.equal(
    answer("What is your expected salary?", profile(), { inputType: "number" }),
    null,
  );
  const fixed = profile({
    applicationData: {
      salaryPreference: "custom",
      salaryCurrency: "USD",
      salaryPeriod: "annual_base",
      salaryMin: "105000",
    },
  });
  assert.equal(
    answer("What is your expected annual base salary in USD?", fixed, {
      inputType: "number",
    }),
    "105000",
  );
  assert.equal(
    answer("What is your expected annual salary in USD?", fixed, {
      inputType: "number",
    }),
    null,
  );
  assert.equal(answer("Expected salary currency", fixed), "USD");
  assert.equal(
    answer("Minimum expected annual base salary in USD", fixed),
    "USD 105000 annual base salary",
  );
  assert.equal(api.resolve("What is your current salary?", fixed), null);
  assert.equal(
    api.resolve("Would you accept a salary of USD 80000?", fixed),
    null,
  );
  const result = api.resolve("Expected annual base salary in USD", fixed);
  assert.equal(
    api.select(result, [
      "USD 80000–100000 annual base salary",
      "USD 100000–120000 annual base salary",
    ]),
    "USD 100000–120000 annual base salary",
  );
  assert.equal(
    api.select(result, ["CAD 100000–120000 annual base salary"]),
    null,
  );
});

test("negotiable/posted salary preferences never invent numeric salary values", () => {
  for (const [salaryPreference, expected] of [
    ["negotiable", "Negotiable"],
    ["posted_range", "Within the posted salary range"],
  ]) {
    const p = profile({ applicationData: { salaryPreference } });
    assert.equal(answer("Salary expectations", p), expected);
    assert.equal(
      answer("Salary expectations", p, { inputType: "number" }),
      null,
    );
    assert.equal(answer("Maximum expected salary", p), null);
  }
});

test("demographic and age facts remain separate from related sensitive definitions", () => {
  assert.equal(
    api.select(api.resolve("Gender", profile()), ["Woman", "Man"]),
    "Man",
  );
  assert.equal(answer("Ethnicity"), "Asian");
  assert.equal(answer("Are you Hispanic or Latino?"), "No");
  assert.equal(answer("Are you a veteran?"), "No");
  assert.equal(answer("Are you at least 18?"), "Yes");
  assert.equal(answer("Are you over the age of 21?"), "No");
  assert.equal(answer("Are you a protected veteran?"), "No");
  assert.equal(
    answer(
      "Are you a protected veteran?",
      profile({ employmentData: { veteran: true } }),
    ),
    null,
  );
  for (const question of [
    "Gender identity",
    "Sexual orientation",
    "Have you ever had a disability?",
    "Are you 18 and authorized to work?",
  ])
    assert.equal(api.resolve(question, profile()), null, question);
  assert.equal(
    answer(
      "Are you at least 18?",
      profile({ employmentData: { age: "undisclosed" } }),
    ),
    null,
  );
});

test("employment is ordered by dates with positive-only incomplete history evidence", () => {
  const p = profile({
    jobData: [
      { company: "Older", jobTitle: "Engineering Intern", endDate: "2024-08" },
      { company: "Newer", jobTitle: "Assistant", endDate: "2025-08" },
    ],
  });
  assert.equal(answer("Most recent employer", p), "Newer");
  assert.equal(answer("Current employer", p), null);
  assert.equal(
    api.resolve("Have you completed an internship?", p, { now: "2026-09" })
      .answer,
    "Yes",
  );
  assert.equal(
    answer("Have you completed an internship?", profile({ jobData: [] })),
    null,
  );
  assert.equal(
    answer(
      "Most recent employer",
      profile({
        jobData: [{ company: "One" }, { company: "Two", endDate: "2025-08" }],
      }),
    ),
    null,
  );
  assert.equal(api.resolve("Have you ever worked at Example?", p), null);
});

test("one public resolver preserves old sponsorship while explicit new facts stay isolated by Profile", () => {
  const legacy = profile({ applicationData: {} }),
    first = profile(),
    second = profile({
      applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
    });
  assert.equal(api.supplement, undefined);
  assert.equal(answer("Will you need sponsorship?", legacy), "Yes");
  assert.equal(answer("Will you need sponsorship?", first), "Yes");
  assert.equal(answer("Will you need sponsorship?", second), "No");
  assert.equal(answer("Will you need sponsorship?", first), "Yes");
  assert.equal(
    answer("Graduation date", first, { inputType: "date" }),
    "2027-05-14",
  );
  assert.equal(
    answer(
      "Graduation date",
      profile({ educationData: [{ endDate: "2028-12" }] }),
    ),
    "December 2028",
  );
});

test("actual shared matcher retains Saved Answer fallback when newly added optional fields are empty", async () => {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  vm.runInContext(
    resolverWith(`[
  {question:'Preferred interview programming language',response:'Rust',keywords:['interview','language'],appearances:2},
  {question:'When can you start working?',response:'2027-07-01',keywords:['start','working'],appearances:2}
 ]`),
    context,
  );
  const questions = [
    { question: "Preferred interview programming language" },
    { question: "When can you start working?" },
  ];
  const unchanged = await context.JobsAnswerResolver.resolve(
    questions,
    profile({ applicationData: {} }),
  );
  assert.equal(unchanged[0].answer, "Rust");
  assert.equal(unchanged[1].answer, "2027-07-01");
  const explicitlyFilled = await context.JobsAnswerResolver.resolve(
    questions,
    profile(),
  );
  assert.equal(explicitlyFilled[0].answer, "Python");
  assert.equal(explicitlyFilled[1].answer, "2027-06-01");
});

test("actual shared matcher respects calendar precision and explicit employment sponsorship timing", async () => {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  vm.runInContext(resolverWith("[]"), context);
  const graduation = [{ question: "Graduation date", inputType: "date" }],
    monthOnly = profile({ educationData: [{ endDate: "2027-05" }] });
  assert.equal(
    (await context.JobsAnswerResolver.resolve(graduation, monthOnly)).length,
    0,
  );
  assert.equal(
    (await context.JobsAnswerResolver.resolve(graduation, profile()))[0].answer,
    "2027-05-14",
  );
  assert.equal(
    (
      await context.JobsAnswerResolver.resolve(
        [{ question: "Graduation month" }],
        monthOnly,
      )
    )[0].answer,
    "May",
  );
  const question =
    "Will your employment require sponsorship now or in the future?";
  assert.equal(api.classify(question).topic, "sponsorship"); // One classifier for old and expanded Profiles.
  assert.equal(
    (
      await context.JobsAnswerResolver.resolve(
        [{ question }],
        profile({ applicationData: {} }),
      )
    )[0].answer,
    "Yes",
  );
  assert.equal(
    (
      await context.JobsAnswerResolver.resolve(
        [{ question }],
        profile({
          applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
        }),
      )
    )[0].answer,
    "No",
  );
  assert.equal(
    (
      await context.JobsAnswerResolver.resolve(
        [{ question }],
        profile({ applicationData: { sponsorshipNow: false } }),
      )
    ).length,
    0,
  );
  for (const compound of [
    "Will your employment require sponsorship and authorization to work?",
    "Will your employment require sponsorship without permanent residency?",
  ]) {
    assert.equal(api.resolve(compound, profile()), null, compound);
    assert.equal(
      api.resolve(compound, profile({ applicationData: {} })),
      null,
      compound,
    );
  }
});

test("unrecognized sponsorship wording requires exact memory for every Profile version", async () => {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const question = "Will this role require sponsorship from our company?";
  vm.runInContext(
    resolverWith(
      `[{question:${JSON.stringify(question)},response:'Yes',keywords:['require','sponsorship'],appearances:2}]`,
    ),
    context,
  );
  const legacy = profile({ applicationData: {} }),
    explicit = profile({
      applicationData: { sponsorshipNow: false, sponsorshipFuture: false },
    });
  assert.equal(api.resolve(question, legacy), null);
  assert.equal(
    (await context.JobsAnswerResolver.resolve([{ question }], legacy))[0]
      .answer,
    "Yes",
  );
  assert.equal(api.resolve(question, explicit), null);
  const exact = await context.JobsAnswerResolver.resolve(
    [{ question }],
    explicit,
  );
  assert.equal(exact[0].answer, "Yes");
  assert.equal(exact[0].reason, "saved_exact_question");
  for (const compound of [
    "Will you require sponsorship and be legally authorized to work?",
    "Can you work without visa sponsorship?",
  ]) {
    assert.equal(api.resolve(compound, explicit), null);
    assert.equal(
      (
        await context.JobsAnswerResolver.resolve(
          [{ question: compound }],
          explicit,
        )
      ).length,
      0,
    );
  }
  assert.equal(api.resolve("When can you start working?", legacy), null); // Other absent new fields retain their old fallback.
});

test("capture equivalence preserves corrections and precision even after wider field coverage", () => {
  const p = profile();
  for (const record of [
    { question: "Will you need sponsorship?", response: "No" },
    { question: "Graduation date", response: "May 2028" },
    { question: "Graduation date", response: "2027" },
    { question: "Graduation date", response: "2027-05-14" },
    { question: "Graduation date", response: "Spring 2027" },
  ])
    assert.equal(api.covers(record, p), false, JSON.stringify(record));
  assert.equal(
    api.covers({ question: "Graduation date", response: "May 2027" }, p),
    true,
  );
  assert.equal(
    api.covers({ question: "Will you need sponsorship?", response: "Yes" }, p, {
      country: "Canada",
    }),
    false,
  );
  assert.equal(
    api.covers({ question: "Graduation date", response: "2027-05-14" }, p, {
      inputType: "date",
    }),
    true,
  );
});

test("search terms belong to the answer rule: a school tries its full name, campus, then a distinctive word; a place its city in its state", () => {
  assert.deepEqual(
    Array.from(api.schoolSpec("University of California, Berkeley").queries),
    ["University of California, Berkeley", "Berkeley", "California"],
  );
  assert.deepEqual(
    Array.from(api.schoolSpec("Stanford University (CA)").queries),
    ["Stanford University", "Stanford"],
    "a catalog region suffix is not searched",
  );
  assert.deepEqual(
    Array.from(
      api.locationSpec({
        city: "Sample City",
        state: "California",
        country: "United States",
      }).queries,
    ),
    ["Sample City, California", "Sample City"],
  );
  const place = api.resolve("Location (City)", profile());
  assert.equal(place.answer, "Sample City, California");
  assert.equal(place.optionSpec.topic, "location");
  assert.equal(
    api.resolve(
      "Location (City)",
      profile({ addressData: { city: "Sample City" } }),
    ).optionSpec,
    undefined,
    "an incomplete address names no place option",
  );
});

test("the education entry of a page section picks that entry; without one, several entries stay unresolved", () => {
  const two = profile({
    educationData: [
      { school: "First University", fieldOfStudy: "Physics" },
      { school: "Second University", fieldOfStudy: "Math" },
    ],
  });
  assert.equal(answer("School", two), null);
  assert.equal(
    answer("School", two, { educationIndex: 1 }),
    "Second University",
  );
  assert.equal(
    api.resolve("School", two, { educationIndex: 1 }).optionSpec.topic,
    "school",
  );
  assert.equal(answer("Field of study", two, { educationIndex: 0 }), "Physics");
});

test("geography compound labels require the matching city and state, never just a postal prefix", () => {
  const context = {
    geography: { kind: "postalCode", city: "San Leandro", state: "CA" },
  };
  const spec = api.knownSpec("ZIP Code", "94579", context);
  assert.equal(
    sandbox.JobsOptionMatch.pick(
      ["94579, Other City, CA", "94579, San Leandro, CA"],
      spec,
    )?.label,
    "94579, San Leandro, CA",
  );
  assert.equal(
    sandbox.JobsOptionMatch.pick(
      ["94579, Other City, CA", "94579, San Leandro, NY"],
      spec,
    ),
    null,
  );
  assert.equal(
    sandbox.JobsOptionMatch.pick(
      ["94579, San Leandro, CA", "94579, San Leandro, CA"],
      spec,
    ),
    null,
  );
  const city = api.knownSpec("City", "San Leandro", {
    geography: { kind: "city", state: "CA" },
  });
  assert.equal(
    sandbox.JobsOptionMatch.pick(["San Leandro, NY", "San Leandro, CA"], city)
      ?.label,
    "San Leandro, CA",
  );
});
