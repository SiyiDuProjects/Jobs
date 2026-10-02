// Synthetic installed-upgrade exercise. Never uses the user's Chrome profile,
// private connection file, real API, or published dist.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildPackage } from "./build.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(process.argv[2] || "playwright-core");
const root = path.resolve(import.meta.dirname, ".."),
  candidate = await buildPackage();
const work = await fs.mkdtemp(path.join(root, ".qa/migration-browser-")),
  installed = path.join(work, "installed");
await fs.mkdir(installed);
const manifest = JSON.parse(
  await fs.readFile(path.join(candidate.stage, "manifest.json"), "utf8"),
);
await fs.writeFile(
  path.join(installed, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Synthetic previous jobs",
    version: "2.0.0",
    key: manifest.key,
    permissions: ["storage", "unlimitedStorage"],
    host_permissions: ["https://*/*"],
    background: { service_worker: "previous.js" },
  }),
);
await fs.writeFile(
  path.join(installed, "previous.js"),
  "chrome.runtime.onMessage.addListener(()=>{});",
);
const options = {
  channel: "chromium",
  executablePath: process.argv[3],
  headless: true,
  args: [
    `--disable-extensions-except=${installed}`,
    `--load-extension=${installed}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
  ],
};
const evidence = {
  build: candidate.buildId,
  network:
    "All HTTPS denied; worker fetch replaced with synthetic endpoint responses",
  checks: [],
  errors: [],
};
const profileId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  key = "jobsResponses:" + profileId;
const seed = {
  profile: {
    profileName: "Synthetic old profile",
    applicationData: { aiNotes: "Synthetic old fact" },
  },
  [key]: [
    { question: "Synthetic question", response: "Unsent synthetic answer" },
  ],
  settings: {
    autofillSettings: { autoSubmit: false },
    premiumSettings: { responseContext: "Synthetic old context", unrelated: 7 },
  },
  jobsProfileMigration: { id: profileId, complete: true },
  jobsSyncV1: {
    deviceId: "synthetic-device",
    token: "a".repeat(64),
    profileToken: "b".repeat(64),
    outbox: [
      {
        id: "keep-receipt",
        next: 4102444800000,
        payload: { event_id: "keep-event", proof: "submit_attempt" },
      },
    ],
  },
  jobsSubmissionGuardsV1: { synthetic: { state: "uncertain" } },
  autofillAccount: { accountPassword: "SYNTHETIC-NEVER-UPLOAD" },
};
let context = await chromium.launchPersistentContext(
  path.join(work, "profile"),
  options,
);
try {
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(async (value) => chrome.storage.local.set(value), seed);
  await context.close();
  await fs.cp(candidate.stage, installed, { recursive: true });
  context = await chromium.launchPersistentContext(
    path.join(work, "profile"),
    options,
  );
  await context.route("**/*", (route) =>
    /^https?:/.test(route.request().url())
      ? route.abort("blockedbyclient")
      : route.continue(),
  );
  context.setDefaultTimeout(15000);
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  assert.equal(worker.url().split("/")[2], extensionId);
  await worker.evaluate(() => {
    const prefix = "/api/extension/storage-migrations";
    globalThis.fixture = {
      online: false,
      calls: [],
      session: null,
      manifest: null,
      uploads: {},
      conflict: true,
      previewed: false,
    };
    const copy = (value) => structuredClone(value);
    const plan = () => ({
      migrationId: fixture.session.migrationId,
      manifestHash: fixture.session.manifestHash,
      revision: 1,
      phase: fixture.conflict ? "required_input" : "ready_to_apply",
      conflicts: fixture.conflict
        ? [
            {
              id: "fact",
              title: "合成资料有差异",
              detail: "先查看完整来源与当前内容",
              choices: [
                { id: "source:0", label: "使用旧来源", requiresPreview: true },
                {
                  id: "preserve",
                  label: "保留当前内容和旧备份",
                  requiresPreview: false,
                },
              ],
            },
          ]
        : [],
      operations: [],
    });
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url),
        pathname = parsed.pathname;
      if (!pathname.startsWith(prefix))
        return new Response(
          JSON.stringify({ error: "Synthetic unrelated API disabled" }),
          { status: 503 },
        );
      const body = options.body ? JSON.parse(options.body) : undefined;
      fixture.calls.push({ path: pathname, body });
      if (!fixture.online) throw Error("Synthetic offline");
      if (pathname === prefix) {
        const incoming = JSON.parse(body.manifestText);
        if (!fixture.session) {
          fixture.manifest = incoming;
          fixture.session = {
            migrationId: incoming.migrationId,
            deviceId: "synthetic-device",
            clientBuild: incoming.clientBuild,
            manifestHash: body.manifestHash,
            phase: "receiving",
            uploaded: [],
            cleaned: [],
            planRevision: 1,
          };
        }
        return Response.json(copy(fixture.session));
      }
      const suffix = pathname.slice(
        (prefix + "/" + fixture.session.migrationId).length,
      );
      if (!suffix) return Response.json(copy(fixture.session));
      if (suffix.startsWith("/entries/")) {
        const entryId = suffix.split("/").at(-1);
        fixture.uploads[entryId] = body;
        fixture.session.uploaded.push(entryId);
        return Response.json({
          migrationId: fixture.session.migrationId,
          entryId,
          size: body.size,
          sha256: body.sha256,
          stored: true,
        });
      }
      if (suffix === "/seal") {
        fixture.session.phase = "required_input";
        fixture.session.backup = {
          backupId: "synthetic-backup",
          migrationId: fixture.session.migrationId,
          deviceId: "synthetic-device",
          manifestHash: fixture.session.manifestHash,
          serverManifestHash: "c".repeat(64),
          durable: true,
          restoreVerified: true,
          entries: fixture.manifest.entries.map(
            ({ entryId, size, sha256 }) => ({ entryId, size, sha256 }),
          ),
          serverEntries: [],
        };
      } else if (suffix === "/plan") return Response.json(plan());
      else if (suffix === "/conflicts/fact/preview") {
        if (parsed.searchParams.get("choiceId") !== "source:0")
          throw Error("Unexpected choice");
        fixture.previewed = true;
        return Response.json({
          planRevision: 1,
          conflictId: "fact",
          choiceId: "source:0",
          rows: [
            {
              path: "/applicationData/aiNotes",
              type: "value",
              source: "Synthetic old fact",
              current: "Synthetic current fact",
            },
          ],
          complete: true,
          previewId: "synthetic-preview",
        });
      } else if (suffix === "/resolve") {
        if (
          body.choiceId !== "preserve" &&
          (!fixture.previewed || body.previewId !== "synthetic-preview")
        )
          throw Error("Missing complete preview");
        fixture.conflict = false;
        fixture.session.phase = "ready_to_apply";
        return Response.json(plan());
      } else if (suffix === "/apply") {
        if (fixture.conflict) throw Error("Unresolved conflict");
        fixture.session.phase = "applying";
      } else if (suffix === "/verify") fixture.session.phase = "ready_to_clean";
      else if (suffix === "/cleanup-claim") {
        const entry = fixture.manifest.entries.find(
          (value) => value.entryId === body.entryId,
        );
        return Response.json({
          ...copy(fixture.session),
          permitId: "permit-" + entry.entryId,
          backupId: "synthetic-backup",
          entryId: entry.entryId,
          selector: entry.selector,
          sha256: entry.sha256,
          disposition: entry.disposition,
          observedState: body.observedState,
          expiresAt: Date.now() + 60000,
          ...(entry.pointer
            ? { containerBeforeSha256: body.containerBeforeSha256 }
            : {}),
        });
      } else if (suffix === "/cleanup-ack") {
        fixture.session.cleaned.push(body.entryId);
        fixture.session.phase = "cleaning";
      } else if (suffix === "/complete") fixture.session.phase = "complete";
      else throw Error("Unexpected synthetic migration route");
      return Response.json(copy(fixture.session));
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/migration.html`);
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("尚未开始"),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: "jobs:storage-upgrade-status" }),
      )
    ).data.state,
    "needs_migration",
  );
  assert.equal(
    await worker.evaluate(
      async () =>
        (await chrome.storage.local.get("profile")).profile.profileName,
    ),
    seed.profile.profileName,
  );
  evidence.checks.push(
    "Previous installed local values survive package replacement and old complete flag does not migrate them",
  );
  const other = await context.newPage();
  await other.goto(`chrome-extension://${extensionId}/migration.html`);
  await page.getByRole("button", { name: "备份并核对旧资料" }).click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("关闭其他"),
  );
  assert.equal(await worker.evaluate(() => fixture.calls.length), 0);
  await other.close();
  await context.route("https://migration-fixture.invalid/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Synthetic page</title>",
    }),
  );
  const contentPage = await context.newPage();
  await contentPage.goto("https://migration-fixture.invalid/");
  const contentTabId = await worker.evaluate(
    async () =>
      (
        await chrome.tabs.query({ url: "https://migration-fixture.invalid/*" })
      )[0].id,
  );
  const access = await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          try {
            await chrome.storage.local.get("profile");
            return { denied: false };
          } catch {
            return { denied: true };
          }
        },
      }),
    contentTabId,
  );
  assert.equal(access[0].result.denied, true);
  await contentPage.close();
  evidence.checks.push(
    "Actual isolated content-script context cannot access legacy local facts after quiescence restriction",
  );
  await page.reload();
  await page.getByRole("button", { name: "继续上次迁移" }).click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("暂时未能完成"),
  );
  assert.ok(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("profile")).profile,
    ),
  );
  evidence.checks.push(
    "Unknown trusted view blocks source capture; interrupted maintenance and offline upload preserve all source values",
  );
  await worker.evaluate(() => {
    fixture.online = true;
  });
  await page.getByRole("button", { name: "继续上次迁移" }).click();
  await page.waitForSelector("article select");
  await page.locator("article select").selectOption("source:0");
  assert.equal(
    await page.getByRole("button", { name: "确认这一项" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "查看差异" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("article")
      .textContent.includes("Synthetic current fact"),
  );
  await page.screenshot({
    path: path.join(work, "private-difference.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认这一项" }).click();
  await page.getByRole("button", { name: "保存已确认的差异" }).click();
  await page
    .getByRole("button", { name: "核验后清理旧缓存" })
    .waitFor({ state: "visible" });
  assert.ok(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("profile")).profile,
    ),
  );
  await page.screenshot({
    path: path.join(work, "ready-to-clean.png"),
    fullPage: true,
  });
  evidence.checks.push(
    "Private page shows actual current/source difference, requires complete preview, and retains old source until domain verification",
  );
  await page.getByRole("button", { name: "核验后清理旧缓存" }).click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("迁移已核验完成"),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        chrome.runtime.sendMessage({ type: "jobs:storage-upgrade-status" }),
      )
    ).data.state,
    "ready",
  );
  const result = await worker.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    calls: fixture.calls,
  }));
  assert.equal(result.local.profile, undefined);
  assert.equal(result.local[key], undefined);
  assert.deepEqual(result.local.settings, {
    autofillSettings: { autoSubmit: false },
    premiumSettings: { unrelated: 7 },
  });
  assert.deepEqual(result.local.jobsSyncV1.outbox, seed.jobsSyncV1.outbox);
  assert.deepEqual(
    result.local.jobsSubmissionGuardsV1,
    seed.jobsSubmissionGuardsV1,
  );
  assert.deepEqual(result.local.autofillAccount, seed.autofillAccount);
  assert.ok(!JSON.stringify(result.calls).includes("SYNTHETIC-NEVER-UPLOAD"));
  assert.ok(
    !JSON.stringify(result.local.jobsStorageMigrationV1).includes(
      "Synthetic old fact",
    ),
  );
  assert.ok(
    !JSON.stringify(result.local.jobsStorageMigrationV1).includes(
      "Unsent synthetic answer",
    ),
  );
  evidence.checks.push(
    "Only proved legacy keys/context path removed; receipt outbox, uncertain submission guards, account settings and identity survive; journal contains no synthetic facts",
  );
  await page.screenshot({
    path: path.join(work, "complete.png"),
    fullPage: true,
  });
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
} catch (error) {
  evidence.errors.push(error.message);
  evidence.lastStatus = await Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      status: await page
        .locator("#status")
        .textContent({ timeout: 1000 })
        .catch(() => ""),
    })),
  );
  const activeWorker = context.serviceWorkers()[0];
  if (activeWorker)
    evidence.worker = await activeWorker
      .evaluate(() => ({
        phase: globalThis.fixture?.session?.phase,
        paths: globalThis.fixture?.calls?.map((value) => value.path),
      }))
      .catch(() => null);
  throw error;
} finally {
  await context.close();
  await fs.writeFile(
    path.join(work, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      work,
      build: candidate.buildId,
      checks: evidence.checks.length,
      passed: !!evidence.passed,
    }),
  );
}
