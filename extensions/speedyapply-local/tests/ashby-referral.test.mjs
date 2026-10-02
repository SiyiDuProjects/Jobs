import { runAnswerStage } from "./helpers/answer-stage.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

// Structure and wording observed on Sydecar. No applicant values, server state,
// or claim that this fixture reproduces the earlier bad write.
test("observed Sydecar referral remains empty when only applicant identity is known", async () => {
  const dom = new JSDOM(
    `<form aria-labelledby="job-application-form">
 <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title" for="name">Full Name</label><div><input id="name" type="text"></div></div>
 <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title" for="referral">If you were referred by someone, please list them here:</label><div><input placeholder="Type here..." name="referral" id="referral" type="text" class="ashby-application-form-input-text"></div></div>
 </form>`,
    {
      url: "https://jobs.ashbyhq.com/fixture/application",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  try {
    for (const name of [
      "dom-wait",
      "control-fields",
      "option-match",
      "profile-answers",
      "ashby-controls",
      "form-pipeline",
    ])
      w.eval(
        await readWithDependencies(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        ),
      );
    const decisions = [];
    w.JobsDiagnostics = {
      note() {},
      answers: (_q, _a, rows) => decisions.push(...rows),
    };
    const resolve = installAnswerResolver(w, []);
    const profile = {
      nameData: { firstName: "Example", lastName: "Applicant" },
    };
    await runAnswerStage(w, {
      root: w.document.querySelector("form"),
      profile,
      resolveAnswers: resolve,
    });
    assert.equal(w.document.getElementById("name").value, "Example Applicant");
    assert.equal(w.document.getElementById("referral").value, "");
    assert.equal(decisions[1].status, "unmatched");
  } finally {
    w.close();
  }
});
