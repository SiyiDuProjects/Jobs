import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const output = new URL("../../jobs_radar/static/", import.meta.url);

test("website entries pin every lazy import to the same immutable asset directory", async () => {
  const root = await fs.readFile(new URL("index.html", output), "utf8");
  const manage = await fs.readFile(new URL("manage/index.html", output), "utf8");
  assert.equal(manage, root);
  const references = [...root.matchAll(/\/assets\/([a-f0-9]{16})\/(board\.(?:js|css))/g)];
  assert.equal(references.length, 2);
  assert.equal(references[0][1], references[1][1]);
  for (const [, , name] of references) {
    assert((await fs.stat(new URL(name, output))).size > 0);
  }
  assert.deepEqual((await fs.readdir(output)).sort(), ["board.css", "board.js", "chunks", "index.html", "manage"]);
  assert.deepEqual(await fs.readdir(new URL("manage/", output)), ["index.html"]);
  const chunks = await fs.readdir(new URL("chunks/", output));
  assert(chunks.length > 0, "management and charts should load on demand");
  for (const name of chunks) assert.match(name, /^[A-Za-z0-9_-]+\.js$/);
  const names = new Set(["board.js", ...chunks.map(name => "chunks/" + name)]);
  const visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const file = new URL(name, output);
    const code = await fs.readFile(file, "utf8");
    for (const [, relative] of code.matchAll(/(?:from\s*|import\s*\(?\s*)["'`](\.[^"'`]+)["'`]/g)) {
      const target = new URL(relative, file);
      assert(target.href.startsWith(output.href), "imports stay inside their bundle");
      const member = target.href.slice(output.href.length);
      assert(names.has(member), "every imported chunk is packaged: " + member);
      await visit(member);
    }
  }
  await visit("board.js");
  assert.deepEqual([...visited].sort(), [...names].sort(), "all shipped JS is reachable from the entry");
});
