import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { parse } from "@babel/parser";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const modules = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "form-pipeline",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const profile = {
  nameData: { firstName: "Example", lastName: "Applicant" },
  addressData: { country: "United States" },
  employmentData: { eligibilityUS: true, sponsorship: false },
  websiteData: {},
  educationData: [{ endDate: "2027-05", graduationDate: "2027-05-17" }],
};
function fixture(html, url = "https://example.test/apply", saved = []) {
  const dom = new JSDOM("<form>" + html + "</form>", {
      url,
      runScripts: "outside-only",
    }),
    w = dom.window,
    requests = [],
    records = [];
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        requests.push(message);
        throw Error("This deterministic fixture must not call AI");
      },
    },
  };
  w.JobsDiagnostics = {
    note() {},
    answers: (questions, results, decisions) =>
      records.push({ questions, results, decisions }),
  };
  modules.forEach((code) => w.eval(code));
  const resolve = installAnswerResolver(w, saved),
    root = w.document.querySelector("form");
  return {
    w,
    root,
    resolve,
    records,
    requests,
    reader: w.JobsControlFields.create(w.document, () => root, { write: true }),
    close: () => w.close(),
  };
}
async function loadCollector(h, platform, legacy = false) {
  const source = await readWithDependencies(
    new URL("../source/content/adapters/" + platform + ".js", import.meta.url),
    "utf8",
  );
  const names =
    platform === "workday"
      ? ["workdayFillQuestionnaire", "workdayReadUnresolvedResponses"]
      : legacy
        ? [
            "greenhouseLegacyFillCustomQuestions",
            "greenhouseLegacyQuestionLabelXPath",
          ]
        : ["greenhouseFillCustomQuestions", "greenhouseQuestionLabelXPath"];
  h.w.eval(source);
  h.w.jobsFindXPath = (xpath, node = h.w.document) =>
    h.w.document.evaluate(xpath, node, null, 9, null).singleNodeValue;
  h.w.jobsFindAllXPath = (xpath, node = h.w.document) => {
    const result = h.w.document.evaluate(xpath, node, null, 7, null);
    return Array.from({ length: result.snapshotLength }, (_, i) =>
      result.snapshotItem(i),
    );
  };
  h.w.jobsDelay = async () => {};
  h.w.jobsMountManualAnswerControls = async () => {};
  return () =>
    h.w.JobsAutomatic.advance({
      root: h.root,
      profile,
      action: "fill",
      fill: () =>
        platform === "workday"
          ? h.w.workdayFillQuestionnaire(profile, "//form", false, {})
          : h.w[names[0]](profile, false),
    });
}

for (const platform of ["workday", "greenhouse", "greenhouse-legacy"])
  test(
    platform +
      " real first-pass collector and supplemental run agree on date precision",
    async () => {
      const legacy = platform.endsWith("legacy"),
        type = legacy ? "text" : "date";
      const html =
        platform === "workday"
          ? '<div data-automation-id="formField-grad"><label for="grad" data-automation-id="richText">Graduation date</label><input id="grad" type="date" required></div>'
          : legacy
            ? '<div id="custom_fields"><div class="field"><label>Graduation date<input id="grad" type="text" required></label></div></div>'
            : '<div class="application--questions"></div><div class="application--questions"><div><label id="question_1-label" for="grad">Graduation date</label><input id="grad" type="date" required></div></div>';
      const h = fixture(
        html,
        platform === "workday"
          ? "https://fixture.myworkdayjobs.com/apply"
          : "https://job-boards.greenhouse.io/example/jobs/1",
      );
      try {
        await (
          await loadCollector(
            h,
            platform === "workday" ? "workday" : "greenhouse",
            legacy,
          )
        )();
        const first = h.records[0],
          expected = legacy ? "May 2027" : "2027-05-17";
        assert.equal(first.questions[0].inputType, type);
        assert.equal(first.questions[0].required, true);
        assert.equal(first.results[0].answer, expected);
        assert.equal(h.w.document.getElementById("grad").value, expected);
        h.w.document.getElementById("grad").value = "";
        assert.equal(
          await h.w.JobsAutomatic.advance({
            root: h.root,
            profile,
            action: "fill",
            retry: true,
          }),
          true,
        );
        const next = h.records.at(-1);
        assert.equal(next.questions[0].fieldId, first.questions[0].fieldId);
        assert.equal(next.questions[0].inputType, first.questions[0].inputType);
        assert.equal(next.results[0].answer, first.results[0].answer);
        assert.equal(next.results[0].source, first.results[0].source);
        assert.equal(h.w.document.getElementById("grad").value, expected);
        assert.equal(h.requests.length, 0);
        assert(
          !("node" in first.questions[0]),
          "DOM locators never enter the serialized question contract",
        );
      } finally {
        h.close();
      }
    },
  );

