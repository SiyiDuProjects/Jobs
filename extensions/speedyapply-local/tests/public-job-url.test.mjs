import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initializeJobMatchRules } from "../src/custom/job-match-rules.js";
import { initializeJobMatch, JobsJobMatch } from "../src/custom/job-match.js";
import { publicJobUrl, publicPageUrl } from "../src/custom/public-job-url.js";
initializeJobMatchRules();
initializeJobMatch();
const fixtures = JSON.parse(
  await fs.readFile(
    new URL(
      "../../../services/jobs-radar/tests/fixtures/public_job_urls.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const row of fixtures)
  test("public URL preserves identity or refuses: " + row.url, () => {
    if (row.publicUrl === null) assert.throws(() => publicJobUrl(row.url));
    else {
      assert.equal(publicJobUrl(row.url), row.publicUrl);
      assert.equal(JobsJobMatch.key(row.publicUrl), row.jobKey);
    }
  });
test("observation can inspect an unrecognized page without archiving a false posting identity", () => {
  const url = "https://careers.example.com/apply?job=123&token=private";
  assert.throws(() => publicJobUrl(url));
  assert.equal(publicPageUrl(url), "https://careers.example.com/apply?job=123");
});
