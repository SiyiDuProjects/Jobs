import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { measure } from "./source-metrics.mjs";
const root = new URL("../", import.meta.url);
export async function checkSourceSize() {
  const policy = JSON.parse(
      await fs.readFile(
        new URL("source/readability-limits.json", root),
        "utf8",
      ),
    ),
    failures = [];
  for (const [file, limits] of Object.entries(policy.files)) {
    const source = await format(
        await fs.readFile(new URL(file, root), "utf8"),
        { parser: "babel" },
      ),
      lines = source.split("\n").length;
    if (lines > limits.maxLines)
      failures.push(`${file}: ${lines} lines > ${limits.maxLines}`);
    const metrics = measure(source, Object.keys(limits.functions));
    for (const [name, limit] of Object.entries(limits.functions)) {
      const value = metrics[name];
      if (!value) {
        failures.push(`${file}: ${name} missing`);
        continue;
      }
      if (value.lines > limit.maxLines || value.ownLines > limit.maxOwnLines)
        failures.push(
          `${file}:${name} ${value.lines}/${value.ownLines} lines exceed ${limit.maxLines}/${limit.maxOwnLines}`,
        );
    }
  }
  return failures;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const failures = await checkSourceSize();
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Reviewed source-size limits passed");
}
