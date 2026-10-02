import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { replayCase } from "./repro-runner.mjs";

// Import is explicit and never overwrites an existing regression fixture.
// A captured failure is an observation baseline, NOT an expected successful fill.
export async function importCase(
  value,
  name,
  directory = new URL("../tests/fixtures/repro/", import.meta.url),
) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name || ""))
    throw Error(
      "Case name must contain lowercase letters, numbers and hyphens",
    );
  const results = replayCase(value);
  if (!results.every((r) => isDeepStrictEqual(r.expected, r.actual)))
    throw Error(
      "Snapshot does not reproduce the observed reader state. Inspect missing DOM/behavior before adding a regression; no passing test was fabricated.",
    );
  const folder = fileURLToPath(directory),
    output = path.resolve(folder, name + ".json");
  if (path.dirname(output) !== path.resolve(folder))
    throw Error("Unsafe output path");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(output, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
  return output;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, input, name] = process.argv.slice(2);
  if (!["inspect", "import"].includes(command) || !input)
    throw Error(
      "Usage: node scripts/repro-case.mjs inspect <case.json> | import <case.json> <case-name>",
    );
  const value = JSON.parse(await fs.readFile(input, "utf8"));
  const results = replayCase(value),
    matched = results.every((r) => isDeepStrictEqual(r.expected, r.actual));
  console.log(
    JSON.stringify(
      {
        build: value.build,
        fields: results,
        matched,
        limitations: value.limitations,
      },
      null,
      2,
    ),
  );
  if (command === "import") {
    const output = await importCase(value, name);
    console.log(
      "Imported observation regression: " +
        output +
        ". npm test includes it. Add targeted actions/expected corrected behavior when fixing the bug.",
    );
  } else if (!matched) process.exitCode = 1;
}
