import fs from "node:fs/promises";
import path from "node:path";
import { build, transform } from "esbuild";
import { compile } from "@tailwindcss/node";

export async function buildPopup(root, stage, plugins) {
  await build({
    absWorkingDir: root,
    entryPoints: ["src/custom/popup.jsx"],
    bundle: true,
    outfile: path.join(stage, "custom/popup.js"),
    format: "iife",
    target: "chrome120",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins,
  });
  const input = path.join(root, "src/custom/popup.css");
  const compiler = await compile(await fs.readFile(input, "utf8"), {
    base: path.dirname(input),
    onDependency() {},
  });
  const css = await transform(compiler.build([]), {
    loader: "css",
    minify: true,
    target: "chrome120",
  });
  await fs.writeFile(path.join(stage, "custom/popup.css"), css.code);
}
