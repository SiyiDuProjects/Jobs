import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { responseContractSource } from "../../../services/jobs-radar/web/scripts/build-response-contract.mjs";
const root = new URL("../", import.meta.url);
export async function writeResponseContract() {
  const source = await responseContractSource();
  for (const target of ["src/custom/response-contract.js"]) {
    await fs.writeFile(new URL(target, root), source);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await writeResponseContract();
