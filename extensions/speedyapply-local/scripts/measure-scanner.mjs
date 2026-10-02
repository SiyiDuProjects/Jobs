import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
const root = new URL("../", import.meta.url),
  baselineCommit = "257a15f";
const fixture =
  "<form>" +
  Array.from(
    { length: 60 },
    (_, index) =>
      `<label>Question ${index}<input id="field-${index}" required></label>`,
  ).join("") +
  "</form>";
function baseline(name) {
  const result = spawnSync(
    "git",
    [
      "show",
      `${baselineCommit}:extensions/speedyapply-local/src/custom/${name}.js`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw Error(result.stderr);
  return result.stdout;
}
const prior = ["page-actions", "platform-config", "control-fields"].map(
  baseline,
);
const current = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
function sample(version) {
  const dom = new JSDOM(fixture, {
      url: "https://fixture.test/apply",
      runScripts: "outside-only",
    }),
    w = dom.window;
  w.__benchStructuralScans = 0;
  try {
    for (const code of version === "baseline" ? prior : [current])
      w.eval(
        version === "baseline"
          ? code.replace(
              "function scan() {",
              "function scan() {globalThis.__benchStructuralScans++;",
            )
          : code,
      );
    const api = w.JobsControlFields,
      root = w.document.querySelector("form"),
      started = performance.now();
    for (let i = 0; i < 40; i++) {
      const rows = api.create(w.document, () => root).scan();
      if (rows.length !== 60) throw Error("Fixed sample changed");
    }
    const elapsedMs = performance.now() - started,
      structuralScans = api.structuralScans
        ? api.structuralScans()
        : w.__benchStructuralScans;
    root.querySelector("input").value = "Synthetic update";
    if (api.create(w.document, () => root).scan()[0].raw !== "Synthetic update")
      throw Error("Property read lost");
    root.insertAdjacentHTML(
      "beforeend",
      '<label>Conditional<select required><option value="">Select</option><option>Yes</option></select></label>',
    );
    const conditionalCount = api.create(w.document, () => root).scan().length;
    if (conditionalCount !== 61) throw Error("Conditional control lost");
    api.dispose?.(w.document);
    return {
      elapsedMs,
      structuralScans,
      reads: 40,
      fields: 60,
      propertyRead: true,
      conditionalCount,
    };
  } finally {
    w.close();
  }
}
const evidence = {
  baselineCommit,
  fixture:
    "60 required labelled inputs, 40 repeated reads; property update; conditional required select insertion",
  runs: [],
};
for (let index = 0; index < 3; index++)
  evidence.runs.push({
    baseline: sample("baseline"),
    current: sample("current"),
  });
if (
  evidence.runs.some(
    (row) =>
      row.current.structuralScans !== 1 || row.baseline.structuralScans !== 40,
  )
)
  throw Error("Performance count regression");
await fs.mkdir(new URL("../.qa", import.meta.url), { recursive: true });
await fs.writeFile(
  new URL("../.qa/scanner-performance.json", import.meta.url),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
