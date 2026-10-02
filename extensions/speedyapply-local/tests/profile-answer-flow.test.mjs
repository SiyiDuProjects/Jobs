import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const names = [
  "option-match",
  "profile-answers",
  "dom-wait",
  "control-fields",
  "workday-controls",
  "review-presenter",
  "ai-review",
  "operation-context",
  "automatic-fill",
];
const scripts = await Promise.all(
  names.map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function fixture(html, profile, saved = []) {
  const dom = new JSDOM(
    "<form>" + html + '</form><button id="next">Next</button>',
    {
      url: "https://jobs.example.test/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    events = [];
  let aiCalls = 0,
    clicks = 0;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.JobsDiagnostics = { note: (...args) => events.push(args), answers() {} };
  w.JobsAnswerMemory = { remember() {}, discardReview() {} };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture-profile", profile } };
        if (message.type === "jobs:responses-read") return { data: saved };
        if (message.type === "jobs:auto-answers") {
          aiCalls++;
          return {
            data: {
              answers: message.fields.map((f) => ({
                fieldId: f.fieldId,
                state: "needs_input",
                value: null,
                reason: "Fixture has no additional facts",
              })),
            },
          };
        }
        throw Error("Unexpected message " + message.type);
      },
    },
  };
  for (const script of scripts) w.eval(script);
  w.fixtureSaved = saved;
  w.eval(resolverWith("window.fixtureSaved"));
  w.document.querySelector("#next").onclick = () => clicks++;
  return {
    w,
    events,
    aiCalls: () => aiCalls,
    clicks: () => clicks,
    run: () =>
      w.JobsAutomatic.advance({
        root: w.document.querySelector("form"),
        profile,
        action: "fill",
        resolveAnswers: w.JobsAnswerResolver.resolve,
        autoConfirm: false,
      }),
    close: () => w.close(),
  };
}
const profile = () => ({
  profileName: "Fixture",
  nameData: { firstName: "Demo", lastName: "User" },
  contactData: { email: "demo@example.test" },
  addressData: {
    country: "United States",
    city: "Example",
    state: "California",
  },
  websiteData: {},
  jobData: [],
  skillsData: [],
  languageData: [],
  employmentData: { sponsorship: true, eligibilityUS: true },
  educationData: [
    {
      school: "Example University",
      degree: "Master's",
      endDate: "2027-05",
      graduationDate: "2027-05-17",
      currentlyAttending: true,
    },
  ],
  applicationData: {
    earliestStartDate: "2027-06-01",
    highestCompletedEducation: "Bachelor's",
    sponsorshipNow: false,
    sponsorshipFuture: true,
    visaStatus: "F-1",
    pronouns: "They/them",
    interviewLanguage: "Python",
  },
});

test("existing and new Profile answers flow through the original writer with precise dates and zero AI calls", async () => {
  const h = fixture(
    '<label>First name<input id="first" required></label><label>Email<input id="email" required></label><label>Graduation date<input id="graduation" type="date" required></label><label>Earliest start date<input id="start" type="date" required></label><label>Do you currently require visa sponsorship?<select id="now" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Will you require visa sponsorship in the future?<select id="future" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Pronouns<input id="pronouns"></label><label>Preferred interview programming language<input id="language"></label>',
    profile(),
    [
      {
        question: "Do you currently require visa sponsorship?",
        response: "Yes",
        keywords: ["sponsorship"],
        appearances: 1,
      },
    ],
  );
  try {
    assert.equal(await h.run(), true);
    assert.equal(h.aiCalls(), 0);
    assert.equal(h.clicks(), 0);
    for (const [id, value] of Object.entries({
      first: "Demo",
      email: "demo@example.test",
      graduation: "2027-05-17",
      start: "2027-06-01",
      now: "no",
      future: "yes",
      pronouns: "They/them",
      language: "Python",
    }))
      assert.equal(h.w.document.getElementById(id).value, value, id);
    // Six required answers plus the two optional blanks the Profile answers (pronouns, interview language).
    assert.equal(
      h.events.filter(([kind]) => kind === "auto_known_answer_applied").length,
      8,
    );
  } finally {
    h.close();
  }
});

test("the original answer entry accepts optional input precision without a second resolver", async () => {
  const h = fixture(
    '<label>Graduation date<input type="date"></label>',
    profile(),
  );
  try {
    const answers = await h.w.JobsAnswerResolver.resolve(
      [{ question: "Graduation date", type: "date" }],
      profile(),
    );
    assert.equal(answers[0].answer, "2027-05-17");
  } finally {
    h.close();
  }
});

test("unresolved facts retain the original AI and user-review fallback", async () => {
  for (const kind of ["precision", "country"]) {
    const p = profile();
    delete p.educationData[0].graduationDate;
    const html =
      kind === "precision"
        ? '<label>Graduation date<input id="missing" type="date" required></label>'
        : '<label>Are you legally authorized to work in Canada?<select><option selected value="yes">Yes</option></select></label><label>Will you require visa sponsorship?<select id="missing" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>';
    const h = fixture(html, p);
    try {
      assert.equal(await h.run(), false);
      assert.equal(h.aiCalls(), 1);
      assert.equal(h.w.document.getElementById("missing").value, "");
      assert(h.events.some(([type]) => type === "auto_needs_input"));
    } finally {
      h.close();
    }
  }
});
