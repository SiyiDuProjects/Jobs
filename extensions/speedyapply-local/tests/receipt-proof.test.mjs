import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { installPageLifecycle } from "./helpers/page-lifecycle.mjs";

const read = (path) =>
  readModule(new URL("../" + path, import.meta.url), "utf8");
const [platform, wait, domControls, sync, matchRules, match] =
  await Promise.all(
    [
      "src/custom/platform-config.js",
      "src/custom/dom-wait.js",
      "source/content/shared/dom-controls.js",
      "src/custom/sync.js",
      "src/custom/job-match-rules.js",
      "src/custom/job-match.js",
    ].map(read),
  );
const adapters = new Map(
  await Promise.all(
    ["polymer", "indeed", "workday"].map(async (name) => [
      name,
      await read("source/content/adapters/" + name + ".js"),
    ]),
  ),
);
const tabModules = await Promise.all(
  ["src/custom/management-model.js", "src/custom/tab-profiles.js"].map(read),
);

function page(t, html, url = "https://jobs.polymer.co/acme/123/application") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" }),
    w = dom.window;
  installPageLifecycle(w);
  t.after(() => w.close());
  w.eval(platform);
  w.eval(wait);
  w.eval(domControls);
  return w;
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

const markers = {
  adp: '<div id="vdlContainerFluid"><div class="success-message-container">Application submitted</div></div>',
  ashby: "<h2>Success! Your application was received.</h2>",
  bamboohr: "<p>Your application has been submitted.</p>",
  comeet: "<p>Your application has been submitted.</p>",
  dayforce: '<div test-id="success-dayforce-jobs">Application sent</div>',
  dover: "<div>Thanks for applying!</div>",
  eightfold: '<h2 id="form-submission-success-message">Application sent</h2>',
  freshteam: '<div id="applicant-success">Application sent</div>',
  gusto: "<ol><li></li><li></li><li><span>Thank you</span></li></ol>",
  icims:
    '<div class="iCIMS_SuccessMessage">Your application has been submitted</div>',
  jobvite: '<div class="jv-page-applyconfirm">Application sent</div>',
  lever: '<div class="thanks">Thank you for applying</div>',
  paylocity:
    '<div id="appSubmitResponseDiv">Your application has been successfully submitted.</div>',
  pinpoint: "<p>Your application was received successfully.</p>",
  polymer: "<h2>Your application has been sent!</h2>",
  seek: '<div id="applicationSent">Application sent</div>',
  smartrecruiters:
    "<oc-success-page-content>Application sent</oc-success-page-content>",
  successfactors: '<div id="applyConfirmMsg">Application sent</div>',
  tesla: '<div class="Confirmation_message">Application sent</div>',
  ultipro: '<div id="ApplicationSubmitted">Application sent</div>',
  workable: '<div data-ui="successful-submit">Application sent</div>',
};
test("every declared ATS receipt requires its visible confirmation, not a hidden success template", (t) => {
  const w = page(t, "");
  for (const [name, html] of Object.entries(markers)) {
    w.document.body.innerHTML = "<div hidden>" + html + "</div>";
    assert.equal(
      w.JobsPlatformConfig.confirmation(w.document, name),
      null,
      name + " hidden",
    );
    w.document.body.firstElementChild.hidden = false;
    assert(
      w.JobsPlatformConfig.confirmation(w.document, name),
      name + " visible",
    );
    w.document.body.firstElementChild.style.display = "none";
    assert.equal(
      w.JobsPlatformConfig.confirmation(w.document, name),
      null,
      name + " display:none",
    );
  }
  for (const [name, html] of [
    ["bamboohr", "<a>See all job openings</a>"],
    [
      "paylocity",
      '<div id="appSubmitResponseDiv">Unable to submit your application. Please try again.</div>',
    ],
  ]) {
    w.document.body.innerHTML = html;
    assert.equal(
      w.JobsPlatformConfig.confirmation(w.document, name),
      null,
      name + " is not success",
    );
  }
});

test("Polymer records one confirmed application only after its real hidden receipt becomes visible", async (t) => {
  const w = page(
      t,
      '<h1 class="title">Engineer</h1><section hidden>' +
        markers.polymer +
        "</section>",
    ),
    records = [];
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = async (value) => records.push(value);
  w.eval(adapters.get("polymer"));
  await w.polymerTrackApplication(() => {});
  await turn();
  assert.equal(records.length, 0);
  w.document.querySelector("section").hidden = false;
  await turn();
  assert.equal(records.length, 1);
  assert.equal(records[0].jobsSyncProof, "ats_confirmation");
  w.document.querySelector("section").append(" ");
  await turn();
  assert.equal(records.length, 1);
});

test("Indeed Review only captures job identity; the later post-apply route records one confirmation", async (t) => {
  const w = page(
    t,
    '<div class="ia-JobHeader"><h1>Engineer</h1><span>Acme - Remote</span></div><script>{"jk":"abc123"}</script>',
    "https://smartapply.indeed.com/beta/indeedapply/form/review",
  );
  const records = [];
  let onLocation;
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = async (value) => records.push(value);
  w.eval(adapters.get("indeed"));
  await w.indeedRunApplication({
    setMessage() {},
    getProfile: async () => ({}),
    autofillSettings: { saveApplications: true },
    ctx: {
      addEventListener(_target, _name, fn) {
        onLocation = fn;
      },
    },
  });
  assert.equal(records.length, 0);
  await onLocation({
    newUrl: new URL(
      "https://smartapply.indeed.com/beta/indeedapply/form/review",
    ),
  });
  assert.equal(records.length, 0);
  await onLocation({
    newUrl: new URL(
      "https://smartapply.indeed.com/beta/indeedapply/post-apply",
    ),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].jobsSyncProof, "ats_confirmation");
  await onLocation({
    newUrl: new URL(
      "https://smartapply.indeed.com/beta/indeedapply/post-apply",
    ),
  });
  assert.equal(records.length, 1);
});

