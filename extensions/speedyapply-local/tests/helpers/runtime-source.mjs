import fs from "node:fs/promises";
import { readModule } from "./module-source.mjs";

// Unit fixtures can load a single module, while the extension loads packaged
// scripts in manifest order. Include the real shared dependencies (platform
// declarations, the page action boundary), never a stub or duplicate.
// Manifest ordering has its own contract test.
const custom = new URL("../../src/custom/", import.meta.url);
const dependencies = {
  "control-fields.js": [
    "page-actions.js",
    "platform-config.js",
    "option-match.js",
    "profile-answers.js",
  ],
  "legacy-select-controls.js": [
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
  ],
  "ashby-controls.js": [
    "page-actions.js",
    "platform-config.js",
    "option-match.js",
    "profile-answers.js",
  ],
  "greenhouse-controls.js": [
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
  ],
  "workday-controls.js": [
    "page-actions.js",
    "platform-config.js",
    "option-match.js",
    "profile-answers.js",
    "form-pipeline.js",
  ],
  "automatic-fill.js": [
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
    "form-pipeline.js",
  ],
  "ai-review.js": ["page-actions.js", "form-pipeline.js"],
  "control-content.js": [
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
    "form-pipeline.js",
    "ai-review.js",
    "automatic-fill.js",
  ],
};
export async function readWithDependencies(path, encoding) {
  const value = await readModule(path, encoding);
  if (encoding !== "utf8") return value;
  const name = String(path)
    .replaceAll("\\", "/")
    .match(/\/src\/custom\/([^/]+)$/)?.[1];
  if (!name || name === "page-actions.js") return value;
  const needed = [
    ...(dependencies[name] || []),
    ...(value.includes("globalThis.JobsPageActions") && !dependencies[name]
      ? ["page-actions.js"]
      : []),
  ];
  if (/globalThis.public(?:Job|Page)Url/.test(value))
    needed.unshift("job-match-rules.js", "job-match.js", "public-job-url.js");
  const prefix = await Promise.all(
    needed.map((file) => readModule(new URL(file, custom), "utf8")),
  );
  return [...prefix, value].join("\n");
}
