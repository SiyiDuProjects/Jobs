import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { measure } from "./source-metrics.mjs";
import { format } from "prettier";
const root = new URL("../", import.meta.url),
  baselineCommit = "257a15f";
const config = [
  ["src/custom/automatic-fill.js", ["advance", "run"]],
  ["src/custom/control-fields.js", ["scan"]],
];
const report = {
  baselineCommit,
  note: "Established at closeout; no prior threshold was recorded. Both versions formatted with the same Prettier before counting.",
  files: [],
};
for (const [path, names] of config) {
  const prior = spawnSync(
    "git",
    ["show", `${baselineCommit}:extensions/speedyapply-local/${path}`],
    { cwd: root, encoding: "utf8" },
  );
  if (prior.status) throw Error(prior.stderr);
  const original = await format(prior.stdout, { parser: "babel" }),
    current = await format(await fs.readFile(new URL(path, root), "utf8"), {
      parser: "babel",
    });
  report.files.push({
    path,
    baselineLines: original.split("\n").length,
    currentLines: current.split("\n").length,
    baseline: measure(original, names),
    current: measure(current, names),
  });
}
await fs.writeFile(
  new URL("../.qa/readability-baseline.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
