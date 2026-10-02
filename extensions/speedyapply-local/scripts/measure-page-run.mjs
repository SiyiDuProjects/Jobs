import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const baselineCommit = "257a15f",
  root = new URL("../", import.meta.url);
const names = [
  "page-actions",
  "platform-config",
  "option-match",
  "profile-answers",
  "dom-wait",
  "control-fields",
  "form-pipeline",
  "operation-context",
  "review-presenter",
  "ai-review",
  "automatic-fill",
];
const load = async (version) =>
  Promise.all(
    names.map(async (name) => {
      if (version === "current")
        return readWithDependencies(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        );
      const result = spawnSync(
        "git",
        [
          "show",
          `${baselineCommit}:extensions/speedyapply-local/src/custom/${name}.js`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      if (result.status) throw Error(result.stderr);
      return result.stdout;
    }),
  );
const versions = {
  baseline: await load("baseline"),
  current: await load("current"),
};
const fixture =
  "<form>" +
  Array.from(
    { length: 60 },
    (_, i) =>
      `<label>Question ${i}<input required value="Synthetic answer"></label>`,
  ).join("") +
  "</form>";
async function sample(version) {
  const w = new JSDOM(fixture, {
      url: "https://fixture.example/apply",
      runScripts: "outside-only",
    }).window,
    profile = { profileName: "Synthetic" },
    notes = [];
  w.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        throw Error("Unexpected network message " + m.type);
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
  };
  w.__structuralScans = 0;
  try {
    for (const source of versions[version])
      w.eval(
        version === "baseline"
          ? source.replace(
              "function scan() {",
              "function scan() {globalThis.__structuralScans++;",
            )
          : source,
      );
    const result = await w.JobsAutomatic.advance({
      root: w.document.querySelector("form"),
      profile,
      action: "fill",
      resolveAnswers: async () => [],
    });
    if (result !== true) throw Error(JSON.stringify(notes));
    const timing = notes.find((row) => row.type === "auto_run_timing");
    if (!timing) throw Error("Missing timing");
    return {
      ...JSON.parse(timing.detail),
      totalStructuralScans:
        version === "baseline"
          ? w.__structuralScans
          : w.JobsControlFields.structuralScans(),
    };
  } finally {
    w.JobsControlFields?.dispose?.(w.document);
    w.close();
  }
}
const evidence = {
  baselineCommit,
  fixture:
    "60 completed required fields; actual automatic advance to fill-only completion; zero answer/provider/network work",
  metric: "actual auto_run_timing",
  runs: [],
};
for (let i = 0; i < 3; i++)
  evidence.runs.push({
    baseline: await sample("baseline"),
    current: await sample("current"),
  });
await fs.writeFile(
  new URL("../.qa/page-run-performance.json", import.meta.url),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
