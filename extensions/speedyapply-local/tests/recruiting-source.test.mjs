import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { functionBlock } from "./helpers/menu-fixtures.mjs";
import { fixture as choiceFixture } from "./helpers/ats-choice-fixtures.mjs";
import { resolverWith } from "./helpers/answer-resolver.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const rules =
  (await read("src/custom/option-match.js")) +
  "\n" +
  (await read("src/custom/profile-answers.js")) +
  "\n" +
  (await read("src/custom/form-pipeline.js"));
const controls =
  (await read("src/custom/dom-wait.js")) +
  "\n" +
  (await read("src/custom/control-fields.js"));
const preference =
  "Recruiting-source preference: For ordinary “How did you hear about us?” / “Where did you find this job?” questions, I authorize an automatic default without asking me to confirm: prefer LinkedIn, then Job Board/Online, Company Website/Careers, then Other. If none is offered, choose the first available ordinary source category; for free text use LinkedIn. This is my confirmed filling preference, not a claim about the actual discovery channel. Do not infer a university source from my education. This preference does not authorize inventing a referrer name, employee ID or specific event attendance.";
const profile = { applicationData: { aiNotes: preference } };
const harness = (html, url = "https://fixture.invalid/apply") => {
  const w = new JSDOM("<form>" + html + "</form>", {
    url,
    runScripts: "outside-only",
  }).window;
  w.eval(rules + "\n" + controls);
  w.jobsFindXPath = (path) =>
    w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
  w.jobsFindAllXPath = (path) => {
    const result = w.document.evaluate(
      path,
      w.document,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, i) =>
      result.snapshotItem(i),
    );
  };
  return { w, doc: w.document, close: () => w.close() };
};
const select = (labels) =>
  '<label>How did you hear about us?<select data-automation="applicant-source-dropdown"><option value="">Select...</option>' +
  labels
    .map((label, i) => `<option value="${i + 1}">${label}</option>`)
    .join("") +
  "</select></label>";

test("source preference is Profile owned; actual context wins and personal followups stay outside the rule", () => {
  const h = harness(""),
    api = h.w.JobsProfileAnswers,
    match = h.w.JobsOptionMatch;
  try {
    // Without a parseable Profile preference the filling default applies: LinkedIn first.
    for (const data of [
      {},
      { applicationData: { aiNotes: "Prefer a website, probably." } },
    ]) {
      const fallback = api.recruitingSourceSpec(data);
      assert.equal(fallback.origin, "default");
      assert.equal(
        match.pick(["Company Website", "LinkedIn"], fallback).label,
        "LinkedIn",
      );
      assert.deepEqual(
        [...fallback.queries],
        ["LinkedIn", "Job Board", "Website", "Other"],
      );
    }
    assert.equal(
      match.pick(
        ["Company Website", "LinkedIn"],
        api.recruitingSourceSpec(profile),
      ).label,
      "LinkedIn",
    );
    const alternate = {
      applicationData: {
        aiNotes:
          "Recruiting-source preference: prefer Company Website/Careers, then LinkedIn.",
      },
    };
    assert.equal(
      match.pick(
        ["Company Website", "LinkedIn"],
        api.recruitingSourceSpec(alternate),
      ).label,
      "Company Website",
    );
    const actual = api.recruitingSourceSpec(profile, {
      recruitingSource: "Company Website",
    });
    assert.equal(
      match.pick(["Company Website", "LinkedIn"], actual).label,
      "Company Website",
    );
    assert.equal(match.pick(["LinkedIn"], actual), null);
    assert.equal(
      match.pick(
        ["University", "Employee Referral", "Attended conference"],
        api.recruitingSourceSpec(profile),
      ),
      null,
    );
    assert.equal(
      match.pick(
        ["University", "Indeed", "Glassdoor"],
        api.recruitingSourceSpec(profile),
      ).label,
      "Indeed",
    );
    assert.equal(
      match.pick(["Indeed"], api.recruitingSourceSpec(alternate)),
      null,
    );
    for (const question of [
      "Employee referrer name",
      "Which event did you attend?",
      "Employee ID of your referrer",
    ])
      assert.notEqual(api.classify(question)?.topic, "recruiting_source");
    assert.equal(
      api.resolve("Where did you find this job?", profile).answer,
      "LinkedIn",
    );
  } finally {
    h.close();
  }
});

