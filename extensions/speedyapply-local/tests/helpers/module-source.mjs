import fs from "node:fs/promises";
import { transform } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
const traverse = traverseModule.default ?? traverseModule;
export function functionBlock(source, name) {
  let found;
  traverse(parse(source, { sourceType: "unambiguous" }), {
    FunctionDeclaration(path) {
      if (path.node.id?.name === name) {
        if (found) throw new Error("Duplicate function " + name);
        found = path.node;
      }
    },
  });
  if (!found) throw new Error("Missing function " + name);
  const namespaces = new Set();
  traverse(parse(source, { sourceType: "unambiguous" }), {
    VariableDeclarator(p) {
      if (
        p.node.id.type === "Identifier" &&
        p.node.init?.type === "CallExpression" &&
        p.node.init.callee.name === "require"
      )
        namespaces.add(p.node.id.name);
    },
  });
  return (
    [...namespaces].map((name) => "var " + name + "=globalThis;").join("\n") +
    "\n" +
    source.slice(found.start, found.end)
  );
}
// Isolated DOM fixtures execute standard module output. Dependencies are explicit
// test doubles or previously loaded modules, linked through their real exports.
// No function bodies or imported references are rewritten by the test harness.
export async function readModule(file, encoding) {
  const source = await fs.readFile(file, encoding);
  const fileURL =
    file instanceof URL ? file : pathToFileURL(path.resolve(file));
  if (encoding !== "utf8" || !/^import |^export /m.test(source)) return source;
  const ast = parse(source, { sourceType: "module" });
  // Preserve the viewer's top-level-await completion. Link named imports to
  // the real dependencies loaded in its isolated JSDOM realm.
  if (fileURL.pathname.endsWith("/diagnostics-ui.js"))
    return (
      "(async()=>{" +
      source
        .replace(
          'import { mountDiagnosticsView } from "./diagnostics-view.jsx";',
          "const { mountDiagnosticsView } = globalThis;",
        )
        .replace(
          'import { historyEventMetrics } from "./history-event-metrics.js";',
          "const { historyEventMetrics } = globalThis;",
        ) +
      "})()"
    );
  const compiled = await transform(source, { format: "cjs", target: "es2023" });
  const pure = [];
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      /\/(stable-value|answer-vocabulary|answer-proof|run-state|run-stop|automatic-flow|field-description|form-context|profile-extra|profile-question-types|profile-contract|signature-answer|migration-maintenance|migration-context-fields|storage-migration-policy|diagnostic-evidence|corpus-observations|corpus-case|corpus-content|field-outcome|field-outcome-vocabulary)\.js$/.test(
        node.source.value,
      )
    )
      pure.push(await readModule(new URL(node.source.value, fileURL), "utf8"));
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/recovery-pause.js")
    )
      pure.push(
        "if (!globalThis.checkRecoveryPause) {" +
          (await readModule(new URL(node.source.value, fileURL), "utf8")) +
          "}",
      );
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/private-session.js")
    )
      pure.push(
        "if (!globalThis.JobsPrivateSession) {" +
          (await readModule(new URL(node.source.value, fileURL), "utf8")) +
          "}",
      );
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/brand.js")
    )
      pure.push(await readModule(new URL(node.source.value, fileURL), "utf8"));
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/public-job-url.js")
    ) {
      const base = new URL(node.source.value, fileURL);
      for (const name of [
        "job-match-rules.js",
        "job-match.js",
        "public-job-url.js",
      ])
        pure.push(await readModule(new URL(name, base), "utf8"));
    }
  return (
    pure.join("\n") +
    "\n(()=>{const module={exports:{}};const exports=module.exports;" +
    "const require=()=>new Proxy({}, {get:(_target,key)=>globalThis[key]});\n" +
    compiled.code +
    "\nfor(const [name,value] of Object.entries(module.exports)) if(name.startsWith('initialize')&&typeof value==='function') value();" +
    "\nObject.assign(globalThis,module.exports);})();"
  );
}
