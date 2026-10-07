// Independent Chrome + isolated content world. All answers/network are synthetic.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { functionBlock } from "../tests/helpers/module-source.mjs";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";
import { readAshbyCommit } from "../src/custom/ashby-page-state.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jobs-ashby-save-"));
let browser;
try {
  const testSource = await fs.readFile(
    new URL("../tests/ashby-save-ack.test.mjs", import.meta.url),
    "utf8",
  );
  let fixture = functionBlock(testSource, "fixture")
    .replace("w.eval(savedSource);", "")
    .replace(/w\.chrome = \{[\s\S]*?\n  \};/, "");
  const bundle = await build({
    stdin: {
      contents: `import * as React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';const w=window;${fixture};window.fixture=fixture(['email','textarea','yesno']);`,
      resolveDir: path.resolve(import.meta.dirname, ".."),
    },
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.argv[3],
  });
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="root"></div>',
    }),
  );
  await page.goto("https://jobs.ashbyhq.com/fixture/application");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cdp = await page.context().newCDPSession(page);
  const frame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frame,
    worldName: "jobs-fixture-content",
  });
  await cdp.send("Runtime.addBinding", {
    name: "jobsProbe",
    executionContextId,
  });
  // Execute the exact serializable page-world function as chrome.scripting does.
  cdp.on("Runtime.bindingCalled", async (event) => {
    if (event.name !== "jobsProbe") return;
    const args = JSON.parse(event.payload);
    const data = await page.evaluate(
      `(${readAshbyCommit.toString()})(${JSON.stringify(args.path)},${JSON.stringify(args.phase)},800)`,
    );
    await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `fixtureReplies.get(${args.id})(${JSON.stringify({ data })});fixtureReplies.delete(${args.id});`,
    });
  });
  const modules = await Promise.all(
    ["dom-wait.js", "control-fields.js", "ashby-saved-controls.js"].map(
      (file) =>
        readWithDependencies(
          new URL("../src/custom/" + file, import.meta.url),
          "utf8",
        ),
    ),
  );
  await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `globalThis.fixtureReplies=new Map();let requestId=0;globalThis.chrome={runtime:{sendMessage:(m)=>new Promise(resolve=>{const id=++requestId;fixtureReplies.set(id,resolve);jobsProbe(JSON.stringify({...m,id}));})}};${modules.join("\n")}`,
  });
  async function fill(index, value) {
    return cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{const node=document.querySelectorAll('[data-field-path]')[${index}].querySelector('input,textarea,.ashby-application-form-input-yesno');return !!(await JobsControlFields.chooseSpec(node,JobsControlFields.literalSpec(node,${JSON.stringify(value)})));})()`,
    });
  }
  const first = fill(0, "fixture@example.test");
  await page.waitForFunction(() => fixture.pending.length === 1);
  // Starting the second writer concurrently must not start a second request.
  const second = fill(1, "Synthetic project");
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => fixture.pending.length), 1);
  await page.evaluate(() => fixture.pending.shift()());
  assert.equal((await first).result.value, true);
  await page.waitForFunction(() => fixture.pending.length === 1);
  await page.evaluate(() => fixture.pending.shift()());
  assert.equal((await second).result.value, true);
  const third = fill(2, "No");
  await page.waitForFunction(() => fixture.pending.length === 1);
  await page.evaluate(() => fixture.pending.shift()());
  assert.equal((await third).result.value, true);
  assert.deepEqual(await page.evaluate(() => fixture.server), {
    "field-0": "fixture@example.test",
    "field-1": "Synthetic project",
    "field-2": false,
  });
  assert.equal(
    await page.evaluate(() => location.pathname),
    "/fixture/application",
  );
  console.log(
    "PASS: real Chrome isolated-world text/textarea/Yes-No saves serialized; server snapshot retained all three answers; no submission.",
  );
} finally {
  await browser?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
