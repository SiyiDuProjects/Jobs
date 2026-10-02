import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";

const source = await Promise.all(
  [
    "src/custom/job-match-rules.js",
    "src/custom/job-match.js",
    "src/custom/platform-config.js",
    "source/content/adapters/greenhouse.js",
  ].map((file) => readModule(new URL("../" + file, import.meta.url), "utf8")),
);
const job = "https://job-boards.greenhouse.io/fixture/jobs/123";
function page(
  t,
  { url = job, applied = true, confirmed = false, record = true } = {},
) {
  const dom = new JSDOM(
    "<!doctype html><title>Thank you for applying</title>",
    { url, runScripts: "outside-only" },
  );
  const w = dom.window,
    saved = [],
    phases = [],
    events = new Map(),
    queries = [];
  t.after(() => w.close());
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        queries.push(message);
        return { data: { applied, confirmed } };
      },
    },
  };
  source.forEach((code) => w.eval(code));
  w.jobsSaveApplicationRecord = async (value) => {
    saved.push(structuredClone(value));
    return { ok: true };
  };
  w.jobsWaitForCssNodes = () => new Promise(() => {});
  const ctx = {
    isInvalid: false,
    addEventListener(_target, event, fn) {
      events.set(event, fn);
    },
  };
  const run = () =>
    w.greenhouseRunApplication({
      ctx,
      setMessage: (value) => phases.push(value),
      autofillSettings: { saveApplications: record },
      getProfile: () => {
        throw Error("Receipt must not read Profile");
      },
    });
  return { w, dom, saved, phases, queries, events, ctx, run };
}

test("Greenhouse confirms the same job on SPA redirect once without filling or replacing its title", async (t) => {
  const h = page(t);
  await h.run();
  assert.equal(h.saved.length, 0);
  h.dom.reconfigure({ url: job + "/confirmation" });
  await Promise.all([
    h.events.get("jobs:locationchange")(),
    h.events.get("focus")(),
  ]);
  assert.deepEqual(h.saved, [
    { jobLink: job, jobTitle: "", jobsSyncProof: "ats_confirmation" },
  ]);
  assert.equal(h.phases.at(-1), "confirmed");
  await h.events.get("focus")();
  assert.equal(h.saved.length, 1);
});

test("a directly loaded receipt after an existing attempt confirms without waiting for a form", async (t) => {
  const h = page(t, { url: job + "/confirmation" });
  await h.run();
  assert.equal(h.saved.length, 1);
  assert.equal(h.queries[0].url, job);
});

for (const options of [
  { applied: false },
  { confirmed: true },
  { record: false },
])
  test(
    "receipt does not create or duplicate an attempt: " +
      JSON.stringify(options),
    async (t) => {
      const h = page(t, { url: job + "/confirmation", ...options });
      await h.run();
      assert.equal(h.saved.length, 0);
    },
  );

test("Greenhouse ignores other jobs, hosts and non-receipt paths", async (t) => {
  const h = page(t);
  await h.run();
  for (const url of [
    job + "/review",
    job + "/confirmation/other",
    job.replace("123", "456") + "/confirmation",
    "https://example.test/fixture/jobs/123/confirmation",
  ]) {
    h.dom.reconfigure({ url });
    await h.events.get("jobs:locationchange")();
  }
  assert.equal(h.saved.length, 0);
  assert.equal(h.queries.length, 0);
});

for (const mode of ["rejected", "missing-ack"])
  test("Greenhouse receipt remains retryable after " + mode, async (t) => {
    const h = page(t, { url: job + "/confirmation" });
    let attempts = 0;
    h.w.jobsSaveApplicationRecord = async () => {
      attempts++;
      if (attempts === 1) {
        if (mode === "rejected") throw Error("Synthetic transport error");
        return {};
      }
      return { ok: true };
    };
    await h.run();
    assert.equal(h.phases.at(-1), "complete-manually");
    await h.events.get("online")();
    assert.equal(h.phases.at(-1), "confirmed");
    await h.events.get("focus")();
    assert.equal(attempts, 2);
  });

test("navigation during receipt identity lookup never confirms the replacement document", async (t) => {
  const h = page(t, { url: job + "/confirmation" });
  h.w.chrome.runtime.sendMessage = async () => {
    h.dom.reconfigure({ url: job.replace("123", "456") + "/confirmation" });
    return { data: { applied: true } };
  };
  await h.run();
  assert.equal(h.saved.length, 0);
});
