import fs from "node:fs/promises";
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
  return source.slice(found.start, found.end);
}
// Unit tests install explicit dependencies/stubs in their isolated world.
// Strip only ES linkage, retaining the exact maintained function bodies.
export async function readModule(file, encoding) {
  const source = await fs.readFile(file, encoding);
  const fileURL =
    file instanceof URL ? file : pathToFileURL(path.resolve(file));
  if (encoding !== "utf8" || !/^import |^export /m.test(source)) return source;
  const ast = parse(source, { sourceType: "module" }),
    edits = [],
    exports = [],
    initializers = [];
  let asyncModule = false;
  traverse(ast, {
    AwaitExpression(p) {
      if (!p.getFunctionParent()) asyncModule = true;
    },
    ImportDeclaration(p) {
      for (const specifier of p.node.specifiers) {
        const name = specifier.local.name,
          binding = p.scope.getBinding(name);
        for (const ref of binding?.referencePaths || [])
          edits.push({
            start: ref.node.start,
            end: ref.node.end,
            text: "globalThis." + name,
          });
      }
      edits.push({ start: p.node.start, end: p.node.end, text: "" });
    },
    ExportNamedDeclaration(p) {
      const node = p.node;
      if (node.declaration) {
        edits.push({
          start: node.start,
          end: node.declaration.start,
          text: "",
        });
        if (node.declaration.type === "VariableDeclaration")
          for (const d of node.declaration.declarations)
            exports.push(d.id.name);
        if (node.declaration.type === "FunctionDeclaration") {
          const name = node.declaration.id.name;
          if (name.startsWith("initialize")) initializers.push(name);
          else exports.push(name);
        }
      } else {
        for (const specifier of node.specifiers)
          exports.push(specifier.local.name);
        edits.push({ start: node.start, end: node.end, text: "" });
      }
    },
  });
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  const pure = [];
  for (const node of ast.program.body)
    if (
      node.type === "ImportDeclaration" &&
      /\/(migration-maintenance|migration-context-fields|storage-migration-policy)\.js$/.test(
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
    "\n" +
    "(" +
    (asyncModule ? "async " : "") +
    "()=>{\n" +
    output +
    "\n" +
    initializers.map((name) => name + "();").join("\n") +
    "\n" +
    exports.map((name) => "globalThis." + name + "=" + name + ";").join("\n") +
    "\n})();"
  );
}
