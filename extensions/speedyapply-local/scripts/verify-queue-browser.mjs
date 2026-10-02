// Isolated packaged MV3 integration; no owner profile, real ATS, or network.
// node scripts/verify-queue-browser.mjs <playwright-core path> <Chromium executable>
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildPackage } from "./build.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, ".."),
  stage = await buildPackage();
async function packageFiles(directory, prefix = "") {
  const records = [];
  for (const entry of (
    await fs.readdir(directory, { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    assert(!entry.isSymbolicLink(), "A package must not contain symlinks");
    const file = path.join(directory, entry.name),
      relative = prefix + entry.name;
    if (entry.isDirectory())
      records.push(...(await packageFiles(file, relative + "/")));
    else {
      assert(entry.isFile(), "A package must contain only files/directories");
      const bytes = await fs.readFile(file);
      records.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return records;
}
const stagedFiles = await packageFiles(stage.stage);
const work = await fs.mkdtemp(path.join(root, ".qa/native-browser-"));
const schema = JSON.parse(
  await fs.readFile(
    new URL(
      "../../../services/jobs-radar/jobs_radar/profile.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const profile = {
  ...Object.fromEntries(
    schema.required.map((key) => [
      key,
      schema.properties[key].type === "array" ? [] : {},
    ]),
  ),
  profileName: "Intern",
  nameData: { firstName: "Synthetic", lastName: "Applicant" },
  addressData: { country: "United States" },
};
const profileId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  jobId = "1".repeat(24),
  site = new URL(
    JSON.parse(
      await fs.readFile(
        new URL(
          "../../../services/jobs-radar/config/brand.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).website,
  ).origin,
  custom = "https://custom-careers.example",
  ats = "https://jobs.ashbyhq.com/fixture/role/application";
const evidence = {
  build: stage.buildId,
  stage: stage.stage,
  packageFiles: stagedFiles,
  network: "HTTPS mocked and public DNS disabled",
  checks: [],
  pageErrors: [],
};
const options = {
  channel: "chromium",
  headless: true,
  executablePath: process.argv[3],
  args: [
    `--disable-extensions-except=${stage.stage}`,
    `--load-extension=${stage.stage}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
  ],
};
let context = await chromium.launchPersistentContext(
  path.join(work, "profile"),
  options,
);
context.on("page", (page) =>
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message)),
);
try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    let body =
      "<!doctype html><title>Unrelated fixture</title><h1>Unrelated page</h1>";
    if (url.origin === site)
      body = `<!doctype html><h1>Fixture board</h1><a data-jobs-id="${jobId}" data-jobs-kind="intern" href="${custom}/job/1">申请</a>`;
    else if (url.origin === custom)
      body = `<!doctype html><head data-ph-id="fixture"><title>Fixture job</title></head><body><h1>Fixture role</h1><iframe src="${ats}"></iframe></body>`;
    else if (url.origin === new URL(ats).origin)
      body =
        '<!doctype html><h1>Fixture role</h1><form aria-labelledby="job-application-form"><div class="ashby-application-form-section-container"><label>First name<input name="firstName" required></label><label>Optional preference<textarea></textarea></label><button type="button">Submit application</button></div></form>';
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  context.setDefaultTimeout(15000);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(
    async ({ profile, profileId, jobId, custom, ats }) => {
      globalThis.fixtureRequests = [];
      globalThis.fetch = async (url, init = {}) => {
        const pathname = new URL(url).pathname,
          body = init.body ? JSON.parse(init.body) : undefined;
        fixtureRequests.push({
          pathname,
          body,
          protocol: init.headers?.["X-Jobs-Protocol"],
        });
        if (
          globalThis.fixtureRecoveryPause &&
          pathname.startsWith("/api/extension/")
        )
          return Response.json(
            { code: "recovery_application_pause" },
            { status: 503 },
          );
        let value = {};
        if (pathname === "/api/extension/resolve")
          value = {
            state: "matched",
            job_id: jobId,
            job_ids: [jobId],
            kinds: ["intern"],
            title: "Fixture role",
            company: "Fixture company",
            application: null,
            queue: { version: 1, allowed: true },
          };
        else if (pathname === "/api/extension/profiles")
          value = [{ id: profileId, profileName: "Intern", last_sync: "v1" }];
        else if (pathname.startsWith("/api/extension/profiles/"))
          value = {
            id: profileId,
            profile,
            last_sync: "v1",
            schema_version: 1,
          };
        else if (pathname === "/api/extension/control")
          value = { enabled: true, commands: [], snapshotRequests: [] };
        else if (pathname === "/api/extension/diagnostics")
          value = { historyAccepted: true };
        else if (pathname === "/api/extension/job-title")
          value = { ok: true, changed: true, job_id: jobId };
        else if (pathname === "/api/manage/state")
          value = {
            jobsKindProfiles: { value: { intern: profileId }, revision: 1 },
            settings: {
              value: {
                autofillSettings: {
                  autoSubmit: false,
                  autoClickNextPage: false,
                },
              },
              revision: 1,
            },
          };
        else if (pathname.includes("answer"))
          throw Error("Unexpected AI request in deterministic integration");
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      await chrome.storage.local.set({
        jobsSyncV1: {
          deviceId: "fixture",
          token: "x".repeat(64),
          profileToken: "y".repeat(64),
          outbox: [],
          connected: true,
        },
        jobsKindProfiles: { intern: profileId },
        settings: {
          autofillSettings: { autoSubmit: false, autoClickNextPage: false },
        },
      });
    },
    { profile, profileId, jobId, custom, ats },
  );
  const board = await context.newPage();
  await board.goto(site + "/");
  await board.getByRole("link", { name: "申请", exact: true }).waitFor();
  assert.equal(await board.locator("[data-jobs-queue]").count(), 0);
  evidence.checks.push(
    "Native job links remain ordinary links without injected queue controls",
  );
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/queue.html`);
  const added = await ui.evaluate(
    ({ jobId, custom }) =>
      chrome.runtime.sendMessage({
        type: "jobs:queue",
        action: "add",
        args: { jobId, url: custom + "/job/1" },
      }),
    { jobId, custom },
  );
  assert(!added.error, added.error);
  await ui.reload();
  await ui
    .getByText("Fixture company · Fixture role", { exact: true })
    .waitFor();
  evidence.checks.push("Packaged queue UI reads the real durable worker state");
  const app = await context.newPage();
  await app.goto(custom + "/job/1");
  const frame =
    app.frames().find((frame) => frame.url() === ats) ||
    (await new Promise((resolve) =>
      app.on("framenavigated", (frame) => {
        if (frame.url() === ats) resolve(frame);
      }),
    ));
  await frame.getByLabel("First name", { exact: true }).waitFor();
  await frame.waitForFunction(
    () =>
      document.querySelector('input[name="firstName"]').value === "Synthetic",
    null,
    { timeout: 15000 },
  );
  const tabId = await worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    custom + "/job/1",
  );
  const pageState = await worker.evaluate(
    async (tabId) =>
      chrome.tabs.sendMessage(
        tabId,
        { type: "jobs:document-check" },
        { frameId: 0 },
      ),
    tabId,
  );
  assert.equal(pageState.active, true);
  evidence.checks.push(
    "An explicitly registered custom domain activates from framework markers; its real ATS iframe fills the bound synthetic Profile",
  );
  const requests = await worker.evaluate(() => fixtureRequests);
  assert(
    requests.some(
      (row) => row.pathname === "/api/extension/profiles/" + profileId,
    ),
  );
  assert(requests.every((row) => !row.body || row.protocol === "2"));
  assert(!requests.some((row) => row.pathname === "/api/extension/events"));
  evidence.checks.push(
    "Versioned REST Profile read and protocol header are used; no submission event was sent",
  );
  const titles = await worker.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (
      !fixtureRequests.some(
        (row) => row.pathname === "/api/extension/job-title",
      )
    ) {
      if (Date.now() >= deadline) throw Error("Adapter title was not reported");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return fixtureRequests.filter(
      (row) => row.pathname === "/api/extension/job-title",
    );
  });
  assert(
    titles.some(
      (row) => row.body.url === ats && row.body.title === "Fixture role",
    ),
  );
  assert(
    titles.every(
      (row) =>
        row.protocol === "2" && row.body.title_source === "existing_adapter",
    ),
  );
  assert(
    !(await worker.evaluate(() => fixtureRequests)).some(
      (row) => row.pathname === "/api/extension/events",
    ),
  );
  evidence.checks.push(
    "Existing Ashby title reaches the authenticated board transport from its actual iframe before any submission",
  );
  const unrelated = await context.newPage();
  await unrelated.goto("https://unrelated.example/");
  assert.equal(await unrelated.locator('[data-jobs-ui="status"]').count(), 0);
  evidence.checks.push(
    "Unregistered unrelated pages receive no injected application status",
  );
  const inspect = await worker.evaluate(async (tabId) => {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    return frames.map((row) => ({ frameId: row.frameId, url: row.result }));
  }, tabId);
  const frameId = inspect.find((row) => row.url === ats).frameId;
  const snapshot = await worker.evaluate(
    async ({ tabId, frameId }) =>
      chrome.tabs.sendMessage(
        tabId,
        { type: "jobs:control-inspect" },
        { frameId },
      ),
    { tabId, frameId },
  );
  assert.equal(snapshot.data.ats, "ashby");
  assert(snapshot.data.fields.some((field) => field.question === "First name"));
  evidence.checks.push(
    "Supported remote inspection returns the actual frame snapshot and canonical fields",
  );
  await ui.screenshot({ path: path.join(work, "queue.png"), fullPage: true });
  await app.screenshot({
    path: path.join(work, "application.png"),
    fullPage: true,
  });
  const activeCache = await worker.evaluate(() =>
    chrome.storage.session.get(null),
  );
  assert.equal(activeCache.jobsProfilesCache, undefined);
  assert(activeCache["profile_" + tabId]?.profile);
  const recovery = await worker.evaluate(
    async ({ tabId, frameId }) => {
      const state = (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1;
      state.outbox = [
        {
          payload: {
            event_id: "synthetic-held-receipt",
            proof: "submit_attempt",
          },
          attempts: 0,
          next: Date.now() + 600000,
        },
      ];
      const guards = { synthetic: { state: "unknown" } };
      await chrome.storage.local.set({
        jobsSyncV1: state,
        jobsSubmissionGuardsV1: guards,
      });
      globalThis.fixtureRecoveryPause = true;
      const call = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () =>
          chrome.runtime.sendMessage({
            type: "jobs:tab-profile",
            verify: true,
          }),
      });
      const frames = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => location.href,
      });
      const states = await Promise.all(
        frames.map((frame) =>
          chrome.tabs.sendMessage(
            tabId,
            { type: "jobs:document-check" },
            { frameId: frame.frameId },
          ),
        ),
      );
      const after = await chrome.storage.local.get([
        "jobsSyncV1",
        "jobsSubmissionGuardsV1",
      ]);
      globalThis.fixtureRecoveryPause = false;
      return {
        rejected: !!call[0].result.error,
        states,
        outbox: after.jobsSyncV1.outbox,
        guards: after.jobsSubmissionGuardsV1,
        profilePresent: !!(
          await chrome.storage.session.get("profile_" + tabId)
        )["profile_" + tabId],
      };
    },
    { tabId, frameId },
  );
  assert.equal(recovery.rejected, true);
  assert(recovery.states.every((state) => state.active === false));
  assert.equal(recovery.profilePresent, false);
  assert.equal(recovery.outbox[0].payload.event_id, "synthetic-held-receipt");
  assert.equal(recovery.guards.synthetic.state, "unknown");
  assert.equal(
    await frame.getByLabel("First name", { exact: true }).inputValue(),
    "Synthetic",
  );
  evidence.checks.push(
    "Explicit service recovery pause stops every live application frame and releases its Profile while preserving field values, pending receipts and uncertain submission guards",
  );
  await app.close();
  await worker.evaluate(async (tabId) => {
    for (let n = 0; n < 100; n++) {
      const state = await chrome.storage.session.get(null);
      if (
        !state["profile_" + tabId] &&
        !Object.keys(state).some((key) => key.startsWith("jobsResponses:"))
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error("Closing the application retained private facts");
  }, tabId);
  evidence.checks.push(
    "Closing the last application releases its full Profile and acknowledged answers; no global full-Profile cache exists",
  );

  const second = await context.newPage();
  await second.goto(custom + "/job/1");
  await second
    .frameLocator("iframe")
    .getByLabel("First name", { exact: true })
    .waitFor();
  const secondFrame = second.frames().find((frame) => frame.url() === ats);
  await secondFrame.waitForFunction(
    () =>
      document.querySelector('input[name="firstName"]').value === "Synthetic",
  );
  const secondTabId = await worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    custom + "/job/1",
  );
  await board.evaluate(() => {
    window.fixtureStatus = null;
    window.addEventListener("message", (event) => {
      if (event.data?.type === "jobs:extension-status")
        window.fixtureStatus = event.data;
    });
    window.postMessage({ type: "jobs:extension-disconnect" }, location.origin);
  });
  await board.waitForFunction(() => window.fixtureStatus?.disabled === true);
  const disconnected = await worker.evaluate(async (tabId) => {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    const states = await Promise.all(
      frames.map((frame) =>
        chrome.tabs.sendMessage(
          tabId,
          { type: "jobs:document-check" },
          { frameId: frame.frameId },
        ),
      ),
    );
    return {
      states,
      session: await chrome.storage.session.get(null),
      sync: (await chrome.storage.local.get("jobsSyncV1")).jobsSyncV1,
    };
  }, secondTabId);
  assert(disconnected.states.every((state) => state.active === false));
  assert.equal(disconnected.sync.disabled, true);
  assert(
    !Object.keys(disconnected.session).some((key) =>
      /^(?:profile_|jobsResponses:)/.test(key),
    ),
  );
  assert.equal(disconnected.session.jobsDiagnosticsV1, undefined);
  assert.equal(
    await secondFrame.getByLabel("First name", { exact: true }).inputValue(),
    "Synthetic",
  );
  evidence.checks.push(
    "Real site-bridge disconnect stops every application frame and releases private session data while preserving values on the form",
  );
  await second.close();
  // Simulate an installed older version only in this disposable synthetic
  // browser. The candidate must keep these values and stop before Profile fetch.
  const beforeUpgrade = await worker.evaluate(async () => {
    await chrome.storage.local.set({
      jobsSyncV1: {
        deviceId: "fixture",
        token: "x".repeat(64),
        profileToken: "y".repeat(64),
        outbox: [],
        disabled: false,
      },
      profile: { profileName: "Synthetic legacy facts" },
      jobsProfilePending: {
        body: { profile: { profileName: "Synthetic unsynced edit" } },
      },
    });
    return fixtureRequests.filter((row) =>
      row.pathname.startsWith("/api/extension/profiles"),
    ).length;
  });
  const blocked = await context.newPage();
  await blocked.goto(custom + "/job/blocked-upgrade");
  await blocked
    .frameLocator("iframe")
    .getByLabel("First name", { exact: true })
    .waitFor();
  const blockedTabId = await worker.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url).id,
    custom + "/job/blocked-upgrade",
  );
  const blockedReply = await worker.evaluate(async (tabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => chrome.runtime.sendMessage({ type: "getAutofillConfig" }),
    });
    return results.map((row) => row.result);
  }, blockedTabId);
  assert(blockedReply.every((reply) => /受控迁移/.test(reply.error)));
  assert.equal(
    await blocked
      .frameLocator("iframe")
      .getByLabel("First name", { exact: true })
      .inputValue(),
    "",
  );
  const upgradeState = await worker.evaluate(async () => ({
    local: await chrome.storage.local.get(["profile", "jobsProfilePending"]),
    profileReads: fixtureRequests.filter((row) =>
      row.pathname.startsWith("/api/extension/profiles"),
    ).length,
  }));
  assert.equal(
    upgradeState.local.profile.profileName,
    "Synthetic legacy facts",
  );
  assert.equal(
    upgradeState.local.jobsProfilePending.body.profile.profileName,
    "Synthetic unsynced edit",
  );
  assert.equal(upgradeState.profileReads, beforeUpgrade);
  evidence.checks.push(
    "Synthetic installed legacy facts and unsynced edits remain intact; every application frame refuses autofill before any Profile HTTP read",
  );
  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(await packageFiles(stage.stage), stagedFiles);
  evidence.packageUnchanged = true;
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = error.stack;
  evidence.worker = await context.serviceWorkers()[0].evaluate(async () => ({
    requests: fixtureRequests,
    state: await chrome.storage.session.get(null),
  }));
  evidence.pages = await Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      text: (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 3000),
    })),
  );
  throw error;
} finally {
  await fs.writeFile(
    path.join(work, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await context.close();
  console.log(JSON.stringify({ artifact: work, ...evidence }, null, 2));
}