test('a grouped "Category - Source" label is the preferred source; ties still stop', () => {
  const h = harness(""),
    api = h.w.JobsProfileAnswers,
    match = h.w.JobsOptionMatch;
  try {
    const spec = api.recruitingSourceSpec(profile);
    // RTX Workday: the preferred LinkedIn is offered only inside its category.
    assert.equal(
      match.pick(
        [
          "Career Fair - Virtual",
          "Job Board - Indeed",
          "Job Board - LinkedIn",
          "Social Media - Facebook",
          "Other",
        ],
        spec,
      ).label,
      "Job Board - LinkedIn",
    );
    assert.equal(
      match.pick(["Job Board > LinkedIn", "Company Website"], spec).label,
      "Job Board > LinkedIn",
    );
    // Preference order holds across grouped and plain labels.
    assert.equal(
      match.pick(["Company Website", "Job Board - LinkedIn"], spec).label,
      "Job Board - LinkedIn",
    );
    // The same source offered twice is ambiguous, never a guess.
    assert.equal(match.pick(["LinkedIn", "Job Board - LinkedIn"], spec), null);
    // A category name alone is not its sources, and a word inside a label is not a segment.
    assert.equal(
      match.pick(
        ["LinkedIn Recruiter Message", "University - Career Center"],
        spec,
      ),
      null,
    );
    // Ordinary grouped sources remain the authorized fallback.
    assert.equal(
      match.pick(["University - Career Center", "Job Board - Indeed"], spec)
        .label,
      "Job Board - Indeed",
    );
    assert.equal(
      match.pick(
        ["Company Website", "Job Board - LinkedIn"],
        api.recruitingSourceSpec(profile, { recruitingSource: "LinkedIn" }),
      ).label,
      "Job Board - LinkedIn",
    );
  } finally {
    h.close();
  }
});

test("initial source adapter, supplement and an exact AI answer commit the same offered label", async () => {
  const code = functionBlock(
    await read("source/content/adapters/ultipro.js"),
    "ultiproFillApplicationSource",
  );
  for (const labels of [
    ["University", "Company Website", "LinkedIn"],
    ["Job Board", "Company Website"],
    ["Employee Referral", "Indeed"],
  ]) {
    const expected = labels.includes("LinkedIn")
      ? "LinkedIn"
      : labels.includes("Job Board")
        ? "Job Board"
        : "Indeed";
    for (const entrance of ["adapter", "supplement", "ai"]) {
      const h = harness(
        select(labels) +
          '<label><input type="radio" data-automation="no-employee-referral-radio">No employee referral</label>',
      );
      const traces = [];
      h.w.JobsDiagnostics = {
        note: () => {},
        trace: (_node, entry) => traces.push(entry),
      };
      h.w.eval(resolverWith("[]"));
      h.w.eval(code);
      try {
        const node = h.doc.querySelector("select"),
          reader = h.w.JobsControlFields.create(
            h.doc,
            () => h.doc.querySelector("form"),
            { write: true },
          );
        if (entrance === "adapter")
          await h.w.ultiproFillApplicationSource(profile);
        else {
          const row = reader.scan().find((row) => row.node === node);
          const resolved = h.w.JobsProfileAnswers.resolve(
            row.public.question,
            profile,
            row.public,
          );
          const answer =
            entrance === "ai"
              ? expected
              : h.w.JobsProfileAnswers.select(
                  resolved,
                  row.public.options.map((option) => option.label),
                );
          await reader.apply(
            row,
            row.public.options.find((option) => option.label === answer)?.value,
          );
        }
        assert.equal(node.selectedOptions[0].text, expected, entrance);
        assert.equal(
          h.doc.querySelector("input").checked,
          false,
          "source defaults do not answer a referral question",
        );
        if (entrance === "adapter") {
          assert(
            traces.some(
              (trace) =>
                trace.chosen === expected &&
                trace.options.includes(expected) &&
                trace.method,
            ),
          );
          await h.w.ultiproFillApplicationSource({
            applicationData: {
              aiNotes: "Recruiting-source preference: prefer Other.",
            },
          });
          assert.equal(
            node.selectedOptions[0].text,
            expected,
            "keep existing choice",
          );
        }
      } finally {
        h.close();
      }
    }
  }
});

