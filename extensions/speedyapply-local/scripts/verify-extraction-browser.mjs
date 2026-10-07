// Isolated browser, intercepted synthetic URLs; never touches application tabs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const result = await build({
  stdin: {
    contents:
      "import { extractJob } from './source/content/shell.js'; import { jobsAdapterRoutes } from './source/content/routing.js'; globalThis.extractJob = extractJob; globalThis.routes = jobsAdapterRoutes;",
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome120",
});
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
});
try {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    '<h1>Synthetic job</h1><script type="application/ld+json"></script>',
  );
  await page.addScriptTag({ content: result.outputFiles[0].text });
  const description = await page.evaluate(() => {
    document.querySelector('script[type="application/ld+json"]').textContent =
      JSON.stringify({
        "@type": "JobPosting",
        description:
          '<p>Useful description</p><img src="https://fixture.invalid/pixel"><iframe src="https://fixture.invalid/frame"></iframe><script>window.unwanted=true</script>',
      });
    return globalThis.extractJob().description;
  });
  assert.match(description, /Useful description/);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.deepEqual(requests, []);
  assert.equal(await page.evaluate(() => !!window.unwanted), false);
  const control = page.waitForRequest("https://fixture.invalid/control");
  await page.evaluate(() => {
    const image = new Image();
    image.src = "https://fixture.invalid/control";
  });
  await control;
  assert.deepEqual(requests, ["https://fixture.invalid/control"]);
  assert.deepEqual(
    await page.evaluate(() => {
      return [
        "https://fixture.invalid/a.myworkdayjobs.com/",
        "https://fixture.invalid/a.successfactors.com/",
        "https://fixture.invalid/a.icims.com/",
      ].map((url) =>
        globalThis.routes.some((route) => route.pattern?.test(url)),
      );
    }),
    [false, false, false],
  );
  console.log(
    "Inert extraction and hostname routing passed in isolated Chrome",
  );
} finally {
  await browser.close();
}
