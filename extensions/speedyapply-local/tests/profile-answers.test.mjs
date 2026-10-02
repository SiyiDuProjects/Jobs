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
const c = vm.createContext({});
vm.runInContext(code, c);
const p = c.JobsProfileAnswers;
test("Physics catalog equivalence is shared by bindings and Profile answers", () => {
  const answer = p.resolve("Field of Study", {
    educationData: [{ fieldOfStudy: "Physics" }],
  });
  const specs = [
    p.knownSpec("Field of study", "Physics"),
    p.answerSpec(answer),
  ];
  const specialists = [
    "Applied Physics",
    "Physics Teacher Education",
    "Physics, Other",
    "Plasma and High-Temperature Physics",
  ];
  for (const spec of specs) {
    assert.equal(
      c.JobsOptionMatch.pick([...specialists, "Physics, General"], spec)?.label,
      "Physics, General",
    );
    assert.equal(
      c.JobsOptionMatch.pick(["Physics, General", "Physics"], spec)?.label,
      "Physics",
    );
    assert.equal(c.JobsOptionMatch.pick(specialists, spec), null);
  }
  assert.equal(p.select(answer, ["Physics, General"]), "Physics, General");
  assert.equal(
    c.JobsOptionMatch.pick(
      ["Physics, General"],
      p.knownSpec("Field of study", "Applied Physics"),
    ),
    null,
  );
});
const profile = (sponsorship, date) => ({
  addressData: { country: "United States" },
  employmentData: { sponsorship },
  educationData: [{ endDate: date }],
  websiteData: {},
  nameData: {},
});
const ng = profile(true, "2027-05"),
  intern = profile(false, "2027-12");

test("direct college attendance questions resolve the sole profile school without guessing degree completion", () => {
  const profile = { educationData: [{ school: "Example University" }] };
  for (const question of [
    "Which college did you attend?*",
    "What university do you attend?",
    "Which school are you currently attending?",
  ])
    assert.equal(
      p.resolve(question, profile)?.answer,
      "Example University",
      question,
    );
  assert.equal(
    p.resolve("Which college did you attend?", {
      educationData: [{ school: "First" }, { school: "Second" }],
    })?.answer,
    null,
  );
  for (const question of [
    "Which high school did you attend?",
    "Which college did your parents attend?",
    "Which institution awarded your most recently completed degree?",
  ])
    assert.equal(p.resolve(question, profile), null);
});

test("school options allow a state suffix but preserve full university and campus identity", () => {
  const answer = p.resolve("School", {
    educationData: [{ school: "University of California, Berkeley" }],
  });
  const correct = "University of California--Berkeley (CA)";
  assert.equal(
    p.select(answer, [
      "Berkeley College (NJ)",
      "Berkeley College (NY)",
      correct,
    ]),
    correct,
  );
  for (const labels of [
    ["Berkeley College (NJ)"],
    ["University of California--Los Angeles (CA)"],
    [correct, "University of California--Berkeley (NY)"],
    [correct, "University of California, Berkeley"],
  ])
    assert.equal(p.select(answer, labels), null);
  const campus = p.resolve("School", {
    educationData: [{ school: "Example University (North Campus)" }],
  });
  assert.equal(p.select(campus, ["Example University (South Campus)"]), null);
  const region = p.resolve("School", {
    educationData: [{ school: "Example University (CA)" }],
  });
  assert.equal(p.select(region, ["Example University (NY)"]), null);
  assert.equal(
    p.select(region, ["Example University (CA)"]),
    "Example University (CA)",
  );
});

