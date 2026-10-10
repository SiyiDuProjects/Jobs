import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { corpusReport } from "../scripts/corpus-runner.mjs";
const input = new URL("../.qa/corpus/pages.json", import.meta.url);
let corpus;
try {
  corpus = JSON.parse(await fs.readFile(input, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
test(
  "private corpus regression when an authorized local copy exists",
  { skip: !corpus && "Private corpus is not on this machine" },
  async () => {
    const report = corpusReport(corpus);
    const output = new URL("report.json", input);
    await fs.writeFile(output, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    await fs.chmod(output, 0o600);
    assert.equal(
      report.summary.missedControls,
      0,
      "Unrecognized controls: inspect private report",
    );
    assert.equal(
      report.summary.unrecognizedQuestions,
      0,
      "Captured questions no longer recognized",
    );
    assert.equal(
      report.summary.truncatedPages,
      0,
      "Incomplete capture cannot certify coverage",
    );
    assert.equal(
      report.summary.captureMismatches,
      0,
      "Captured and replayed question meanings differ",
    );
    assert.equal(
      report.summary.violations,
      0,
      "Invariant failures: inspect private report",
    );
    assert(
      report.goldChecks.every((check) => check.matched),
      "Confirmed mapping regression",
    );
  },
);
