import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const modules = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
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
  profileName: "Fixture",
  educationData: [{ degree: "Bachelor's", currentlyAttending: true }],
  applicationData: { highestCompletedEducation: "High School" },
};
const q = {
  degree: "What degree are you currently enrolled in?",
  source: "How did you hear about this internship?",
  other: "If you selected “Other” please share more details.",
  essay:
    "In 1-3 sentences, tell us about one thing TRI is working on that you find exciting?",
  survey:
    "Do you consider yourself a member of the Lesbian, Gay, Bisexual and/or Transgender, Queer and Questioning (LGBTQ) community?",
  ack: "Selection criteria are provided to all candidates. Your answers will be used for compliance with U.S. export control laws.",
};
const field = (question, control, required = false) =>
  `<div><div class="application-label full-width"><div class="text">${question}${required ? '<span class="required">✱</span>' : ""}</div></div><div class="application-field full-width">${control}</div></div>`;
const radios = (name, options, required = false) =>
  `<ul data-qa="multiple-choice">${options.map((option) => `<li><label><input type="radio" name="${name}" value="${option}" ${required ? "required" : ""}><span>${option}</span></label></li>`).join("")}</ul>`;
function fixture() {
  const dom = new JSDOM(
    `<form id="application-form"><div data-qa="additional-cards">
    ${field(q.source, radios("source", ["LinkedIn", "Other"], true), true)}
    ${field(q.other, '<input name="other" placeholder="Type your response">')}
    ${field(q.essay, '<textarea name="essay" required></textarea><speedyapply-generate></speedyapply-generate>', true)}
    ${field(q.degree, radios("degree", ["PhD", "Master's", "Bachelor's", "Other"], true), true)}
    ${field(q.ack, radios("ack", ["I have read and understand the selection criteria."], true), true)}
    </div><div id="countrySurvey_all-opportunity-locations">${field(q.survey, radios("survey", ["Yes", "No", "Prefer not to say"]))}</div>
    <label>Optional portfolio<input name="portfolio"></label></form>`,
    {
      url: "https://jobs.lever.co/fixture/role/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    requests = [],
    records = [];
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  w.JobsDiagnostics = {
    note() {},
    answers: (questions, results, decisions) =>
      records.push({ questions, results, decisions }),
  };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        requests.push(message);
        assert.equal(message.type, "jobs:auto-answers");
        return {
          data: {
            answers: message.fields.map((f) => ({
              fieldId: f.fieldId,
              state: "answer",
              source: "unknown",
              needsConfirmation: false,
              value:
                f.type === "textarea"
                  ? "A grounded fixture motivation."
                  : f.options.find(
                      (o) =>
                        o.label === "Prefer not to say" ||
                        o.label ===
                          "I have read and understand the selection criteria.",
                    ).value,
              questionZh: f.question,
              answerZh: "",
              reason: "Fixture provider boundary",
            })),
          },
        };
      },
    },
  };
  modules.forEach((code) => w.eval(code));
  const resolve = installAnswerResolver(w, [
    { question: "Type", keywords: ["type"], appearances: 1, response: "Home" },
    {
      question: q.source,
      keywords: ["hear", "internship"],
      appearances: 2,
      response: "LinkedIn",
    },
  ]);
  const root = w.document.querySelector("form"),
    reader = w.JobsControlFields.create(w.document, () => root, {
      write: true,
    });
  return {
    w,
    root,
    reader,
    resolve,
    requests,
    records,
    close: () => w.close(),
  };
}

