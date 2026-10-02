import { readModule, functionBlock } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
const root = new URL("../", import.meta.url);
const read = (name) => readModule(new URL(name, root), "utf8");
const answers = await read("src/custom/answer-resolver.js");
const workday = await read("source/content/adapters/workday.js");
const capture = await read("source/content/shared/response-capture.js");
const matching = (
  await Promise.all(
    ["job-match-rules", "job-match", "response-contract"].map((name) =>
      read("src/custom/" + name + ".js"),
    ),
  )
).join("\n");
const block = functionBlock;

test("Workday records a submission attempt immediately, per the user policy", async () => {
  const dom = new JSDOM(
      '<main data-automation-id="applyFlowReviewPage"><h3>Engineer</h3></main><button data-automation-id="pageFooterNextButton">Submit</button>',
      {
        url: "https://fixture.myworkdayjobs.com/en-US/Careers/job/SF/Engineer_R123/apply",
        runScripts: "outside-only",
      },
    ),
    w = dom.window,
    records = [];
  w.jobsWaitForCssNodes = async (selector) => [
    ...w.document.querySelectorAll(selector),
  ];
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = (record) => records.push(record);
  w.eval(await read("src/custom/platform-config.js"));
  w.eval(block(workday, "workdayTrackReviewSubmitClick"));
  try {
    await w.workdayTrackReviewSubmitClick();
    w.document.querySelector("button").click();
    assert.equal(records.length, 1);
  } finally {
    w.close();
  }
});

test("an attempt is recorded before fast close, without waiting for unload or confirmation", async () => {
  const dom = new JSDOM('<button id="submit">Submit</button>', {
      url: "https://job-boards.greenhouse.io/example/jobs/1",
      runScripts: "outside-only",
    }),
    w = dom.window,
    records = [];
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = async (record) => records.push(record);
  w.eval(capture);
  try {
    w.jobsTrackApplicationOnUnload(
      "#submit",
      "Engineer",
      w.location.href,
      "https://example.com",
    );
    w.document.querySelector("button").click();
    assert.equal(records.length, 1);
    w.document.querySelector("button").click();
    w.dispatchEvent(new w.Event("beforeunload"));
    assert.equal(records.length, 1);
  } finally {
    w.close();
  }
});

test("a learned answer never becomes a keyword rule for a different question", () => {
  const c = vm.createContext({});
  vm.runInContext(answers, c);
  const rule = {
    question: "Have you used Java?",
    keywords: ["have", "you", "used", "java"],
    appearances: 4,
    response: "No",
    fromAutofill: true,
  };
  assert.equal(
    c.JobsAnswerResolver.matchSaved(
      { question: "Have you used JavaScript?", options: ["Yes", "No"] },
      [rule],
    ),
    null,
  );
  assert.equal(
    c.JobsAnswerResolver.matchSaved(
      { question: "Have you used Java? *", options: ["Yes", "No"] },
      [rule],
    ),
    "No",
  );
  // Explicit user-authored keyword rules continue to work.
  assert.equal(
    c.JobsAnswerResolver.matchSaved(
      { question: "Have you used JavaScript?", options: ["Yes", "No"] },
      [{ ...rule, fromAutofill: false }],
    ),
    "No",
  );
});

test("option matching preserves negation, language symbols, numbers and ambiguity", () => {
  const c = vm.createContext({});
  vm.runInContext(answers, c);
  for (const [response, options] of [
    [
      "No professional experience",
      ["Professional experience", "Some professional experience"],
    ],
    ["C++", ["C", "C#"]],
    ["1-2 years", ["12 years", "2 years"]],
    ["Research", ["Research engineering", "Research analysis"]],
  ]) {
    const rule = { keywords: ["preference"], appearances: 1, response };
    assert.equal(
      c.JobsAnswerResolver.matchSaved(
        { question: "Your preference?", options },
        [rule],
      ),
      null,
      response,
    );
  }
  const exact = {
    question: "Language?",
    keywords: ["language"],
    appearances: 1,
    response: "C++",
  };
  assert.equal(
    c.JobsAnswerResolver.matchSaved(
      { question: "Language?", options: ["C", "C++", "C#"] },
      [exact],
    ),
    "C++",
  );
});

test("company-specific learned drafts cannot transfer to another job using the same question", () => {
  const c = vm.createContext({
    URL,
    location: { href: "https://jobs.ashbyhq.com/company-b/role/application" },
  });
  vm.runInContext(matching + "\n" + answers, c);
  const question = "Why this team?",
    rule = {
      question,
      response: "I am excited by Company A",
      keywords: ["why", "team"],
      appearances: 2,
      fromAutofill: true,
    };
  assert.equal(
    c.JobsAnswerResolver.matchSaved({ question }, [rule]),
    null,
    "Unscoped historical drafts cannot claim a different employer",
  );
  const scoped = {
    ...rule,
    jobKey: c.JobsJobMatch.key(
      "https://jobs.ashbyhq.com/company-a/role/application",
    ),
  };
  assert.equal(c.JobsAnswerResolver.matchSaved({ question }, [scoped]), null);
  c.location.href = "https://jobs.ashbyhq.com/company-a/role/application";
  assert.equal(
    c.JobsAnswerResolver.matchSaved({ question }, [scoped]),
    rule.response,
  );
});

test("why questions about personal history remain reusable without weakening employer scope", () => {
  const c = vm.createContext({
    URL,
    location: { href: "https://jobs.ashbyhq.com/company-b/role/application" },
  });
  vm.runInContext(matching + "\n" + answers, c);
  for (const question of [
    "Why did you leave your previous job?",
    "Why did you choose Physics?",
  ]) {
    const rule = {
      question,
      response: "Previously confirmed personal answer",
      keywords: ["why"],
      appearances: 1,
      fromAutofill: true,
    };
    assert.equal(c.JobsResponseContract.jobSpecific(question), false, question);
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question }, [rule]),
      rule.response,
      question,
    );
  }
  for (const question of [
    "Why this company?",
    "Why are you interested in this role?",
    "Why do you want to work here?",
    "Why do you want to join us?",
    "Why are you applying here?",
    "Why are you interested in working for us?",
  ]) {
    const rule = {
      question,
      response: "Company A motivation",
      keywords: ["why"],
      appearances: 1,
      fromAutofill: true,
    };
    assert.equal(c.JobsResponseContract.jobSpecific(question), true, question);
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question }, [rule]),
      null,
      question,
    );
    const scoped = {
      ...rule,
      jobKey: c.JobsJobMatch.key(
        "https://jobs.ashbyhq.com/company-a/role/application",
      ),
    };
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question }, [scoped]),
      null,
      question,
    );
    assert.equal(
      c.JobsAnswerResolver.matchSaved({ question }, [
        { ...scoped, jobKey: c.JobsJobMatch.key(c.location.href) },
      ]),
      rule.response,
      question,
    );
  }
});
