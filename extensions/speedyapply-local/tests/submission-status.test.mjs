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
const read = (path) =>
  readModule(new URL("../" + path, import.meta.url), "utf8");
const [shell, config, content, worker, workday] = await Promise.all([
  read("source/content/shell.js"),
  read("src/custom/platform-config.js"),
  read("src/custom/applied-status.js"),
  read("source/applied-status-background.js"),
  read("source/content/adapters/workday.js"),
]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert(check());
}
const posting =
  "https://fixture.wd5.myworkdayjobs.com/en-US/Careers/job/City/Engineer_R123";
const home = "https://fixture.wd5.myworkdayjobs.com/en-US/Careers/userHome";

test("a new receipt document restores this tab's pending outcome without a posting URL", async () => {
  const source = await read("source/background-api.js");
  const session = { "jobsTabSubmit:4": { jobUrl: posting, at: Date.now() } };
  const context = vm.createContext({
    URL,
    Date,
    JobsJobMatch,
    JobsTabProfiles: {},
    JobsSync: { resolveJob: async () => null },
    JobsPrivateSession: { epoch: 1 },
    chrome: {
      runtime: {
        id: "jobs",
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
      },
      storage: {
        session: { get: async (key) => ({ [key]: session[key] }) },
        local: { get: async () => ({}) },
      },
    },
  });
  vm.runInContext(source, context);
  const status = (url, tabId = 4) =>
    context.handle(
      { type: "jobs:application-status", url },
      { id: "jobs", url, frameId: 0, tab: { id: tabId } },
    );
  assert.equal((await status(home)).applied, true);
  assert.equal((await status(home)).confirmed, false);
  assert.equal(
    (await status(home, 5)).applied,
    false,
    "a second tab cannot borrow the first tab's attempt",
  );
  assert.equal(
    (await status(home.replace("fixture.", "other."))).applied,
    false,
  );
  assert.equal((await status(posting.replace("R123", "R456"))).applied, false);
  session["jobsTabSubmit:4"].confirmed = true;
  assert.equal((await status(home)).confirmed, true);
  session["jobsTabSubmit:4"].at = Date.now() - 31 * 60000;
  assert.equal((await status(home)).applied, false);
});

function presenter(t) {
  const w = new JSDOM("<body/>", {
    url: posting,
    runScripts: "outside-only",
  }).window;
  t.after(() => w.close());
  const sent = [],
    listeners = [];
  w.chrome = {
    runtime: {
      id: "fixture",
      sendMessage: async (message) => {
        sent.push(message);
      },
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener() {},
      },
    },
  };
  w.eval(shell);
  const present = w.statusPresenter({ onInvalidated() {} });
  const statuses = () =>
    sent.filter((message) => message.type === "jobs:panel-status");
  return {
    w,
    present,
    statuses,
    refresh: () =>
      listeners.forEach((fn) =>
        fn({ type: "jobs:status-refresh" }, { id: "fixture" }, () => {}),
      ),
  };
}

test("a worker refresh cannot carry the previous posting's result to a new SPA posting", async (t) => {
  const h = presenter(t);
  h.w.JobsJobMatch = JobsJobMatch;
  await h.present("confirmed");
  h.w.history.replaceState({}, "", posting.replace("R123", "R456"));
  h.refresh();
  await tick();
  assert.notEqual(h.statuses().at(-1).phase, "confirmed");
});

test("a submitted page keeps its outcome when the adapter closes its status", async (t) => {
  const { present, statuses } = presenter(t);
  present("in-progress");
  present("submitting");
  // Adapters close the status surface (null) when the form disappears.
  present(null);
  present("idle");
  await tick();
  assert.deepEqual(
    statuses().map((message) => [message.text, message.phase]),
    [
      ["正在填写", "in-progress"],
      ["已尝试提交，等待网站确认", "submitting"],
      ["已尝试提交，等待网站确认", "submitting"],
      ["已尝试提交，等待网站确认", "submitting"],
    ],
  );
  present("confirmed");
  present(null);
  await tick();
  assert.equal(statuses().at(-1).text, "网站已确认，投递完成");
  assert.equal(statuses().at(-1).phase, "confirmed");
  // A late run notification cannot erase an observed receipt.
  present("in-progress");
  await tick();
  assert.equal(statuses().at(-1).phase, "confirmed");
});

test("submission outcomes cannot regress, and reset only for another posting", async (t) => {
  const { w, present, statuses } = presenter(t);
  w.JobsJobMatch = JobsJobMatch;
  await present("confirmed");
  for (const phase of [
    "preparing",
    "submitting",
    "ai-review",
    "page-complete",
    "旧请求失败",
    null,
  ]) {
    await present(phase);
    assert.equal(statuses().at(-1).phase, "confirmed", String(phase));
    assert.equal(statuses().at(-1).canFill, false);
  }
  w.history.replaceState({}, "", home);
  await present("idle");
  assert.equal(statuses().at(-1).phase, "confirmed");
  w.history.replaceState({}, "", posting.replace("R123", "R456"));
  await present("in-progress");
  assert.equal(statuses().at(-1).phase, "in-progress");
});

