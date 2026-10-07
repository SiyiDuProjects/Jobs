import fs from "node:fs/promises";
import path from "node:path";
import { buildPackage } from "./build.mjs";
import { discardCandidate } from "./package-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const candidate = await buildPackage({ development: true });
const destination = path.join(root, "artifacts", "development");
try {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(candidate.stage, destination);
  console.log(
    "Development extension (separate ID, no live credentials): " + destination,
  );
} finally {
  await discardCandidate(root, candidate.stage);
}
