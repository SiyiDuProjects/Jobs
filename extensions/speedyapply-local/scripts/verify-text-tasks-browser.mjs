// Separate Chrome, synthetic React form, no real accounts or application pages.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { readWithDependencies } from "../tests/helpers/runtime-source.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const source = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const fixture = await build({
  stdin: {
    contents: `import * as React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      window.saved = {};
      function Field({id}) {
        const [draft, setDraft] = React.useState('');
        return React.createElement('input', {
          id, value:draft, 'aria-label':id,
          onChange:e=>{
            const value=e.target.value;
            if(window.deferDraft) setTimeout(()=>setDraft(value),0);
            else setDraft(value);
          },
          onBlur:()=>{window.saved[id]=draft;},
        });
      }
      flushSync(()=>createRoot(document.getElementById('root')).render(
        React.createElement('form', null,
          ...['first_name','last_name','email','phone'].map(id=>React.createElement(Field,{id,key:id}))
        )
      ));`,
    resolveDir: new URL("..", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.argv[3],
});
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="root"></div>',
    }),
  );
  async function install(code, pauseTimers) {
    await page.goto("https://jobs.example.test/synthetic");
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    const cdp = await page.context().newCDPSession(page);
    const frameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: "jobs-text-task-fixture",
    });
    async function evaluate(expression, awaitPromise = true) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        contextId: executionContextId,
        awaitPromise,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await evaluate(`${code}
      globalThis.done=false;globalThis.timerCalls=0;
      ${pauseTimers ? "globalThis.setTimeout=()=>{timerCalls++;return 1;};globalThis.requestAnimationFrame=()=>1;" : ""}`);
    return { cdp, evaluate };
  }
  const expression = `(async()=>{
    const values={first_name:'Fixture',last_name:'Applicant',email:'fixture@example.test',phone:'5550100'};
    for(const [id,value] of Object.entries(values)) {
      const node=document.getElementById(id);
      if(!await JobsControlFields.chooseSpec(node,JobsControlFields.literalSpec(node,value))) throw Error('Write rejected: '+id);
    }
    globalThis.done=true;
    return {done,timerCalls};
  })()`;
  // The exact old waiting statements must stall under the same test conditions.
  const baseline = source.replaceAll(
    "globalThis.JobsDOMWait.task(view)",
    "new Promise(resolve => view.setTimeout(resolve, 0))",
  );
  assert.notEqual(baseline, source);
  let session = await install(baseline, true);
  await session.evaluate(`globalThis.pending=${expression};undefined`, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await session.evaluate("({done,timerCalls})"), {
    done: false,
    timerCalls: 1,
  });
  await session.cdp.detach();
  for (const [pauseTimers, deferDraft] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    session = await install(source, pauseTimers);
    await page.evaluate((value) => {
      window.deferDraft = value;
    }, deferDraft);
    const result = await Promise.race([
      session.evaluate(expression),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Text task stalled")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(result.done, true);
    if (pauseTimers) assert.equal(result.timerCalls, 0);
    assert.deepEqual(await page.evaluate(() => window.saved), {
      first_name: "Fixture",
      last_name: "Applicant",
      email: "fixture@example.test",
      phone: "5550100",
    });
    await session.cdp.detach();
  }
  console.log(
    "PASS: old writer stalls; current isolated-world writer commits all four React fields with timers running or suspended; no application or submission.",
  );
} finally {
  await browser.close();
}