test("real observed sponsorship variants use the passed Profile, including require support and sponsor as a verb", () => {
  for (const question of [
    "Will you require Immigration Support to maintain work authorization*",
    "Will you now or in the future require Example to commence (“sponsor”) an immigration case in order to employ you?",
    "Do you currently, or will you in the future, require an employer to sponsor or continue sponsoring your employment authorization in order to work in the United States?",
    "Will you need visa sponsorship now or in the future?",
  ]) {
    assert.equal(p.resolve(question, ng).answer, "Yes");
    assert.equal(p.resolve(question, intern).answer, "No");
  }
});
test("graduation year, month and combined date stay separate across two simultaneous Profiles", () => {
  for (const [question, a, b] of [
    ["When will you graduate? (month & year)", "May 2027", "December 2027"],
    ["What is your anticipated graduation month?", "May", "December"],
    ["When is your expected graduation year?", "2027", "2027"],
    [
      "Graduation date or expected graduation date:",
      "May 2027",
      "December 2027",
    ],
  ]) {
    assert.equal(p.resolve(question, ng).answer, a);
    assert.equal(p.resolve(question, intern).answer, b);
    assert.equal(p.resolve(question, ng).answer, a);
  }
});
test("does not confuse high-school dates, term qualifiers, internship-induced delays or relatives with existing date fields", () => {
  for (const question of [
    "What year did you graduate high school?",
    "Are you graduating in the summer or fall of 2027?",
    "Will participating in an internship during this period push your expected graduation date back?",
    "What term did you (or will you) graduate in?",
    "Do you have relatives at Example?",
    "If you are currently on a VISA sponsorship, what type of VISA?",
    "Can you work without visa sponsorship?",
  ])
    assert.equal(p.resolve(question, ng), null, question);
});
test("mapped answers retain country boundaries and never guess unknown or ambiguous profile data", () => {
  assert.equal(
    p.resolve("Will you require sponsorship to work in Canada?", ng).answer,
    null,
  );
  assert.equal(
    p.resolve("Will you require sponsorship?", ng, { country: "CA" }).answer,
    null,
  );
  assert.equal(
    p.resolve("Will you require sponsorship?", profile(undefined, "2027-05"))
      .answer,
    null,
  );
  assert.equal(
    p.resolve("Graduation year", {
      educationData: [{ endDate: "2027-05" }, { endDate: "2026-01" }],
    }).answer,
    null,
  );
  assert.equal(p.country("Will you require us to sponsor you?"), null);
});
test("option translation supports abbreviations, numeric months and explicit month ranges, never an arbitrary first option", () => {
  const month = p.resolve("Graduation month", intern),
    date = p.resolve("Graduation date", intern);
  assert.equal(p.select(month, ["November", "Dec"]), "Dec");
  assert.equal(p.select(month, ["11", "12"]), "12");
  assert.equal(
    p.select(date, [
      "January 2027 - August 2027",
      "December 2027 - August 2028",
    ]),
    "December 2027 - August 2028",
  );
  assert.equal(p.select(date, ["Fall 2027", "Spring 2028"]), "Fall 2027");
  assert.equal(p.select(month, ["12", "December"]), null);
});
test("actual common matcher prioritizes profile-backed fields over stale exact saved answers", async () => {
  vm.runInContext(
    resolverWith(
      '[{question:"Will you require sponsorship?",response:"No",keywords:["sponsorship"],appearances:1}]',
    ),
    c,
  );
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: "Will you require sponsorship?" }],
        ng,
      )
    )[0].answer,
    "Yes",
  );
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: "Will you require sponsorship?" }],
        intern,
      )
    )[0].answer,
    "No",
  );
  assert.equal(
    (
      await c.JobsAnswerResolver.resolve(
        [{ question: "Graduation month", options: ["May", "December"] }],
        intern,
      )
    )[0].answer,
    "December",
  );
});

test("cleanup removes only covered answer formats and never invents a graduation day or start date", () => {
  assert(
    !p.covers(
      { question: "Will you require sponsorship?", response: "No" },
      ng,
    ),
  );
  assert(
    p.covers(
      { question: "Will you require sponsorship?", response: "Yes" },
      ng,
    ),
  );
  assert(
    !p.covers(
      {
        question: "Will you require sponsorship?",
        response: "Sponsorship required in the future",
      },
      ng,
    ),
  );
  assert(!p.covers({ question: "Graduation month", response: "May" }, intern));
  assert(
    !p.covers({ question: "Graduation date", response: "Fall 2027" }, intern),
  );
  assert.equal(p.resolve("Graduation date (MM/DD/YYYY)", intern).answer, null);
  assert.equal(p.resolve("What day will you graduate?", intern).answer, null);
  assert.equal(p.resolve("When can you start working?", intern), null);
});

test("observed TRC education controls use each Profile directly rather than Luna or stale memory", () => {
  for (const [end, season] of [
    ["2027-05", "Spring 2027"],
    ["2027-12", "Fall 2027"],
  ]) {
    const profile = {
      educationData: [
        {
          school: "University of California, Berkeley",
          fieldOfStudy: "Physics",
          degree: "Bachelor's",
          endDate: end,
        },
      ],
    };
    for (const [question, value] of [
      ["Please select your Major from the list*", "Physics"],
      [
        "Please select your School from the list*",
        "University of California Berkeley",
      ],
      ["Education Level*", "Bachelor's"],
      ["Expected Graduation Date*", season],
    ]) {
      assert.equal(p.select(p.resolve(question, profile), [value]), value);
      assert.equal(
        p.covers({ question, response: value }, profile),
        question !== "Expected Graduation Date*",
      );
    }
    assert.equal(
      p.resolve("Graduated?*", profile, { now: "2026-09" }).answer,
      "No",
    );
    assert.equal(
      p.resolve("Graduated?*", profile, { now: "2028-01" }).answer,
      null,
    );
    assert.equal(
      p.resolve("Please add your Major if it is not in the list", profile),
      null,
    );
  }
});

