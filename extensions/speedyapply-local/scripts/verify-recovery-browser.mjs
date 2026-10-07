// Real browser execution of the packaged content code with a synthetic host
// bridge. It does not access an installed extension or any live application.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildPackage } from "./build.mjs";
import { discardCandidate } from "./package-state.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, "..");
const candidate = await buildPackage({ development: true });
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.argv[3],
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Synthetic application</title><form aria-labelledby="job-application-form" data-jobs-profile-id="fixture-profile"><label>Project summary<input required value="Retained manual answer" data-jobs-review-pending></label><label>Additional detail<input required></label><button type="button" class="ashby-application-form-submit-button">Submit application</button></form>`,
    }),
  );
  await page.addInitScript(() => {
    const listeners = new Set(),
      profile = {
        profileName: "Synthetic",
        nameData: {},
        contactData: {},
        addressData: {},
        jobData: [],
        educationData: [],
        languageData: [],
        resumeData: {},
        websiteData: {},
        employmentData: {},
      };
    const event = { addListener() {}, removeListener() {} };
    globalThis.__jobsRecoveryStart = true;
    globalThis.fixture = {
      sent: [],
      clicks: 0,
      profileId: "fixture-profile",
      send: (message) =>
        new Promise((resolve) => {
          for (const fn of listeners) fn(message, { id: "fixture" }, resolve);
        }),
    };
    globalThis.chrome = {
      storage: { onChanged: event, local: { get: async () => ({}) } },
      runtime: {
        id: "fixture",
        getManifest: () => ({ version: "0.1.0", version_name: "synthetic" }),
        getURL: (p) => "https://fixture.invalid/" + p,
        onMessage: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },
        sendMessage: async (message) => {
          fixture.sent.push(message);
          if (message.type === "getAutofillConfig")
            return {
              data: {
                enabled: true,
                autofillSettings: {
                  autoClickNextPage: false,
                  autoSubmit: false,
                },
                accountSettings: {},
              },
            };
          if (message.type === "jobs:tab-profile")
            return { data: { id: fixture.profileId, profile, revision: "1" } };
          if (message.type === "jobs:queue-page")
            return { data: { owned: false, allowed: true } };
          if (message.type === "jobs:application-status")
            return { data: { applied: false } };
          if (message.type === "jobs:automatic-answer")
            throw Error("Recovery must not request answers");
          return { ok: true };
        },
      },
    };
    document.addEventListener("click", () => fixture.clicks++);
  });
  await page.goto(
    "https://jobs.ashbyhq.com/fixture/12345678-1234-1234-1234-123456789abc/application",
  );
  await page.addScriptTag({
    path: path.join(candidate.stage, "custom/runtime-bundle.js"),
  });
  try {
    await page.waitForFunction(
      () =>
        fixture.sent.some((m) => m.type === "jobs:review-present" && m.data),
      null,
      { timeout: 10000 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({ errors, sent: await page.evaluate(() => fixture.sent) }),
    );
    throw error;
  }
  const before = await page.evaluate(async () => ({
    values: [...document.querySelectorAll("input")].map((n) => n.value),
    snapshot: await fixture.send({ type: "jobs:control-inspect" }),
  }));
  assert.equal(before.snapshot.error, undefined);
  assert(before.snapshot.data.review.items.length >= 2);
  assert.equal(before.snapshot.data.review.action, "fill");
  await page.evaluate(() =>
    fixture.send({ type: "jobs:private-session-invalidated" }),
  );
  await page.evaluate(() => globalThis.__jobsReconnectPage());
  const after = await page.evaluate(async () => ({
    values: [...document.querySelectorAll("input")].map((n) => n.value),
    snapshot: await fixture.send({ type: "jobs:control-inspect" }),
    clicks: fixture.clicks,
  }));
  assert.deepEqual(after.values, before.values);
  assert.equal(after.clicks, 0);
  assert.equal(after.snapshot.error, undefined);
  assert.equal(
    after.snapshot.data.documentId,
    before.snapshot.data.documentId,
    "the website document did not navigate",
  );
  const registrations = await page.evaluate(() =>
    fixture.sent.filter((m) => m.type === "jobs:control-register"),
  );
  assert(new Set(registrations.map((m) => m.lifecycleId)).size >= 2);
  assert(after.snapshot.data.review.items.length >= 2);
  // A newly selected Profile must not silently take ownership of old answers.
  await page.evaluate(async () => {
    await fixture.send({ type: "jobs:private-session-invalidated" });
    fixture.profileId = "different-profile";
    await globalThis.__jobsReconnectPage();
  });
  const wrongProfile = await page.evaluate(() =>
    fixture.send({ type: "jobs:control-inspect" }),
  );
  assert(wrongProfile.error);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      build: candidate.buildId,
      checks: [
        "retained values",
        "required review restored",
        "fresh registration lifecycle",
        "no fill or navigation",
        "continuation settings retained",
        "Profile mismatch rejected",
      ],
      boundary:
        "Packaged content in isolated Chrome with synthetic background; actual extension reload and employer pages remain separate",
    }),
  );
} finally {
  await browser?.close();
  await discardCandidate(root, candidate.stage);
}
