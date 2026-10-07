import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initializeJobMatchRules } from "../src/custom/job-match-rules.js";
import { initializeJobMatch, JobsJobMatch } from "../src/custom/job-match.js";
import {
  publicJobUrl,
  publicPageUrl,
  icimsFormJobUrl,
} from "../src/custom/public-job-url.js";
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
test("nested IForm diagnostics use only the matching tenant's public tab job", () => {
  const sender = {
    frameId: 42,
    url: "https://fixture.icims.com/forms?token=private&csrf=private&user=123",
    tab: {
      url: "https://careers-fixture.icims.com/jobs/123/example/form?hashed=private",
    },
  };
  assert.equal(
    icimsFormJobUrl(sender),
    "https://careers-fixture.icims.com/jobs/123/example/form",
  );
  assert.equal(icimsFormJobUrl({ ...sender, frameId: 0 }), "");
  assert.equal(
    icimsFormJobUrl({
      ...sender,
      url: "https://other.icims.com/forms?token=private",
    }),
    "",
  );
  assert.equal(
    icimsFormJobUrl({
      ...sender,
      tab: { url: "https://careers-fixture.icims.com/jobs/dashboard" },
    }),
    "",
  );
  assert.equal(
    icimsFormJobUrl({
      ...sender,
      tab: { url: "https://example.com/jobs/123/form" },
    }),
    "",
  );
});
