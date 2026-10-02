import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function responseContractSource() {
  const rules = JSON.parse(
    await fs.readFile(
      new URL("../../jobs_radar/saved_response_contract.json", import.meta.url),
      "utf8",
    ),
  );
  const template = await fs.readFile(
    new URL("../../contracts/response-contract.js", import.meta.url),
    "utf8",
  );
  return template.replace(
    "/* SAVED_RESPONSE_CONTRACT */ null",
    JSON.stringify(rules),
  );
}

export async function writeResponseContract() {
  await fs.writeFile(
    new URL("../src/manage/saved-response-contract.js", import.meta.url),
    await responseContractSource(),
  );
  await fs.writeFile(
    new URL("../src/manage/saved-response-contract.d.ts", import.meta.url),
    "// Generated Saved Response module declaration.\nexport declare const JobsResponseContract: any;\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeResponseContract();
}
