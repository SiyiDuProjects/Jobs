import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { writeResponseContract } from "./build-response-contract.mjs";
import { buildProfileContract } from "../../../services/jobs-radar/scripts/build-profile-contract.mjs";
const root = new URL("../", import.meta.url),
  service = new URL("../../../services/jobs-radar/", import.meta.url);
export async function generateContracts() {
  await writeResponseContract();
  await buildProfileContract({ target: "extension" });
  const rules = JSON.parse(
    await fs.readFile(
      new URL("jobs_radar/job_match_rules.json", service),
      "utf8",
    ),
  );
  await fs.writeFile(
    new URL("src/custom/job-match-rules.js", root),
    "// Generated from jobs_radar/job_match_rules.json. Do not edit.\nexport var JobsMatchRules;\nlet initialized=false;\nexport function initializeJobMatchRules(){if(initialized)return;initialized=true;JobsMatchRules=" +
      JSON.stringify(rules) +
      ";}\n",
  );
  const brand = JSON.parse(
    await fs.readFile(new URL("config/brand.json", service), "utf8"),
  );
  await fs.writeFile(
    new URL("src/custom/brand.js", root),
    "// Generated from config/brand.json. Do not edit.\nexport const JobsBrand=" +
      JSON.stringify({ ...brand, origin: new URL(brand.website).origin }) +
      ";\n",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await generateContracts();