test("the Workday Review submit click is an attempt, never an ATS confirmation", async (t) => {
  const w = page(
    t,
    '<h3>Engineer</h3><section data-automation-id="applyFlowReviewPage"></section><button data-automation-id="pageFooterNextButton">Submit</button>',
    "https://example.myworkdayjobs.com/en-US/careers/job/Engineer_123/apply",
  );
  const records = [];
  w.jobsReportJobTitle = async () => false;
  w.jobsSaveApplicationRecord = async (value) => records.push(value);
  w.eval(adapters.get("workday"));
  await w.workdayTrackReviewSubmitClick();
  assert.equal(records.length, 0);
  w.document.querySelector("button").click();
  assert.equal(records.length, 1);
  assert.equal(records[0].jobsSyncProof, "submit_attempt");
});

function background(session = {}) {
  const storage = { jobsSyncV1: { outbox: [] } },
    noop = { addListener() {} };
  const chrome = {
    runtime: {
      id: "fixture",
      onMessage: noop,
      onInstalled: noop,
      onStartup: noop,
    },
    storage: {
      local: {
        get: async () => storage,
        set: async (data) => Object.assign(storage, data),
      },
      session: {
        getKeys: async () => Object.keys(session),
        get: async (keys) =>
          structuredClone(
            keys === null
              ? session
              : Object.fromEntries(
                  [keys].flat().map((key) => [key, session[key]]),
                ),
          ),
        set: async (data) => Object.assign(session, structuredClone(data)),
        remove: async (keys) => {
          for (const key of [keys].flat()) delete session[key];
        },
      },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      onCreated: noop,
      onUpdated: noop,
      onRemoved: noop,
    },
    alarms: { create() {}, onAlarm: noop },
  };
  const ctx = vm.createContext({
    // This suite isolates its contract; storage-upgrade.test covers the actual gate.
    JobsStorageUpgrade: { assertReady: async () => {}, peek: () => null },
    JobsManagementSync: { forProfile: async () => ({ ok: true }) },
    chrome,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    AbortSignal,
    Date,
    console,
  });
  vm.runInContext(matchRules + "\n" + match + "\n" + sync, ctx);
  return { api: ctx.JobsSync, match: ctx.JobsJobMatch, storage, ctx };
}
test("refreshing the bound Profile version preserves the original job digest needed by its receipt", async () => {
  const session = {},
    h = background(session);
  tabModules.forEach((source) => vm.runInContext(source, h.ctx));
  const record = {
    id: "fixture",
    profile: { profileName: "Fixture" },
    last_sync: "2026-09-26T01:00:00Z",
  };
  await h.ctx.JobsTabProfiles.bind(
    7,
    record,
    "a".repeat(24),
    "resolved",
    "https://www.indeed.com/viewjob?jk=abc123",
  );
  const original = session["jobsTabBinding:7"].jobKey;
  await h.ctx.JobsTabProfiles.bind(
    7,
    { ...record, last_sync: "2026-09-26T02:00:00Z" },
    "a".repeat(24),
    "resolved",
  );
  assert.equal(session["jobsTabBinding:7"].jobKey, original);
  assert.equal(session.profile_7.lastSync, "2026-09-26T02:00:00Z");
  await h.ctx.JobsTabProfiles.bind(7, record, "b".repeat(24), "resolved");
  assert.equal(
    session["jobsTabBinding:7"].jobKey,
    undefined,
    "another job cannot inherit the digest",
  );
});
test("Indeed cross-host confirmation needs the original server-resolved binding and matching job identity", async () => {
  const url = "https://www.indeed.com/viewjob?jk=abc123",
    source = "https://smartapply.indeed.com/beta/indeedapply/post-apply";
  const key = background().match.key(url),
    bytes = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
  const binding = {
    websiteJobId: "a".repeat(24),
    jobKey: "job:" + Buffer.from(bytes).toString("hex"),
  };
  for (const [label, metadata, sourceUrl, jobUrl, expected] of [
    ["matched", binding, source, url, "ats_confirmation"],
    ["unbound", null, source, url, "tracker_record"],
    [
      "different job",
      binding,
      source,
      "https://www.indeed.com/viewjob?jk=other",
      "tracker_record",
    ],
    [
      "unresolved",
      { ...binding, websiteJobId: null },
      source,
      url,
      "tracker_record",
    ],
    [
      "Review",
      binding,
      source.replace("post-apply", "form/review"),
      url,
      "tracker_record",
    ],
    [
      "other host",
      binding,
      "https://unrelated.example/post-apply",
      url,
      "tracker_record",
    ],
  ]) {
    const h = background({ "jobsTabBinding:7": metadata });
    await h.api.record(
      { status: "applied", jobLink: jobUrl, jobTitle: "Engineer" },
      { url: sourceUrl, tabId: 7, proof: "ats_confirmation" },
    );
    assert.equal(h.storage.jobsSyncV1.outbox[0].payload.proof, expected, label);
  }
});
