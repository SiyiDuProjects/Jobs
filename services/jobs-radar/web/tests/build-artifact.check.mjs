import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const output = new URL("../../jobs_radar/static/", import.meta.url);

test("one build contains the website and management entry with matching assets", async () => {
  const root = await fs.readFile(new URL("index.html", output), "utf8");
  const manage = await fs.readFile(new URL("manage/index.html", output), "utf8");
  assert.equal(manage, root);
  const references = [...root.matchAll(/\/assets\/(board\.(?:js|css))\?v=([a-f0-9]{16})/g)];
  assert.equal(references.length, 2);
  assert.equal(references[0][2], references[1][2]);
  for (const [, name] of references) {
    assert((await fs.stat(new URL(name, output))).size > 0);
  }
  assert.deepEqual((await fs.readdir(output)).sort(), ["board.css", "board.js", "index.html", "manage"]);
  assert.deepEqual(await fs.readdir(new URL("manage/", output)), ["index.html"]);
});
