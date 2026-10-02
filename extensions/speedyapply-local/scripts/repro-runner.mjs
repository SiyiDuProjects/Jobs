import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
const directory = new URL("../src/custom/", import.meta.url);
// Only inert readers/components are loaded. No ATS route, network bridge,
// submission flow, AI request or page runtime is executed offline.
export const readerModules = [
  "repro-case",
  "page-actions",
  "aria-controls",
  "oracle-controls",
  "tesla-controls",
  "dom-wait",
  "option-match",
  "profile-answers",
  "ashby-controls",
  "platform-config",
  "control-fields",
  "greenhouse-controls",
  "workday-controls",
  "icims-controls",
  "successfactors-controls",
  "menu-controls",
  "legacy-select-controls",
  "ats-choice-controls",
  "shadow-controls",
  "tag-controls",
  "disclosure-controls",
];
// Bundle the maintained ES modules with their real live imports. Initializers
// are explicit: importing the graph never starts the online application flow.
const entry =
  readerModules
    .map((name, index) => `import * as reader${index} from './${name}.js';`)
    .join("\n") +
  "\n" +
  readerModules
    .map(
      (_, index) =>
        `for(const [name,initialize] of Object.entries(reader${index}))if(name.startsWith('initialize'))initialize();`,
    )
    .join("\n") +
  "\nglobalThis.JobsReproCase=reader0.JobsReproCase;\n" +
  `globalThis.JobsControlFields=reader${readerModules.indexOf("control-fields")}.JobsControlFields;`;
const bundle = await build({
  stdin: {
    contents: entry,
    resolveDir: fileURLToPath(directory),
    sourcefile: "offline-readers.js",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const source = bundle.outputFiles[0].text;
export function replayCase(value) {
  value = JSON.parse(JSON.stringify(value));
  const checked = new JSDOM("", {
    url: "https://fixture.invalid",
    runScripts: "outside-only",
  });
  try {
    checked.window.TextEncoder = TextEncoder;
    checked.window.eval(source);
    checked.window.JobsReproCase.validate(value);
  } finally {
    checked.window.close();
  }
  const results = [];
  for (const field of value.fields) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: value.origin,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    try {
      const w = dom.window;
      w.TextEncoder = TextEncoder;
      w.CSS = {
        escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c),
      };
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.eval(source);
      w.JobsReproCase.mount(w.document, field);
      const targets = [];
      const visit = (root) => {
        targets.push(...root.querySelectorAll("[data-jobs-repro-target]"));
        for (const n of root.querySelectorAll("*"))
          if (n.shadowRoot) visit(n.shadowRoot);
      };
      visit(w.document);
      if (targets.length !== 1)
        throw Error(
          `${field.id}: target omitted or duplicated; snapshot is incomplete`,
        );
      const rows = w.JobsControlFields.create(w.document).scan();
      const matches = rows.filter(
        (r) =>
          r.node === targets[0] ||
          r.group?.includes(targets[0]) ||
          r.node.contains(targets[0]),
      );
      if (matches.length !== 1) {
        results.push({
          id: field.id,
          expected: field.observed,
          actual: null,
          matches: matches.length,
        });
        continue;
      }
      const row = matches[0].public;
      results.push({
        id: field.id,
        expected: field.observed,
        actual: {
          kind: row.type,
          component: row.component || "unknown",
          required: !!row.required,
          hasValue: !!row.filled,
          invalid: !!row.invalid,
          completion: w.JobsControlFields.completion(row),
        },
      });
    } finally {
      dom.window.close();
    }
  }
  return results;
}