test("an unsubmitted page reports idle and labels every adapter phase", async (t) => {
  const { present, statuses } = presenter(t);
  present(null);
  present("ready-submit");
  present("stopped-user_input");
  present("自定义提示");
  await tick();
  assert.deepEqual(
    statuses().map((message) => [message.text, message.phase]),
    [
      ["已识别页面，等待申请表单", "idle"],
      ["已填好，请检查后提交", "ready-submit"],
      ["填写已停止：检测到手动操作", "stopped-user_input"],
      ["自定义提示", "message"],
    ],
  );
});

test("an SPA URL change re-announces the current status for the new URL", async (t) => {
  const { w, present, statuses } = presenter(t);
  present("submitting");
  await tick();
  const before = statuses().length;
  w.dispatchEvent(new w.Event("jobs:locationchange"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(statuses().length, before + 1);
  assert.equal(statuses().at(-1).text, "已尝试提交，等待网站确认");
});

function receiptPage(t, html, respond) {
  const w = new JSDOM(html, { url: home, runScripts: "outside-only" }).window;
  t.after(() => {
    w.dispatchEvent(new w.PageTransitionEvent("pagehide"));
    w.close();
  });
  const sent = [],
    messages = [];
  let confirmations = 0;
  w.JobsJobMatch = JobsJobMatch;
  w.JobsDiagnostics = { note() {} };
  w.JobsAutomatic = { cancel() {} };
  w.JobsPageSession = {
    root: () => w.document.body,
    confirmed: () => confirmations++,
  };
  w.chrome = {
    runtime: {
      id: "jobs",
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        sent.push(message);
        return respond(message);
      },
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  };
  w.eval(config);
  w.eval(content);
  w.JobsAppliedStatus.attach((message) => messages.push(message));
  return { w, sent, messages, confirmations: () => confirmations };
}

test("Workday's Application Submitted dialog over Candidate Home is reported once and confirms the page", async (t) => {
  const h = receiptPage(
    t,
    '<main><section data-automation-id="candidateHomePage"></section></main>',
    async () => ({ data: { ok: true, state: "pending" } }),
  );
  h.w.document
    .querySelector("main")
    .insertAdjacentHTML(
      "beforeend",
      '<div role="dialog" aria-modal="true"><h2>Application Submitted</h2><button>Done</button></div>',
    );
  await until(() => h.confirmations() === 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "jobs:submitted-notice-observed");
  assert.equal(h.sent[0].quote, "Application Submitted");
  assert.equal(h.sent[0].url, home);
  h.w.dispatchEvent(new h.w.Event("focus"));
  await tick();
  assert.equal(h.sent.length, 1);
});

test("an unattributed receipt is shown without confirming the page", async (t) => {
  const h = receiptPage(
    t,
    '<div role="dialog"><h2>Application Submitted</h2></div>',
    async () => ({ data: { ok: true, state: "unattributed" } }),
  );
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0], /没有可对应的提交记录/);
  assert.equal(h.confirmations(), 0);
});

test("hidden, long, negative and non-heading receipt wording is not a receipt", async (t) => {
  for (const html of [
    '<div role="dialog" hidden><h2>Application Submitted</h2></div>',
    '<div style="display:none"><h2>Application Submitted</h2></div>',
    "<p>Application Submitted</p>",
    "<h2>Your application was not submitted.</h2>",
    "<h2>Application Submitted for another candidate on our partner site today</h2>",
    '<div data-automation-id="jobPostingDescription"><h2>Application Submitted</h2></div>',
    "<main><h2>Application Submitted</h2></main>",
  ]) {
    const h = receiptPage(t, html, async () => ({
      data: { ok: true, state: "pending" },
    }));
    await tick();
    assert.equal(h.sent.length, 0, html);
  }
});

test("a receipt observed before its attempt is saved is retried after session changes", async (t) => {
  let ready = false;
  const h = receiptPage(
    t,
    '<div role="dialog"><h2>Application Submitted</h2></div>',
    async () => ({
      data: { ok: true, state: ready ? "pending" : "unattributed" },
    }),
  );
  await until(() => h.messages.length === 1);
  ready = true;
  h.w.dispatchEvent(new h.w.Event("focus"));
  await until(() => h.confirmations() === 1);
});

