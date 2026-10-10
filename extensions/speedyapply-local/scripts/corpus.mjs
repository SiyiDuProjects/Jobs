import fs from "node:fs/promises";
import path from "node:path";
import { corpusReport, seedCorpus, seedBindings } from "./corpus-runner.mjs";
const [
  command = "test",
  input = ".qa/corpus/pages.json",
  output = ".qa/corpus/report.json",
  baseline,
] = process.argv.slice(2);
if (
  [input, output, baseline]
    .filter(Boolean)
    .some((file) => !path.resolve(file).includes(path.sep + ".qa" + path.sep))
)
  throw Error(
    "Private corpus input and output must stay under an ignored .qa directory",
  );
await fs.mkdir(path.dirname(output), { recursive: true });
if (command === "seed") {
  await fs.mkdir(path.dirname(input), { recursive: true });
  const pages = seedCorpus();
  await fs.writeFile(
    input,
    JSON.stringify(
      {
        source: "synthetic-bootstrap",
        pages,
        bindings: seedBindings(pages),
        labels: {},
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await fs.chmod(input, 0o600);
} else if (command !== "test")
  throw Error(
    "Usage: corpus.mjs seed|test [.qa/input.json] [.qa/report.json] [baseline.json]",
  );
let data;
try {
  data = JSON.parse(await fs.readFile(input, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log(
    "Private corpus unavailable; run corpus:seed for synthetic bootstrap or import an authorized server export.",
  );
  process.exit(0);
}
const previous = baseline
  ? JSON.parse(await fs.readFile(baseline, "utf8"))
  : null;
const report = corpusReport(data, previous);
await fs.writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
await fs.chmod(output, 0o600);
console.log(
  JSON.stringify({
    source: report.fixtureSource,
    ...report.summary,
    report: output,
  }),
);
if (
  report.summary.violations ||
  report.summary.missedControls ||
  report.summary.unrecognizedQuestions ||
  report.summary.captureMismatches ||
  report.summary.truncatedPages ||
  report.goldChecks.some((check) => !check.matched)
)
  process.exitCode = 1;