test("completed authorization supplies country to either entry without borrowing context from another form", async () => {
  const h = fixture(
    '<label>Are you authorized to work in Canada?<input value="No"></label><label>Do you need sponsorship?<input id="sponsor"></label>',
    undefined,
    [
      {
        question: "Do you need sponsorship?",
        keywords: ["sponsorship"],
        appearances: 1,
        response: "No",
      },
    ],
  );
  try {
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      '<form><label>Are you authorized to work in the United States?<input value="Yes"></label></form>',
    );
    const row = h.reader.scan().find((row) => row.node.id === "sponsor");
    const first = await h.resolve(
      [{ question: row.public.question, node: row.node }],
      profile,
    );
    const next = await h.resolve([{ ...row.public, node: row.node }], profile, {
      root: h.root,
    });
    assert.equal(first.length, 0);
    assert.equal(next.length, 0);
    for (const record of h.records) {
      assert.equal(record.questions[0].country, "CA");
      assert.equal(record.decisions[0].reason, "country_mismatch");
    }
  } finally {
    h.close();
  }
});

test("an optional confirmed answer that reveals a required field is resolved before navigation", async () => {
  const h = fixture(
    '<label for="optional">Address 2</label><input id="optional"><button id="next" type="button">Next</button>',
  );
  try {
    let navigations = 0,
      requiredSeen = 0;
    const optional = h.w.document.getElementById("optional");
    optional.addEventListener("change", () => {
      if (
        optional.value === "Suite 42" &&
        !h.w.document.getElementById("dependent")
      )
        h.root.insertAdjacentHTML(
          "beforeend",
          '<label for="dependent">Required detail</label><input id="dependent" required>',
        );
    });
    h.w.document
      .getElementById("next")
      .addEventListener("click", () => navigations++);
    const resolveAnswers = async (questions, _, { onDecision } = {}) =>
      questions.map((question, index) => {
        if (question.question === "Required detail") requiredSeen++;
        const decision = {
          index,
          status: "answered",
          answer: question.question === "Address 2" ? "Suite 42" : "Confirmed",
          source: "profile",
          reason: "fixture",
        };
        onDecision?.(decision);
        return decision;
      });
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile,
        action: "next",
        selector: "#next",
        resolveAnswers,
      }),
      true,
    );
    assert.equal(optional.value, "Suite 42");
    assert.equal(h.w.document.getElementById("dependent").value, "Confirmed");
    assert.equal(requiredSeen, 1);
    assert.equal(navigations, 1);
    assert.equal(h.requests.length, 0);
  } finally {
    h.close();
  }
});