test("a receipt reply for the previous SPA location never confirms the new page", async (t) => {
  let reply;
  const h = receiptPage(
    t,
    '<div role="dialog"><h2>Application Submitted</h2></div>',
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  await until(() => reply);
  h.w.history.replaceState({}, "", posting.replace("R123", "R456"));
  h.w.document.body.innerHTML = "<h1>Another job</h1>";
  reply({ data: { ok: true, state: "pending" } });
  await tick();
  assert.equal(h.confirmations(), 0);
});

function background({
  attempt,
  live = { url: home, quote: "Application Submitted" },
  onRecord = async () => {},
} = {}) {
  const session = attempt ? { "jobsTabSubmit:4": attempt } : {},
    writes = [];
  const context = vm.createContext({
    URL,
    JobsJobMatch,
    publicJobUrl,
    chrome: {
      storage: {
        session: {
          get: async (key) => ({ [key]: session[key] }),
          set: async (data) => Object.assign(session, data),
          remove: async (key) => delete session[key],
        },
      },
      tabs: {
        sendMessage: async (_tab, message, target) => {
          assert.equal(message.type, "jobs:submitted-notice-check");
          assert.equal(target.documentId, "home-doc");
          return live;
        },
      },
    },
    JobsSync: {
      record: async (...args) => {
        writes.push(args);
        await onRecord();
      },
    },
  });
  vm.runInContext(worker, context);
  const sender = {
    documentId: "home-doc",
    frameId: 0,
    tab: { id: 4 },
    url: home,
  };
  return {
    writes,
    session,
    run: (change = {}) =>
      context.recordSubmittedNotice(
        { url: home, quote: "Application Submitted" },
        { ...sender, ...change },
      ),
  };
}

test("a delayed receipt cannot replace or confirm a newer attempt in the same tab", async () => {
  let release;
  const h = background({
    attempt: { jobUrl: posting, at: Date.now(), id: "first" },
    onRecord: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const result = h.run();
  await until(() => release);
  h.session["jobsTabSubmit:4"] = {
    jobUrl: posting.replace("R123", "R456"),
    at: Date.now(),
    id: "second",
  };
  release();
  assert.equal((await result).state, "unattributed");
  assert.equal(h.session["jobsTabSubmit:4"].id, "second");
  assert.equal(h.session["jobsTabSubmit:4"].confirmed, undefined);
  assert.equal(h.writes[0][0].jobLink, posting);
});

test("the worker attributes a receipt only to this tab's recent attempt on the same site", async () => {
  const h = background({ attempt: { jobUrl: posting, at: Date.now() } });
  assert.equal((await h.run()).state, "pending");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0].jobLink, posting);
  assert.equal(h.writes[0][0].jobTitle, "");
  assert.equal(h.writes[0][1].proof, "ats_confirmation");
  assert.equal(h.writes[0][1].tabId, 4);
  assert.equal(h.session["jobsTabSubmit:4"].confirmed, true);
  assert.equal((await h.run()).state, "confirmed");
  assert.equal(h.writes.length, 1, "a repeated dialog is not a second receipt");

  for (const attempt of [
    undefined,
    { jobUrl: posting, at: Date.now() - 31 * 60 * 1000 },
    { jobUrl: posting, at: Date.now() + 60000 },
    { jobUrl: posting, at: null },
    {
      jobUrl: "https://fixture.wd5.myworkdayjobs.com/en-US/Careers/userHome",
      at: Date.now(),
    },
    {
      jobUrl: "https://other.wd1.myworkdayjobs.com/x/job/A_R1",
      at: Date.now(),
    },
  ]) {
    const other = background({ attempt });
    assert.equal((await other.run()).state, "unattributed");
    assert.equal(other.writes.length, 0);
  }
  const changed = background({
    attempt: { jobUrl: posting, at: Date.now() },
    live: null,
  });
  await assert.rejects(changed.run(), /changed/);
  assert.equal(changed.writes.length, 0);
  await assert.rejects(
    background({ attempt: { jobUrl: posting, at: Date.now() } }).run({
      frameId: 1,
    }),
    /current document/,
  );
});

test("the Workday Review submit listener survives a re-rendered footer and reads the posting at click time", async (t) => {
  const w = new JSDOM(
    '<h3>Engineer</h3><section data-automation-id="applyFlowReviewPage"></section><footer><button data-automation-id="pageFooterNextButton">Submit</button></footer>',
    { url: posting + "/apply/applyManually", runScripts: "outside-only" },
  ).window;
  t.after(() => w.close());
  const records = [];
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = async (value) => records.push(value);
  w.eval(config);
  w.eval(workday);
  await w.workdayTrackReviewSubmitClick();
  await w.workdayTrackReviewSubmitClick();
  w.document.querySelector("footer").innerHTML =
    '<button data-automation-id="pageFooterNextButton">Submit</button>';
  w.document.querySelector("button").click();
  assert.equal(records.length, 1, "one listener per document");
  assert.equal(records[0].jobsSyncProof, "submit_attempt");
  assert.equal(records[0].jobLink, posting);
  w.document.querySelector("section").remove();
  w.document.querySelector("button").click();
  assert.equal(records.length, 1, "only the Review step's Submit counts");
});