test("existing school, degree, major and GPA use explicit education facts without inferring eligibility or a second degree", () => {
  const educated = {
    educationData: [
      {
        school: "Example University",
        fieldOfStudy: "Physics",
        degree: "Bachelor's",
        gpa: "3.9/4.0",
      },
    ],
  };
  for (const [question, answer] of [
    ["Name of School ✱", "Example University"],
    ["School Major:", "Physics"],
    ["What degree are you currently pursuing? ✱", "Bachelor's"],
    ["Cumulative GPA*", "3.9"],
    [
      "Cumulative GPA and the scale your school uses (e.g. 3.7/4.0, 85%, 10/12)*",
      "3.9/4.0",
    ],
  ])
    assert.equal(p.resolve(question, educated).answer, answer);
  assert.equal(
    p.select(p.resolve("Degree", educated), [
      "High school",
      "Bachelors",
      "Masters",
    ]),
    "Bachelors",
  );
  for (const q of [
    "Are you eligible for a STEM OPT extension?",
    "Do you have a computer science degree?",
    "School Minor:",
  ])
    assert.equal(p.resolve(q, educated), null);
  assert.equal(
    p.resolve("School", {
      educationData: [{ school: "First" }, { school: "Second" }],
    }).answer,
    null,
  );
});

test("school punctuation and observed GPA bands translate without fuzzy topic matching or scale conversion", () => {
  const profile = {
    educationData: [
      {
        school: "University of Example, City",
        gpa: "3.9/4.0",
        degree: "Bachelor's",
        fieldOfStudy: "Physics",
      },
    ],
  };
  assert.equal(
    p.select(p.resolve("Name of School", profile), [
      "University of Example - City",
      "University of Example, Elsewhere",
    ]),
    "University of Example - City",
  );
  for (const question of [
    "What is/was your GPA?",
    "What is your GPA?",
    "Undergraduate GPA",
    "Please indicate your most recent GPA",
  ]) {
    const answer = p.resolve(question, profile);
    for (const label of ["3.900 / 4.000", "3.75 - 4", "3.5 or higher", "3.75+"])
      assert.equal(p.select(answer, [label]), label);
    assert.equal(p.select(answer, ["3.5 or higher", "3.75+"]), null);
    assert.equal(p.select(answer, ["3.9/5.0"]), null);
  }
  assert.equal(
    p.resolve("What is your Current Degree Program?", profile).answer,
    "Bachelor's",
  );
  assert.equal(
    p.resolve("Please indicate your program major", profile).answer,
    "Physics",
  );
  for (const question of [
    "Which institution awarded your most recently completed degree?",
    "Do you hold a Bachelor's degree?",
    "School Minor:",
  ])
    assert.equal(p.resolve(question, profile), null);
});

test("contact and location variants read only their own Profile fields; conditional identity questions stay unowned", () => {
  const profile = {
    nameData: { firstName: "Test", lastName: "User" },
    addressData: {
      city: "Example",
      line1: "1 Example Road",
      postalCode: "12345",
      country: "United States",
    },
    websiteData: { github: "https://github.test/u" },
  };
  for (const [question, expected] of [
    ["Legal Name", "Test User"],
    ["Street Address", "1 Example Road"],
    ["City", "Example"],
    ["What is the zip code of your primary residence?", "12345"],
    ["Zip / postal code", "12345"],
  ])
    assert.equal(p.resolve(question, profile).answer, expected);
  assert.equal(
    p.select(p.resolve("What country do you currently reside in?", profile), [
      "USA",
      "Canada",
    ]),
    "USA",
  );
  for (const question of [
    "If yes, please specify which country.",
    "Country where current school is located",
    "If you answered Yes, provide your permanent address",
    "Please share your gender pronouns.",
  ])
    assert.equal(p.resolve(question, profile), null);
  assert.equal(p.resolve("Email", profile).answer, null);
  assert.equal(
    p.resolve("Are you legally authorized to work in the United States?", ng)
      .answer,
    null,
  );
  const legal = { ...ng, employmentData: { eligibilityUS: true } };
  assert.equal(
    p.resolve("Are you legally authorized to work in the United States?", legal)
      .answer,
    "Yes",
  );
  assert.equal(
    p.resolve("Are you legally authorized to work in Canada?", legal),
    null,
  );
});
