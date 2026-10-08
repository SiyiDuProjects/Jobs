import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { AnswerVocabulary } from "../src/custom/answer-vocabulary.js";
import {
  initializeProfileAnswers,
  JobsProfileAnswers,
} from "../src/custom/profile-answers.js";
import {
  initializeOptionMatch,
  JobsOptionMatch,
} from "../src/custom/option-match.js";
initializeOptionMatch();
initializeProfileAnswers();
test("the browser and website use the server vocabulary without separate alias tables", async () => {
  const service = JSON.parse(
    await fs.readFile(
      new URL(
        "../../../services/jobs-radar/jobs_radar/answer-vocabulary.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(AnswerVocabulary, service);
  const web =
    await import("../../../services/jobs-radar/web/src/manage/answer-vocabulary.js");
  assert.deepEqual(web.AnswerVocabulary, service);
});
test("HPE duration suffix preserves the degree level without inventing a subtype", () => {
  const options = [
    "High School",
    "Associates (±14 years of education)",
    "Bachelors (±16 years of education)",
    "Masters (±18 years of education)",
    "Doctorate",
  ];
  const result = JobsOptionMatch.pick(
    options,
    JobsProfileAnswers.degreeSpec("Bachelor of Science"),
  );
  assert.equal(result?.label, "Bachelors (±16 years of education)");
  assert.equal(
    JobsOptionMatch.pick(
      ["Bachelor of Arts", "Bachelor of Science"],
      JobsProfileAnswers.degreeSpec("Bachelor"),
    ),
    null,
  );
});
test("Booz Allen language catalog never turns fluency into complete mastery", () => {
  const options = [
    "Minimal Competency",
    "Limited Competency",
    "Professional",
    "Advanced Professional",
    "Complete Mastery",
  ];
  assert.equal(
    JobsOptionMatch.pick(
      options,
      JobsProfileAnswers.languageSpec("Fluent", { fluent: true }),
    )?.label,
    "Professional",
  );
  assert.equal(
    JobsOptionMatch.pick(options, JobsProfileAnswers.languageSpec("Native"))
      ?.label,
    "Complete Mastery",
  );
  assert.equal(
    JobsOptionMatch.pick(
      options,
      JobsProfileAnswers.languageSpec("Full Professional"),
    )?.label,
    "Advanced Professional",
  );
});
