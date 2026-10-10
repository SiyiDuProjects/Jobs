// Consume a private real-provider report on stdin; print aggregate results only.
// This verifies the service/background boundary, not writes on a live ATS.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const moduleUrl = process.argv[2]
  ? pathToFileURL(process.argv[2]).href
  : new URL("../src/custom/answer-proof.js", import.meta.url).href;
const { bindAnswerEvidence, verifiedAnswer } = await import(moduleUrl);
const report = JSON.parse(fs.readFileSync(0, "utf8"));
const summary = { answered: 0, accepted: 0, rejected: 0, asks: 0, fences: 0 };
for (const row of report.results) {
  if (!row.answer) throw Error("Incomplete report");
  if (row.answer.state !== "answer") {
    summary.asks++;
    continue;
  }
  summary.answered++;
  const bound = { id: row.profileId, lastSync: row.profileVersion };
  const bind = (field, profile = bound) =>
    verifiedAnswer(bindAnswerEvidence(row.answer, field, profile), field);
  if (bind(row.field)) summary.accepted++;
  else summary.rejected++;
  const changed = structuredClone(row.field);
  if (changed.options.length) changed.options[0].label += " changed";
  else changed.question += " changed";
  if (
    bind(changed) ||
    bind(row.field, { ...bound, lastSync: "different-revision" })
  )
    throw Error("Changed field or Profile was accepted");
  summary.fences += 2;
}
console.log(JSON.stringify({ ...summary, realATSWrite: false }));
if (summary.rejected) process.exitCode = 1;
