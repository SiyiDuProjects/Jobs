import fs from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const uiBundles = new Map();
async function uiModule(name) {
  if (!uiBundles.has(name))
    uiBundles.set(
      name,
      build({
        entryPoints: [fileURLToPath(new URL(name, custom))],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "JobsUIFixture",
        platform: "browser",
        target: "es2023",
        define: { "process.env.NODE_ENV": '"production"' },
      }).then(
        (result) =>
          `globalThis.CSS ||= {escape: value => String(value).replace(/[^\\w-]/g, c => "\\\\" + c), supports: () => false};
globalThis.matchMedia ||= () => ({matches:false, addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
globalThis.ResizeObserver ||= class {observe(){} unobserve(){} disconnect(){}};
globalThis.IntersectionObserver ||= class {observe(){} unobserve(){} disconnect(){}};
globalThis.requestAnimationFrame ||= callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame ||= clearTimeout;
HTMLElement.prototype.getAnimations ||= () => [];
HTMLElement.prototype.scrollIntoView ||= () => {};
` +
          result.outputFiles[0].text +
          "\nObject.assign(globalThis, JobsUIFixture);",
      ),
    );
  return uiBundles.get(name);
}
import { readModule } from "./module-source.mjs";

// Unit fixtures can load a single module, while the extension loads packaged
// scripts in manifest order. Include the real shared dependencies (platform
// declarations, the page action boundary), never a stub or duplicate.
// Manifest ordering has its own contract test.
const custom = new URL("../../src/custom/", import.meta.url);
const dependencies = {
  "diagnostics-ui.js": ["history-event-metrics.js", "diagnostics-view.jsx"],
  "review-presenter.js": ["operator-state.js", "page-review.js"],
  "page-review.js": ["review-view.js", "deferred-review-view.js"],
  "review-view.js": ["calendar-date.js", "review-components.js"],
  "submission-guard.js": [
    "job-match-rules.js",
    "job-match.js",
    "page-actions.js",
  ],
  "answer-memory.js": [
    "operator-state.js",
    "job-match-rules.js",
    "job-match.js",
  ],
  "automatic-field-policy.js": ["answer-proof.js"],
  "form-pipeline.js": ["page-actions.js", "dom-wait.js", "page-commit.js"],
  "manual-answer.js": ["form-pipeline.js"],
  "event-log-background.js": [
    "event-log-store.js",
    "event-log-transport.js",
    "history-event-metrics.js",
    "diagnostic-evidence.js",
  ],
  "event-log-store.js": ["event-log-limits.js"],
  "diagnostics.js": [
    "history-event-metrics.js",
    "diagnostic-evidence.js",
    "event-stream.js",
    "corpus-content.js",
  ],
  "corpus-content.js": ["corpus-case.js"],
  "corpus-case.js": ["corpus-observations.js"],
  "control-fields.js": [
    "dom-wait.js",
    "calendar-date.js",
    "select-state.js",
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
  "automatic-background.js": ["answer-proof.js"],
  "automatic-fill.js": [
    "prepare-answers.js",
    "request-answers.js",
    "search-answer.js",
    "automatic-flow.js",
    "automatic-field-policy.js",
    "recover-review.js",
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
    "form-pipeline.js",
  ],
  "ai-review.js": [
    "operator-state.js",
    "page-actions.js",
    "form-pipeline.js",
    "review-options.js",
  ],
  "control-content.js": [
    "automatic-field-policy.js",
    "recover-review.js",
    "page-actions.js",
    "option-match.js",
    "profile-answers.js",
    "form-pipeline.js",
    "ai-review.js",
    "automatic-fill.js",
  ],
};
export async function readWithDependencies(path, encoding, ancestors = []) {
  if (
    encoding === "utf8" &&
    /[/](review-components[.]js|diagnostics-view[.]jsx)$/.test(String(path))
  )
    return uiModule(String(path).split("/").pop());
  const value = await readModule(path, encoding);
  if (encoding !== "utf8") return value;
  const name = String(path)
    .replaceAll("\\", "/")
    .match(/\/src\/custom\/([^/]+)$/)?.[1];
  if (name === "operator-state.js")
    return "if (!globalThis.JobsOperator) {" + value + "}";
  if (!name || name === "page-actions.js") return value;
  if (ancestors.includes(name)) return "";
  const needed = [
    ...(dependencies[name] || []),
    ...(value.includes("JobsPageActions") && !dependencies[name]
      ? ["page-actions.js"]
      : []),
  ];
  if (/globalThis.public(?:Job|Page)Url/.test(value))
    needed.unshift("job-match-rules.js", "job-match.js", "public-job-url.js");
  const prefix = await Promise.all(
    // A control session also loads the automatic pipeline's preferences and
    // the pipeline's commit observer. Keep indirect dependencies real too.
    needed.map((file) =>
      readWithDependencies(new URL(file, custom), "utf8", [...ancestors, name]),
    ),
  );
  if (name === "page-review.js")
    // JSDOM cannot fetch chrome-extension modules. Keep the actual loader and
    // view, replacing only the module transport with the already loaded export.
    prefix.push(
      "globalThis.loadReviewView = createReviewLoader(async () => ({createReviewView}));",
    );
  return [...prefix, value].join("\n");
}