test("Lever sibling headings survive scanner, first-pass descriptions and survey discovery", () => {
  const h = fixture();
  try {
    const rows = h.reader.scan();
    for (const name of [
      "degree",
      "source",
      "other",
      "essay",
      "survey",
      "ack",
    ]) {
      const row = rows.find((r) => r.node.name === name);
      assert.equal(row.public.question.replace(/✱$/, ""), q[name]);
      assert.equal(row.public.supported, true, name);
      const described = h.w.JobsControlFields.describeQuestions(
        [{ question: q[name], node: row.node.closest(".application-field") }],
        { root: h.root },
      )[0];
      assert.equal(described.question.replace(/✱$/, ""), q[name]);
      assert.equal(described.fieldId, row.public.id);
    }
    assert(
      h.w.JobsControlFields.needsAnswer(
        rows.find((r) => r.node.name === "essay").public,
      ),
    );
    const survey = rows.find((r) => r.node.name === "survey").public;
    assert.equal(survey.required, false);
    assert(h.w.JobsControlFields.needsAnswer(survey));
    assert(
      !h.w.JobsControlFields.needsAnswer(
        rows.find((r) => r.node.name === "other").public,
      ),
    );
    assert(
      !h.w.JobsControlFields.needsAnswer(
        rows.find((r) => r.node.name === "portfolio").public,
      ),
    );
  } finally {
    h.close();
  }
});

test("the Lever run answers the current degree and source and cannot reuse Type/Home for an Other follow-up", async () => {
  const h = fixture();
  try {
    await h.w.JobsAutomatic.advance({
      root: h.root,
      profile,
      action: "fill",
      resolveAnswers: h.resolve,
    });
    assert.equal(
      h.root.querySelector('[name="degree"]:checked')?.value,
      "Bachelor's",
    );
    assert.equal(
      h.root.querySelector('[name="source"]:checked')?.value,
      "LinkedIn",
    );
    assert.equal(h.root.querySelector('[name="other"]').value, "");
    assert.equal(
      h.records[0].decisions.find((d) => d.field === "educationData.degree")
        .source,
      "profile",
    );
  } finally {
    h.close();
  }
});

test("supplement sends only required essay and acknowledgment to AI; optional survey stays blank", async () => {
  const h = fixture();
  try {
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile,
        action: "fill",
        resolveAnswers: h.resolve,
      }),
      true,
    );
    assert.equal(h.requests.length, 1);
    const sent = h.requests[0].fields;
    assert.equal(sent.length, 2);
    assert.deepEqual(
      Array.from(sent, (f) => f.question.replace(/✱$/, "")).sort(),
      [q.essay, q.ack].sort(),
    );
    assert(!sent.some((f) => f.question === q.survey));
    assert.equal(
      h.root.querySelector('[name="degree"]:checked').value,
      "Bachelor's",
    );
    assert.equal(h.root.querySelector('[name="other"]').value, "");
    assert.equal(
      h.root.querySelector("textarea").value,
      "A grounded fixture motivation.",
    );
    assert.equal(h.root.querySelector('[name="survey"]:checked'), null);
    assert.equal(
      h.root.querySelector('[name="ack"]:checked').value,
      "I have read and understand the selection criteria.",
    );
  } finally {
    h.close();
  }
});

test("scanner placeholders and option captions cannot overwrite an explicit collector question", () => {
  const h = fixture();
  try {
    h.w.history.replaceState(null, "", "/fixture/role/apply");
    h.root.innerHTML =
      '<input placeholder="Type your response"><label><input type="radio" name="degree">PhD</label>';
    for (const [node, question] of [
      [h.root.querySelector("input"), q.other],
      [h.root.querySelector('[type="radio"]'), q.degree],
    ]) {
      const described = h.w.JobsControlFields.describeQuestions(
        [{ node, question }],
        { root: h.root },
      )[0];
      assert.equal(described.question, question);
    }
  } finally {
    h.close();
  }
});

test("currently enrolled degree excludes finished education and remains distinct from completed qualification", () => {
  const h = fixture();
  try {
    const api = h.w.JobsProfileAnswers;
    const p = {
      ...profile,
      educationData: [
        { degree: "Master's", currentlyAttending: false },
        { degree: "Bachelor's", currentlyAttending: true },
      ],
    };
    assert.equal(api.resolve(q.degree, p)?.answer, "Bachelor's");
    assert.equal(
      api.resolve("What is your highest level of education achieved?", p)
        ?.answer,
      "High School",
    );
    assert.equal(
      api.resolve(q.degree, {
        ...p,
        educationData: [{ degree: "Bachelor's", currentlyAttending: false }],
      })?.answer ?? null,
      null,
    );
  } finally {
    h.close();
  }
});
