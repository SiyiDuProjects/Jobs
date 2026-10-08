import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
const traverse = traverseModule.default ?? traverseModule;

test("whole-question regular expressions cannot grow", async () => {
  const source = await fs.readFile(
    new URL("../src/custom/profile-answers.js", import.meta.url),
    "utf8",
  );
  let count = 0;
  traverse(parse(source, { sourceType: "module" }), {
    RegExpLiteral({ node }) {
      if (node.pattern.startsWith("^") && node.pattern.endsWith("$")) count++;
    },
  });
  assert.ok(
    count <= 131,
    `Whole-question expressions: ${count}; use the semantic answer contract instead`,
  );
});
