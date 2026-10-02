// Isolated Chromium quota regression. Synthetic data only; no owner browser.
// node scripts/verify-session-storage-browser.mjs <playwright-core> <chromium>
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, "..");
await fs.mkdir(path.join(root, ".qa"), { recursive: true });
const work = await fs.mkdtemp(path.join(root, ".qa/session-quota-"));
const extension = path.join(work, "extension");
await fs.mkdir(extension);
await fs.copyFile(
  path.join(root, "src/custom/private-session.js"),
  path.join(extension, "private-session.js"),
);
await fs.writeFile(
  path.join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Synthetic session quota regression",
    version: "1.0.0",
    permissions: ["storage"],
    background: { service_worker: "worker.js", type: "module" },
  }),
);
await fs.writeFile(
  path.join(extension, "worker.js"),
  'import { JobsPrivateSession } from "./private-session.js"; globalThis.sessionStore = JobsPrivateSession;',
);
const context = await chromium.launchPersistentContext(
  path.join(work, "browser"),
  {
    executablePath: process.argv[3],
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const evidence = await worker.evaluate(async () => {
    const store = globalThis.sessionStore;
    const profile = {
      id: "synthetic",
      profileName: "Synthetic",
      profile: {
        profileName: "Synthetic",
        resumeData: {
          resumeBase64: "A".repeat(600000),
          fileName: "synthetic.pdf",
        },
      },
    };
    let oldFailureAt, oldError;
    for (let id = 1; id <= 24; id++) {
      try {
        await chrome.storage.session.set({ ["profile_" + id]: profile });
      } catch (error) {
        oldFailureAt = id;
        oldError = error.message;
        break;
      }
    }
    // This extension and its entire browser profile were created for this test.
    await chrome.storage.session.clear();
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        store.commit(store.epoch, { ["profile_" + (i + 1)]: profile }),
      ),
    );
    const sharedBytes = await chrome.storage.session.getBytesInUse(null);
    const boundMs = Math.round(performance.now() - start);
    const hydrated = await store.readTab(24);
    const resumeIntact =
      hydrated.profile_24.profile.resumeData.resumeBase64 ===
      profile.profile.resumeData.resumeBase64;
    const receipt = { id: "once", state: "unknown" };
    await chrome.storage.session.set({
      jobsBrowserControlV1: {
        sessionId: "preserve",
        frames: {
          "1:0": { tabId: 1, snapshot: { data: "C".repeat(3000000) } },
        },
        journal: { once: { result: receipt, key: "command" } },
        results: [receipt],
      },
      jobsDiagnosticsV1: { reports: { synthetic: "D".repeat(3000000) } },
      syntheticReserve: "E".repeat(2700000),
      "jobsResponses:synthetic": [
        { question: "Synthetic", response: "Pending" },
      ],
    });
    const beforeRecovery = await chrome.storage.session.getBytesInUse(null);
    await store.commit(store.epoch, {
      job_1: { description: "F".repeat(1800000) },
    });
    const afterRecovery = await chrome.storage.session.getBytesInUse(null);
    const recovered = await chrome.storage.session.get([
      "jobsBrowserControlV1",
      "jobsResponses:synthetic",
      "job_1",
    ]);
    const preserved =
      recovered.jobsBrowserControlV1.sessionId === "preserve" &&
      recovered.jobsBrowserControlV1.journal.once.result.state === "unknown" &&
      recovered.jobsBrowserControlV1.results[0].id === "once" &&
      recovered["jobsResponses:synthetic"][0].response === "Pending" &&
      recovered.job_1.description.length === 1800000;
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        store.commit(store.epoch, {}, ["profile_" + (i + 1)]),
      ),
    );
    const released =
      Object.keys(
        (await chrome.storage.session.get("jobsSessionResumesV1"))
          .jobsSessionResumesV1 || {},
      ).length === 0;
    return {
      oldFailureAt,
      oldError,
      newTabs: 24,
      sharedBytes,
      boundMs,
      resumeIntact,
      beforeRecovery,
      afterRecovery,
      preserved,
      released,
    };
  });
  assert.match(evidence.oldError, /quota/i);
  assert(evidence.oldFailureAt <= 24);
  assert(evidence.sharedBytes < 1000000);
  assert(evidence.resumeIntact && evidence.preserved && evidence.released);
  assert(evidence.afterRecovery < evidence.beforeRecovery);
  await fs.writeFile(
    path.join(work, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify(
      { ...evidence, evidencePath: path.join(work, "evidence.json") },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
