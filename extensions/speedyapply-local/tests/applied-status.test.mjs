import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { initializeJobMatchRules } from "../src/custom/job-match-rules.js";
import { initializeJobMatch, JobsJobMatch } from "../src/custom/job-match.js";
import { publicJobUrl } from "../src/custom/public-job-url.js";
initializeJobMatchRules();
initializeJobMatch();
const config = await readModule(
  new URL("../src/custom/platform-config.js", import.meta.url),
  "utf8",
);
const content = await readModule(
  new URL("../src/custom/applied-status.js", import.meta.url),
  "utf8",
);
const worker = await readModule(
  new URL("../source/applied-status-background.js", import.meta.url),
  "utf8",
);
const url =
  "https://fixture.wd5.myworkdayjobs.com/en-US/Careers/job/Test/Engineer_01879030";
const quote = "You already applied to this job.";
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check) {
  for (let i = 0; i < 80 && !check(); i++) await tick();
  assert(check());
}
function page(
  t,
  html,
  href = url,
  respond = async () => ({ data: { ok: true, state: "confirmed" } }),
) {
  const w = new JSDOM(html, { url: href, runScripts: "outside-only" }).window;
  t.after(() => {
    w.dispatchEvent(new w.PageTransitionEvent("pagehide"));
    w.close();
  });
  const sent = [],
    events = [],
    messages = [],
    listeners = new Set();
  let confirmations = 0;
  w.JobsJobMatch = JobsJobMatch;
  w.JobsDiagnostics = { note: (...args) => events.push(args) };
  w.JobsAutomatic = { cancel: () => {} };
  w.JobsPageSession = {
    root: () => w.document.body,
    confirmed: () => confirmations++,
  };
  w.chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener() {} },
      sendMessage: async (m) => {
        sent.push(m);
        return respond(m);
      },
    },
    storage: {
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
  };
  w.eval(config);
  w.eval(content);
  w.JobsAppliedStatus.attach((m) => messages.push(m));
  return {
    w,
    sent,
    events,
    messages,
    confirmations: () => confirmations,
    change: () => listeners.forEach((fn) => fn({ jobsSyncV1: {} }, "local")),
  };
}
test("already-applied Review error and initial posting badge backfill without clicking or needing a prior attempt", async (t) => {
  for (const html of [
    `<main><ol><li><b>Error - Page Error</b><p>${quote}</p></li></ol><button>Submit</button></main>`,
    `<main><ol><li><b>Error - Page Error</b><div>${quote}</div></li></ol></main>`,
    '<h1 data-automation-id="jobPostingHeader">Engineer</h1><button disabled>Applied</button>',
    "<p>You have already applied for this position.</p>",
  ]) {
    const h = page(t, html);
    let clicks = 0;
    h.w.document.addEventListener("click", () => clicks++);
    await until(() => h.confirmations() === 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, "jobs:applied-status-observed");
    h.w.dispatchEvent(new h.w.Event("focus"));
    await tick();
    assert.equal(h.sent.length, 1);
    assert.equal(clicks, 0);
  }
});
test("hidden messages, listing descriptions, recommendations, ambiguous badges and non-postings do not mark applied", async (t) => {
  for (const html of [
    `<p hidden>${quote}</p>`,
    `<div style="opacity:0"><p>${quote}</p></div>`,
    `<div data-automation-id="jobPostingDescription"><p>${quote}</p></div>`,
    `<article><p>${quote}</p></article>`,
    "<button>Applied</button>",
    "<p>Applied</p>",
    "<p>If you already applied to this job, sign in.</p>",
    "<p>Your application was not submitted.</p>",
  ]) {
    const h = page(t, html);
    await tick();
    assert.equal(h.sent.length, 0, html);
  }
  for (const href of [
    "https://example.test/job/Engineer_01879030",
    "https://fixture.wd5.myworkdayjobs.com/en-US/Careers/login",
  ]) {
    const h = page(t, `<p>${quote}</p>`, href);
    await tick();
    assert.equal(h.sent.length, 0);
  }
});
test("late message is observed, failed delivery retries on focus, and pending delivery becomes synced on storage acknowledgement", async (t) => {
  let attempts = 0;
  const h = page(t, "<main></main>", url, async () => {
    attempts++;
    if (attempts === 1) throw Error("offline");
    return {
      data: { ok: true, state: attempts === 2 ? "pending" : "confirmed" },
    };
  });
  h.w.document.querySelector("main").innerHTML = `<p>${quote}</p>`;
  await until(() => h.messages.at(-1)?.includes("尚未确认"));
  h.w.dispatchEvent(new h.w.Event("focus"));
  await until(() => h.messages.at(-1)?.includes("等待同步"));
  h.change();
  await until(() => h.messages.at(-1)?.includes("后台已同步"));
  assert.equal(attempts, 3);
});
test("navigation during asynchronous response does not confirm a replacement posting", async (t) => {
  let resolve;
  const h = page(
    t,
    `<p>${quote}</p>`,
    url,
    () => new Promise((r) => (resolve = r)),
  );
  h.w.history.replaceState({}, "", url.replace("01879030", "01879031"));
  resolve({ data: { ok: true, state: "confirmed" } });
  await tick();
  assert.equal(h.confirmations(), 0);
});
function background({
  disabled = false,
  resolved = { state: "matched" },
  replace = false,
} = {}) {
  const writes = [];
  let verifies = 0;
  const context = vm.createContext({
    URL,
    JobsJobMatch,
    publicJobUrl,
    chrome: {
      storage: {
        local: {
          get: async () => ({
            settings: { autofillSettings: { saveApplications: !disabled } },
          }),
        },
      },
      tabs: {
        sendMessage: async (_tab, _msg, target) => {
          assert.equal(target.documentId, "doc");
          verifies++;
          return {
            url:
              replace && verifies === 2
                ? url.replace("01879030", "01879031")
                : url,
            quote,
          };
        },
      },
    },
    JobsSync: {
      resolveJob: async () => resolved,
      record: async (...args) => writes.push(args),
    },
  });
  vm.runInContext(worker, context);
  const sender = { documentId: "doc", frameId: 0, tab: { id: 1 }, url };
  return {
    writes,
    run: (change = {}) =>
      context.recordAppliedStatus({ url, quote }, { ...sender, ...change }),
  };
}
test("background verifies the live document and uses durable ATS receipt transport without new personal metadata", async () => {
  const h = background();
  assert.equal((await h.run()).state, "pending");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0].jobLink, url);
  assert.equal(h.writes[0][1].proof, "ats_confirmation");
  assert.equal(h.writes[0][0].profileName, undefined);
  for (const options of [
    { disabled: true },
    { resolved: { state: "unmatched" } },
    { resolved: { state: "matched", application: { confirmed: true } } },
  ]) {
    const h = background(options);
    await h.run();
    assert.equal(h.writes.length, 0);
  }
  const changed = background({ replace: true });
  await assert.rejects(changed.run(), /changed/);
  assert.equal(changed.writes.length, 0);
  await assert.rejects(background().run({ frameId: 2 }), /current posting/);
  await assert.rejects(
    background().run({ url: url.replace("01879030", "01879031") }),
    /current posting/,
  );
  await assert.rejects(background({ resolved: null }).run(), /unavailable/);
});