test("foreign-country answers require a country-specific memory instead of home-country defaults or broad keywords", async () => {
  for (const specific of [false, true]) {
    const saved = [
      { keywords: ["authorized to work"], appearances: 1, response: "Yes" },
      ...(specific
        ? [
            {
              keywords: ["authorized to work", "Canada"],
              appearances: 2,
              response: "No",
            },
          ]
        : []),
    ];
    const h = fixture(
      '<label>Are you authorized to work in Canada?<input id="work"></label>',
      undefined,
      saved,
    );
    try {
      const answer = await h.resolve(
        [
          {
            question: "Are you authorized to work in Canada?",
            node: h.root.querySelector("input"),
          },
        ],
        profile,
      );
      assert.equal(answer.length, specific ? 1 : 0);
      if (specific) {
        assert.equal(answer[0].answer, "No");
        assert.equal(answer[0].source, "saved");
      }
    } finally {
      h.close();
    }
  }
});

test("new-field absence retains Saved Response fallback, while missing date precision cannot be replaced by a guessed day", async () => {
  const h = fixture(
    '<label>Earliest start date<input id="start" type="date"></label><label>Graduation date<input id="grad" type="date"></label>',
    undefined,
    [
      {
        question: "Earliest start date",
        keywords: ["start"],
        appearances: 1,
        response: "2027-06-10",
      },
      {
        question: "Graduation date",
        keywords: ["graduation"],
        appearances: 1,
        response: "2027-05-01",
      },
    ],
  );
  try {
    const answers = await h.resolve(
      h.reader.scan().map((row) => ({ ...row.public, node: row.node })),
      { ...profile, educationData: [{ endDate: "2027-05" }] },
    );
    assert.equal(answers.length, 1);
    assert.equal(answers[0].answer, "2027-06-10");
    assert.equal(answers[0].source, "saved");
    assert.equal(h.records[0].decisions[1].reason, "missing_day_precision");
  } finally {
    h.close();
  }
});

test("duplicate labels keep independent types and identities; describing questions does not interact with controls", async () => {
  const h = fixture(
    '<div><label for="month">Graduation date</label><input id="month" type="month"></div><div><label for="day">Graduation date</label><input id="day" type="date" aria-describedby="hint"></div><p id="hint">Use an exact date.</p>',
  );
  try {
    let events = 0;
    for (const name of ["click", "focus", "input", "change"])
      h.root.addEventListener(name, () => events++, true);
    const inputs = [...h.root.querySelectorAll("input")];
    const answers = await h.resolve(
      inputs.map((node) => ({ node, question: "Graduation date" })),
      profile,
    );
    assert.deepEqual(
      Array.from(answers, (r) => r.answer),
      ["2027-05", "2027-05-17"],
    );
    const questions = h.records[0].questions;
    assert.notEqual(questions[0].fieldId, questions[1].fieldId);
    assert.equal(questions[1].description, "Use an exact date.");
    assert.equal(events, 0);
    const ambiguous = h.w.JobsControlFields.describeQuestions(
      [{ question: "Graduation date" }],
      { root: h.root },
    )[0];
    assert.equal(ambiguous.fieldId, undefined);
    assert.equal(ambiguous.inputIssue, "ambiguous_control");
  } finally {
    h.close();
  }
});

test("Ashby exact and unique-boolean choice policy also applies through the shared supplemental resolver", async () => {
  for (const [options, response, expected] of [
    [["Friend or Referral", "LinkedIn"], "Friend", null],
    [["Yes - intern", "Yes - employee", "No"], "Yes", null],
    [["Yes, willing to relocate", "No"], "Yes", "Yes, willing to relocate"],
  ]) {
    const h = fixture(
      '<label>Office preference<select id="choice"><option value="">Choose</option>' +
        options
          .map((label, i) => `<option value="${i}">${label}</option>`)
          .join("") +
        "</select></label>",
      "https://jobs.ashbyhq.com/example/1",
      [{ keywords: ["office"], appearances: 1, response }],
    );
    try {
      const answer = await h.resolve(
        [
          {
            question: "Office preference",
            node: h.root.querySelector("select"),
          },
        ],
        profile,
      );
      assert.equal(answer[0]?.answer || null, expected);
    } finally {
      h.close();
    }
  }
});
