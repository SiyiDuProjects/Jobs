import { readModule, functionBlock } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
const root = new URL("../", import.meta.url);
const read = (name) => readModule(new URL(name, root), "utf8");
const workday = await read("source/content/adapters/workday.js");
const capture = await read("source/content/shared/response-capture.js");
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

// The removed keyword/company answer matcher was covered here previously.
// Routing and strict options now live in answer-decision/answer-unification;
// storage scope and origin are checked by response-scope and ashby-memory.
