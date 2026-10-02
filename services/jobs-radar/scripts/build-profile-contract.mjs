import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const service = new URL("../", import.meta.url);
const schemaURL = new URL("jobs_radar/profile.schema.json", service);
const generated =
  "// Generated from jobs_radar/profile.schema.json. Do not edit.\n";
function type(node) {
  if (node.anyOf) return node.anyOf.map(type).join(" | ");
  if (node.enum)
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (node.type === "array") return `Array<${type(node.items)}>`;
  if (node.type === "object")
    return `{\n${Object.entries(node.properties || {})
      .map(
        ([key, value]) =>
          `  ${JSON.stringify(key)}${node.required?.includes(key) ? "" : "?"}: ${type(value)};`,
      )
      .join(
        "\n",
      )}\n${node.additionalProperties !== false ? "  [key: string]: any;\n" : ""}}`;
  return node.type === "integer" ? "number" : node.type;
}
function checkKeywords(node) {
  const allowed = new Set([
    "$schema",
    "$id",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "minLength",
    "maxLength",
    "minimum",
    "pattern",
    "format",
  ]);
  for (const key of Object.keys(node))
    if (!allowed.has(key) && !key.startsWith("x-"))
      throw Error(`Unsupported validation keyword: ${key}`);
  if (node.format && node.format !== "optional-date")
    throw Error(`Unsupported format: ${node.format}`);
  Object.values(node.properties || {}).forEach(checkKeywords);
  (node.anyOf || []).forEach(checkKeywords);
  if (node.items) checkKeywords(node.items);
}
export async function buildProfileContract({
  check = false,
  target = "all",
} = {}) {
  if (!["web", "extension", "all"].includes(target))
    throw Error("Invalid generation target");
  const schema = JSON.parse(await fs.readFile(schemaURL, "utf8"));
  checkKeywords(schema);
  if (
    Object.keys(schema.properties).sort().join() !==
    Object.keys(schema["x-answerProjection"]).sort().join()
  )
    throw Error("Every Profile field needs an explicit answer projection");
  const runtime = await fs.readFile(
    new URL("contracts/profile-runtime.js", service),
    "utf8",
  );
  const policy = JSON.parse(
    await fs.readFile(
      new URL("jobs_radar/answer-policy.json", service),
      "utf8",
    ),
  );
  const source =
    generated +
    runtime +
    `\nexport const JobsProfileContract = makeProfileContract(${JSON.stringify(schema)});\n`;
  const outputs = new Map([
    [new URL("web/src/manage/profile-contract.js", service), source],
    [
      new URL(
        "../../extensions/speedyapply-local/src/custom/profile-contract.js",
        service,
      ),
      source,
    ],
    [
      new URL("web/src/manage/profile-types.ts", service),
      generated +
        `export type Profile = ${type(schema)};\nexport type ApplicationDetails = ${type(schema.properties.applicationData)};\n`,
    ],
    [
      new URL("web/src/manage/profile-contract.d.ts", service),
      generated +
        `import type {Profile} from './profile-types';\nexport declare const JobsProfileContract: {version:number; options: Record<string,string[]>; assertProfile(value:unknown): Profile; validate(value:unknown): {valid:boolean;errors:string[]}; projectAnswerProfile(value:unknown,options?:{partial?:boolean}): Partial<Profile>};\n`,
    ],
    [
      new URL(
        "../../extensions/speedyapply-local/src/custom/answer-policy.js",
        service,
      ),
      `// Generated from jobs_radar/answer-policy.json. Do not edit.\nexport const JobsAnswerPolicy = Object.freeze(${JSON.stringify({ version: policy.version, ...policy.rules })});\n`,
    ],
    [
      new URL("web/src/manage/profile-options.json", service),
      JSON.stringify(schema["x-uiOptions"], null, 2) + "\n",
    ],
  ]);
  for (const [url, text] of outputs) {
    const extension = url.pathname.includes("/extensions/");
    if (
      (target === "web" && extension) ||
      (target === "extension" && !extension)
    )
      continue;
    if (check) {
      if ((await fs.readFile(url, "utf8")) !== text)
        throw Error(`Stale generated contract: ${url.pathname}`);
    } else await fs.writeFile(url, text);
  }
  return source;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildProfileContract({
    check: process.argv.includes("--check"),
    target:
      process.argv
        .find((value) => value.startsWith("--target="))
        ?.split("=")[1] || "all",
  });