test("TikTok source goes through its real dropdown; a Profile without a preference gets the LinkedIn-first default", async () => {
  const code = functionBlock(
    await read("source/content/adapters/tiktok.js"),
    "tiktokFillDisclosures",
  );
  for (const data of [{}, profile]) {
    const h = await choiceFixture("tiktok-disclosure");
    h.w.eval(rules);
    const wrap = h.doc.createElement("div");
    wrap.setAttribute("data-form-field-i18n-name", "hear");
    wrap.append(...h.root.childNodes);
    h.root.append(wrap);
    h.doc.getElementById("option-0").innerHTML = "<span>Company Website</span>";
    h.doc.getElementById("option-1").innerHTML = "<span>LinkedIn</span>";
    Object.assign(h.w, {
      jobsFillControlAnswer: async () => null,
      jobsResolveControlAnswer: async () => null,
      jobsLowercaseXPath: (value) =>
        `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
    });
    h.w.eval(code);
    try {
      await h.w.tiktokFillDisclosures({ ...data, employmentData: {} });
      assert.equal(h.api.value(h.control), "LinkedIn");
    } finally {
      h.close();
    }
  }
});

test("Workday initial source and supplemental option reads use an unfiltered list then one exact choice", async () => {
  const code = functionBlock(
    await read("source/content/adapters/workday.js"),
    "workdayFillPriorEmploymentAndSource",
  );
  for (const entrance of ["adapter", "supplement"]) {
    const h = harness(
      '<div data-automation-id="formField-source"><label for="source">How did you hear about us?</label><button type="button" id="source" data-automation-id="sourceDropdown" aria-haspopup="listbox">Select One</button></div>',
      "https://fixture.myworkdayjobs.com/apply",
    );
    h.w.eval(await read("src/custom/workday-controls.js"));
    h.w.jobsFillControlAnswer = async () => null;
    h.w.eval(code);
    const button = h.doc.querySelector("button");
    button.onclick = () => {
      button.setAttribute("aria-controls", "sources");
      h.doc.getElementById("sources")?.remove();
      h.doc.body.insertAdjacentHTML(
        "beforeend",
        '<div id="sources" role="listbox"><div role="option">University</div><div role="option">Company Website</div></div>',
      );
      for (const option of h.doc.querySelectorAll('[role="option"]'))
        option.onclick = () => {
          button.textContent = option.textContent;
          h.doc.getElementById("sources").remove();
        };
    };
    try {
      if (entrance === "adapter")
        await h.w.workdayFillPriorEmploymentAndSource(profile);
      else {
        const reader = h.w.JobsControlFields.create(
            h.doc,
            () => h.doc.querySelector("form"),
            { write: true },
          ),
          row = reader.scan()[0];
        // The rules' one decision (the source spec) is what the option reader gets.
        const options = await reader.readOptions(row, () => true, {
          optionSpec: h.w.JobsProfileAnswers.resolve(
            row.public.question,
            profile,
          ).optionSpec,
        });
        const answer = h.w.JobsProfileAnswers.select(
          h.w.JobsProfileAnswers.resolve(row.public.question, profile),
          options.map((item) => item.label),
        );
        await reader.apply(row, answer);
      }
      assert.equal(button.textContent, "Company Website");
    } finally {
      h.close();
    }
  }
});
