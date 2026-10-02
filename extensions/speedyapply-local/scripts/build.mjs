import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { applicationMatches } from "../source/configuration.js";
import {
  sourceFingerprint,
  installedFingerprint,
  packageFingerprint,
  receiptName,
  discardCandidate,
} from "./package-state.mjs";
import { generateContracts } from "./generate-contracts.mjs";
import { buildPopup } from "./build-popup.mjs";
const root = path.resolve(import.meta.dirname, "..");
export async function buildPackage({ publish = false, personal = false } = {}) {
  if (publish)
    throw Error(
      "Use npm run update to check and update the installed extension",
    );
  await generateContracts();
  const sourceHash = await sourceFingerprint(root);
  const baseHash = await installedFingerprint(root);
  const brand = JSON.parse(
    await fs.readFile(
      new URL(
        "../../../services/jobs-radar/config/brand.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const template = JSON.parse(
    await fs.readFile(path.join(root, "src/manifest.json"), "utf8"),
  );
  const stage = await fs.mkdtemp(path.join(root, ".build-"));
  try {
    const buildId = sourceHash.slice(0, 16);
    let connection = null;
    if (personal) {
      connection = JSON.parse(
        await fs.readFile(path.join(root, ".private/connection.json"), "utf8"),
      );
      if (
        !/^[a-z]{32}$/.test(connection.extensionId) ||
        connection.origin !== new URL(brand.website).origin ||
        !/^[A-Za-z0-9_-]{64}$/.test(connection.token) ||
        !/^[A-Za-z0-9_-]{64}$/.test(connection.profileToken)
      )
        throw Error("Invalid private connection configuration");
    }
    const generated = {
      "brand.js":
        "export const JobsBrand=" +
        JSON.stringify({ ...brand, origin: new URL(brand.website).origin }) +
        ";",
      "build-info.js":
        "export const JobsBuildInfo=" + JSON.stringify({ id: buildId }) + ";",
      "private-connection.js":
        "export const JobsPrivateConnection=" +
        JSON.stringify(connection) +
        ";export function initializePrivateConnection(){}",
    };
    const virtual = {
      name: "generated-configuration",
      setup(builder) {
        builder.onLoad(
          {
            filter:
              /[\\/]src[\\/]custom[\\/](?:brand|build-info|private-connection)\.js$/,
          },
          (args) => ({
            contents: generated[path.basename(args.path)],
            loader: "js",
          }),
        );
      },
    };
    for (const [entry, outfile, format] of [
      ["content", "custom/runtime-bundle.js", "iife"],
      ["review-surface", "custom/review-surface.js", "iife"],
      ["background", "background.js", "esm"],
    ]) {
      const result = await build({
        absWorkingDir: root,
        entryPoints: ["source/entries/" + entry + ".js"],
        bundle: true,
        write: false,
        format,
        target: "chrome120",
        legalComments: "none",
        metafile: true,
        plugins: [virtual],
      });
      for (const file of result.outputFiles) {
        await fs.mkdir(path.dirname(path.join(stage, outfile)), {
          recursive: true,
        });
        await fs.writeFile(path.join(stage, outfile), file.contents);
      }
      await fs.writeFile(
        path.join(stage, entry + "-modules.json"),
        JSON.stringify(Object.keys(result.metafile.inputs), null, 2),
      );
    }
    await fs.cp(path.join(root, "src/icon"), path.join(stage, "icon"), {
      recursive: true,
    });
    for (const name of [
      "popup.html",
      "diagnostics.html",
      "queue.html",
      "queue-entry.html",
      "migration.html",
    ])
      await fs.copyFile(path.join(root, "src", name), path.join(stage, name));
    for (const name of ["diagnostics-ui.css", "queue.css", "migration-ui.css"])
      await fs.copyFile(
        path.join(root, "src/custom", name),
        path.join(stage, "custom", name),
      );
    for (const name of [
      "diagnostics-ui",
      "queue-ui",
      "site-bridge",
      "migration-ui",
    ])
      await build({
        absWorkingDir: root,
        entryPoints: ["src/custom/" + name + ".js"],
        bundle: true,
        outfile: path.join(stage, "custom", name + ".js"),
        format: name === "diagnostics-ui" ? "esm" : "iife",
        target: "chrome120",
        plugins: [virtual],
      });
    await buildPopup(root, stage, [virtual]);
    const manifest = {
      ...template,
      name: brand.name,
      description: brand.extensionDescription,
      version: "3.0.0",
      version_name: buildId,
      background: { service_worker: "background.js", type: "module" },
      action: { default_title: brand.name, default_popup: "popup.html" },
      content_scripts: [
        {
          matches: applicationMatches,
          all_frames: true,
          run_at: "document_idle",
          js: ["custom/runtime-bundle.js"],
        },
        {
          matches: [new URL(brand.website).origin + "/*"],
          run_at: "document_idle",
          js: ["custom/site-bridge.js"],
        },
      ],
    };
    await fs.writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if ((await sourceFingerprint(root)) !== sourceHash)
      throw Error(
        "Source changed during build; rerun npm run update after edits settle",
      );
    await fs.writeFile(
      path.join(stage, receiptName),
      JSON.stringify(
        {
          version: 1,
          root: await fs.realpath(root),
          sourceHash,
          baseHash,
          packageHash: await packageFingerprint(stage),
          buildId,
          personal,
          checks: [],
        },
        null,
        2,
      ) + "\n",
    );
    return { buildId, stage, sourceHash, baseHash, published: false };
  } catch (error) {
    await discardCandidate(root, stage);
    throw error;
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  if (process.argv.includes("--publish")) {
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/update-package.mjs")],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } else
    console.log(
      JSON.stringify(
        await buildPackage({
          publish: process.argv.includes("--publish"),
          personal: process.argv.includes("--personal"),
        }),
      ),
    );
