import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { nativePackage } from "./helpers/native-package.mjs";
const root = new URL("../", import.meta.url);
test("every registered ATS has one imported maintained adapter entry", async () => {
  const source = await fs.readFile(
    new URL("source/content/routing.js", root),
    "utf8",
  );
  const ast = parse(source, { sourceType: "module" });
  const registry = ast.program.body
    .find(
      (n) =>
        n.type === "VariableDeclaration" &&
        n.declarations.some((d) => d.id.name === "jobsAdapterRoutes"),
    )
    .declarations.find((d) => d.id.name === "jobsAdapterRoutes").init;
  const entries = registry.elements.map(
    (n) => n.properties.find((p) => p.key.name === "script").value.name,
  );
  assert.equal(entries.length, 30);
  assert.equal(new Set(entries).size, 30);
  const imports = new Map(
    ast.program.body
      .filter((n) => n.type === "ImportDeclaration")
      .flatMap((n) => n.specifiers.map((s) => [s.local.name, n.source.value])),
  );
  for (const entry of entries) {
    assert(imports.get(entry)?.startsWith("./adapters/"));
    const source = await fs.readFile(
      new URL("source/content/" + imports.get(entry), root),
      "utf8",
    );
    const module = parse(source, { sourceType: "module" });
    assert(
      module.program.body.some(
        (n) => n.type === "FunctionDeclaration" && n.id.name === entry,
      ),
    );
  }
});
test("native build input includes all thirty maintained adapters and no upstream template", async () => {
  const result = await nativePackage();
  const inputs = JSON.parse(
    await fs.readFile(result.stage + "/content-modules.json", "utf8"),
  );
  assert.equal(
    inputs.filter((name) => /^source\/content\/adapters\/.+\.js$/.test(name))
      .length,
    30,
  );
  assert(
    !inputs.some((name) =>
      /vendor|runtime\.template|src\/chunks|src\/background\.js/.test(name),
    ),
  );
  assert(inputs.includes("source/content/shell.js"));
});
test("ES module resolution rejects missing dependencies and unexported methods before publication", async () => {
  for (const contents of [
    "import {notExported} from './src/custom/control-fields.js'; console.log(notExported);",
    "import './source/no-such-module.js';",
  ]) {
    await assert.rejects(
      build({
        stdin: {
          contents,
          resolveDir: new URL("../", import.meta.url).pathname.replace(
            /^\/([A-Z]:)/,
            "$1",
          ),
        },
        bundle: true,
        write: false,
        logLevel: "silent",
      }),
    );
  }
});

test("content frames and the injected top presenter defer editor libraries to one packaged module", async () => {
  const result = await nativePackage();
  const inputs = async (entry) =>
    JSON.parse(
      await fs.readFile(result.stage + "/" + entry + "-modules.json", "utf8"),
    );
  for (const entry of ["content", "review-surface"]) {
    const files = await inputs(entry);
    assert(
      !files.some((file) =>
        /node_modules\/(?:react|react-dom|@heroui|@heroui-pro)\//.test(file),
      ),
      entry + " must not parse editor libraries before review",
    );
    assert(!files.includes("src/custom/review-view.js"));
  }
  const presenter = await inputs("review-surface");
  assert(
    !presenter.includes("src/custom/control-fields.js"),
    "the injected presenter must not initialize form scanners",
  );
  assert(presenter.includes("src/custom/continuation.js"));
  assert(
    (await inputs("review-ui")).includes("src/custom/review-components.js"),
  );
  await fs.access(result.stage + "/custom/review-ui.js");
  const manifest = JSON.parse(
    await fs.readFile(result.stage + "/manifest.json", "utf8"),
  );
  assert(
    manifest.web_accessible_resources.some((row) =>
      row.resources.includes("custom/review-ui.js"),
    ),
  );
  assert.equal(
    manifest.content_scripts.find((row) =>
      row.js.includes("custom/runtime-bundle.js"),
    ).all_frames,
    true,
  );
  const sizes = {};
  for (const name of ["runtime-bundle", "review-surface", "review-ui"])
    sizes[name] = (
      await fs.stat(result.stage + "/custom/" + name + ".js")
    ).size;
  console.info("Deferred review bundle bytes:", JSON.stringify(sizes));
});
