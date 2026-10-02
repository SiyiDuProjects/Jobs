import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readModule } from "./helpers/module-source.mjs";

const sources = await Promise.all(
  [
    "../src/custom/job-match-rules.js",
    "../src/custom/job-match.js",
    "../source/job-title-background.js",
  ].map((file) => readModule(new URL(file, import.meta.url), "utf8")),
);
const url =
  "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application";
function fixture(options = {}) {
  const sent = [],
    targets = [];
  const context = vm.createContext({
    URL,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { id: "jobs" },
      tabs: {
        get: async () => ({ url: options.tabUrl || url }),
        sendMessage: async (id, message, target) => {
          targets.push({ id, message, target });
          if (options.gone) throw Error("Document gone");
          return {
            active: options.active !== false,
            url: options.liveUrl || url,
          };
        },
      },
      storage: {
        session: {
          get: async (key) => {
            assert.equal(key, "jobsTabBinding:7");
            options.afterBinding?.();
            return { [key]: { websiteJobId: "a".repeat(24) } };
          },
        },
      },
    },
    JobsSync: {
      reportJobTitle: async (url, title, hint, verify) => {
        options.beforeSend?.();
        if (verify) hint = await verify();
        sent.push([url, title, hint]);
        return { ok: true, changed: true };
      },
    },
  });
  for (const source of sources) vm.runInContext(source, context);
  const sender = {
    id: "jobs",
    tab: { id: 7 },
    documentId: "current-doc",
    frameId: 0,
    url,
  };
  return {
    sent,
    targets,
    sender,
    report: (message = {}, source = sender) =>
      context.reportJobTitle(
        {
          url,
          title: "  Software Engineer  ",
          ...message,
        },
        source,
      ),
  };
}

test("adapter title reaches the board with the current document and existing website binding, without Profile access", async () => {
  const h = fixture();
  assert.equal((await h.report()).ok, true);
  assert.deepEqual(Array.from(h.sent[0]), [
    url,
    "Software Engineer",
    "a".repeat(24),
  ]);
  assert.equal(h.targets[0].target.documentId, "current-doc");
});
test("posting metadata can report before an adapter starts or when autofill is disabled", async () => {
  const h = fixture({ active: false });
  assert.equal((await h.report()).ok, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.targets[0].target.documentId, "current-doc");
});

test("a stale document or navigation never updates a title", async () => {
  for (const options of [
    { gone: true },
    { liveUrl: url + "?changed=1" },
    { tabUrl: "https://example.test/other" },
  ]) {
    const h = fixture(options);
    await assert.rejects(h.report());
    assert.equal(h.sent.length, 0);
  }
});
test("foreign senders and absent documents cannot report titles", async () => {
  for (const patch of [
    { id: "foreign" },
    { documentId: undefined },
    { tab: undefined },
  ]) {
    const h = fixture();
    await assert.rejects(h.report({}, { ...h.sender, ...patch }));
    assert.equal(h.sent.length, 0);
  }
});
test("empty, oversized and wrong-page titles cannot be sent", async () => {
  for (const message of [
    { title: "Engineer\u0000invalid" },
    { title: " " },
    { title: "x".repeat(501) },
    { title: null },
    {
      url: "https://jobs.ashbyhq.com/other/00000000-0000-4000-8000-000000000002",
    },
    { url: "http://example.test/job" },
  ]) {
    const h = fixture();
    await assert.rejects(h.report(message));
    assert.equal(h.sent.length, 0);
  }
});
test("DOM layout whitespace is normalized without changing the adapter's title", async () => {
  const h = fixture();
  await h.report({ title: "Software\n  Engineer\tIntern" });
  assert.equal(h.sent[0][1], "Software Engineer Intern");
});
test("an iframe title is tied to its exact document, not the parent page's title", async () => {
  const h = fixture({ tabUrl: "https://example.test/careers" });
  assert.equal((await h.report({}, { ...h.sender, frameId: 3 })).ok, true);
  assert.equal(h.sent[0][0], url);
});

test("navigation while reading binding metadata discards the old title", async () => {
  const options = {
    afterBinding() {
      options.liveUrl = url + "?different-step=1";
      options.tabUrl = options.liveUrl;
    },
  };
  const h = fixture(options);
  await assert.rejects(h.report(), /changed/);
  assert.equal(h.sent.length, 0);
});

test("navigation while waiting for the sync queue discards the old title, including iframe documents", async () => {
  for (const frameId of [0, 3]) {
    const options = {
      beforeSend() {
        options.gone = true;
      },
    };
    const h = fixture(options);
    await assert.rejects(h.report({}, { ...h.sender, frameId }), /gone/i);
    assert.equal(h.sent.length, 0);
  }
});
