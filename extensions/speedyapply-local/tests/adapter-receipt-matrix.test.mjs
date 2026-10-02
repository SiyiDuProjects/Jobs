import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";
import { installPageLifecycle } from "./helpers/page-lifecycle.mjs";

// The fixture loads complete maintained adapter functions and the actual DOM
// receipt waiters. Filling is outside this receipt boundary and is not mocked
// into a successful submission. All pages and job identities are synthetic.
const read = (name) =>
  readModule(new URL("../" + name, import.meta.url), "utf8");
const common = await Promise.all(
  [
    "src/custom/platform-config.js",
    "src/custom/dom-wait.js",
    "source/content/shared/dom-controls.js",
    "source/content/shared/response-capture.js",
  ].map(read),
);
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function flush() {
  await turn();
  await turn();
}

const domReceipts = [
  [
    "adp",
    '<div id="vdlContainerFluid"><div class="success-message-container">Application submitted</div></div>',
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=fixture&jobId=123",
  ],
  [
    "ashby",
    "<h2>Success! Your application was received.</h2>",
    "https://jobs.ashbyhq.com/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application",
    "track",
  ],
  [
    "bamboohr",
    "<p>Your application has been submitted.</p>",
    "https://fixture.bamboohr.com/careers/123",
    "run",
    '<button type="button"><span>View Job Description</span></button>',
  ],
  [
    "comeet",
    "<p>Your application has been submitted.</p>",
    "https://www.comeet.com/jobs/fixture/123/engineer/456",
    "track",
    '<script>POSITION_DATA = {"position_uid":"456","name":"Engineer","company_name":"Fixture","careers_page_url":"https://www.comeet.com/jobs/fixture/123/engineer/456"}</script>',
  ],
  [
    "dayforce",
    '<div test-id="success-dayforce-jobs">Application sent</div>',
    "https://jobs.dayforcehcm.com/en-US/fixture/jobs/123/apply",
  ],
  [
    "dover",
    "<div>Thanks for applying!</div>",
    "https://app.dover.com/apply/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    "track",
  ],
  [
    "eightfold",
    '<h2 id="form-submission-success-message">Application sent</h2>',
    "https://fixture.eightfold.ai/careers?pid=123",
    "track",
  ],
  [
    "freshteam",
    '<div id="applicant-success">Application sent</div>',
    "https://fixture.freshteam.com/jobs/123/engineer",
    "track",
  ],
  [
    "gusto",
    "<ol><li></li><li></li><li><span>Thank you</span></li></ol>",
    "https://jobs.gusto.com/postings/fixture-engineer-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  ],
  [
    "icims",
    '<div class="iCIMS_SuccessMessage">Your application has been submitted</div>',
    "https://careers-fixture.icims.com/jobs/123/engineer/job",
  ],
  [
    "jobvite",
    '<div class="jv-page-applyconfirm">Application sent</div>',
    "https://jobs.jobvite.com/fixture/job/123/apply",
  ],
  [
    "lever",
    '<div class="thanks">Thank you for applying</div>',
    "https://jobs.lever.co/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/apply",
  ],
  [
    "paylocity",
    '<div id="appSubmitResponseDiv">Your application has been successfully submitted.</div>',
    "https://recruiting.paylocity.com/Recruiting/Jobs/Apply/123",
  ],
  [
    "pinpoint",
    "<p>Your application was received successfully.</p>",
    "https://fixture.pinpointhq.com/en/postings/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/applications/new",
    "route",
  ],
  [
    "polymer",
    "<h2>Your application has been sent!</h2>",
    "https://jobs.polymer.co/fixture/123/application",
    "track",
  ],
  [
    "seek",
    '<div id="applicationSent">Application sent</div>',
    "https://www.seek.com.au/job/123/apply",
    "track",
  ],
  [
    "smartrecruiters",
    "<oc-success-page-content>Application sent</oc-success-page-content>",
    "https://jobs.smartrecruiters.com/Fixture/123-engineer",
  ],
  [
    "successfactors",
    '<div id="applyConfirmMsg">Application sent</div>',
    "https://career4.successfactors.com/career?company=fixture&career_job_req_id=123",
    "track",
  ],
  [
    "tesla",
    '<div class="Confirmation_message">Application sent</div>',
    "https://www.tesla.com/careers/search/job/123/apply",
  ],
  [
    "ultipro",
    '<div id="ApplicationSubmitted">Application sent</div>',
    "https://recruiting.ultipro.com/FIX1000/JobBoard/aaaaaaaa/OpportunityDetail?opportunityId=123",
  ],
  [
    "workable",
    '<div data-ui="successful-submit">Application sent</div>',
    "https://apply.workable.com/fixture/j/ABC123/",
    "track",
  ],
];
const remaining = [
  "indeed",
  "rippling",
  "tiktok",
  "breezy",
  "greenhouse",
  "jazzhr",
  "phenom",
  "workday",
  "oracle",
];
const source = new Map(
  await Promise.all(
    [...domReceipts.map(([site]) => site), ...remaining].map(async (site) => [
      site,
      await read("source/content/adapters/" + site + ".js"),
    ]),
  ),
);

function page(t, site, url, html = "") {
  const dom = new JSDOM(
    '<!doctype html><title>Engineer at Fixture</title><body><h1>Engineer</h1><button id="review" type="button">Review</button><input id="invalid" required>' +
      html,
    { url, runScripts: "outside-only" },
  );
  const w = dom.window,
    records = [],
    advances = [],
    events = new Map();
  installPageLifecycle(w);
  t.after(() => w.close());
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  Object.assign(w, {
    jobsReportJobTitle: async () => false,
    jobsSaveApplicationRecord: async (value) => {
      records.push(value);
      return { ok: true };
    },
    jobsMountManualAnswerControls: async () => {},
    JobsPageSession: { root: () => w.document.body, setAutofill() {} },
    JobsFormPipeline: { settled: async () => true },
    JobsAutomatic: {
      advance: async (options) => {
        advances.push(options);
        return false;
      },
    },
    JobsDiagnostics: { note() {}, perform: (_kind, _target, run) => run() },
  });
  common.forEach((code) => w.eval(code));
  w.eval(source.get(site));
  const input = {
    setMessage() {},
    getProfile: async () => ({}),
    autofillSettings: {
      saveApplications: true,
      autoSubmit: false,
      autoClickNextPage: false,
    },
    accountSettings: {},
    ctx: {
      addEventListener(_target, type, fn) {
        events.set(type, fn);
      },
    },
  };
  return { w, records, advances, input, events };
}

for (const [site, url, html, confirmation, mode] of [
  [
    "indeed",
    "https://smartapply.indeed.com/beta/indeedapply/form/review",
    '<div class="ia-JobHeader"><h1>Engineer</h1><span>Fixture - Remote</span></div><script>{"jk":"fixture123"}</script>',
    "https://smartapply.indeed.com/beta/indeedapply/post-apply",
    "run",
  ],
  [
    "rippling",
    "https://ats.rippling.com/fixture/jobs/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application?step=review",
    '<form><div data-testid="field"></div></form>',
    "https://ats.rippling.com/fixture/jobs/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application?step=confirmation",
    "run",
  ],
  [
    "tiktok",
    "https://careers.tiktok.com/resume/123/apply",
    '<div class="resumeEditForm-headerText">Engineer</div>',
    "https://careers.tiktok.com/resume/applied",
    "track",
  ],
]) {
  test(`${site}: real route observer does not confirm Review and handles repeated confirmation once`, async (t) => {
    const h = page(t, site, url, html);
    if (mode === "track") h.w.tiktokTrackApplication(h.input);
    else await h.w[site + "RunApplication"](h.input);
    await flush();
    const route = h.events.get("jobs:locationchange");
    assert.equal(typeof route, "function");
    h.w.document.querySelector("#review").click();
    h.w.document
      .querySelector("#invalid")
      .dispatchEvent(new h.w.Event("invalid", { bubbles: true }));
    await route({ newUrl: new h.w.URL(url) });
    await flush();
    assert.equal(h.records.length, 0);
    h.w.history.replaceState({}, "", confirmation);
    await route({ newUrl: new h.w.URL(confirmation) });
    await flush();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].jobsSyncProof, "ats_confirmation");
    await route({ newUrl: new h.w.URL(confirmation) });
    await flush();
    assert.equal(
      h.records.length,
      1,
      "Repeated observations of one receipt cannot create duplicate records",
    );
  });
}

for (const [site, url, html, confirmation] of [
  [
    "rippling",
    "https://ats.rippling.com/fixture/jobs/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application?step=review",
    '<form><div data-testid="field"></div></form>',
    "https://ats.rippling.com/fixture/jobs/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application?step=confirmation",
  ],
  [
    "tiktok",
    "https://careers.tiktok.com/resume/123/apply",
    '<div class="resumeEditForm-headerText">Engineer</div>',
    "https://careers.tiktok.com/resume/applied",
  ],
]) {
  for (const failure of ["rejected", "missing-ack"]) {
    test(`${site}: concurrent receipt observations share one save; ${failure} remains retryable`, async (t) => {
      const h = page(t, site, url, html);
      const saves = [];
      h.w.jobsSaveApplicationRecord = () =>
        new Promise((resolve, reject) => saves.push({ resolve, reject }));
      if (site === "tiktok") h.w.tiktokTrackApplication(h.input);
      else await h.w.ripplingRunApplication(h.input);
      await flush();
      const route = h.events.get("jobs:locationchange");
      h.w.history.replaceState({}, "", confirmation);
      const event = { newUrl: new h.w.URL(confirmation) };
      const first = route(event),
        duplicate = route(event);
      await flush();
      assert.equal(saves.length, 1, "one in-flight save per receipt");
      if (failure === "rejected") saves[0].reject(Error("synthetic lost ACK"));
      else saves[0].resolve({});
      await Promise.all([first, duplicate]);
      const retry = route(event);
      await flush();
      assert.equal(
        saves.length,
        2,
        "no ACK must not permanently suppress the receipt",
      );
      saves[1].resolve({ ok: true });
      await retry;
      await route(event);
      assert.equal(saves.length, 2, "an acknowledged receipt is recorded once");
    });
  }
}

for (const [site, url, html, submit] of [
  [
    "breezy",
    "https://fixture.breezy.hr/p/abc123-engineer",
    '<button type="button" ng-click="apply()" id="submit">Submit Application</button>',
    "#submit",
  ],
  [
    "greenhouse",
    "https://job-boards.greenhouse.io/fixture/jobs/123",
    '<div class="application--submit"><button type="submit" id="submit">Submit Application</button></div>',
    "#submit",
  ],
  [
    "jazzhr",
    "https://fixture.applytojob.com/apply/ABC123/Engineer",
    '<button type="button" id="resumator-submit-resume">Submit Application</button>',
    "#resumator-submit-resume",
  ],
  [
    "phenom",
    "https://careers.fixture.test/us/en/apply?jobSeqNo=123",
    '<a id="job-description-url" href="https://careers.fixture.test/us/en/job/123">Engineer</a><button type="button" class="btn-submit">Submit Application</button>',
    ".btn-submit",
  ],
  [
    "workday",
    "https://fixture.wd1.myworkdayjobs.com/en-US/Careers/job/Engineer_R123/apply",
    '<section data-automation-id="applyFlowReviewPage"></section><button type="button" data-automation-id="pageFooterNextButton">Submit</button>',
    "[data-automation-id=pageFooterNextButton]",
  ],
]) {
  test(`${site}: an actual Submit click creates an attempt; validation and repeated observations never confirm`, async (t) => {
    const h = page(t, site, url, html);
    await h.w[
      site === "workday"
        ? "workdayTrackReviewSubmitClick"
        : site + "TrackApplication"
    ](() => {});
    h.w.document.querySelector("#review").click();
    await flush();
    assert.equal(h.records.length, 0);
    h.w.document.querySelector(submit).click();
    await flush();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].jobsSyncProof, "submit_attempt");
    h.w.document
      .querySelector("#invalid")
      .dispatchEvent(new h.w.Event("invalid", { bubbles: true }));
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="alert">Required answer missing; could not submit</div>',
    );
    h.w.document.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await flush();
    assert.equal(h.records.length, 1);
    assert.ok(
      h.records.every((record) => record.jobsSyncProof !== "ats_confirmation"),
    );
  });
}

test("Oracle's actual adapter remains fill-only and emits no submission or receipt", async (t) => {
  const h = page(
    t,
    "oracle",
    "https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123/apply",
    '<main id="main"><div class="input-row"></div><button type="button" id="submit">Submit Application</button></main>',
  );
  let clicks = 0;
  h.w.document
    .querySelector("#submit")
    .addEventListener("click", () => clicks++);
  await h.w.oracleRunApplication(h.input);
  await flush();
  assert.equal(h.advances.length, 1);
  assert.equal(h.advances[0].action, "fill");
  assert.equal(clicks, 0);
  assert.equal(h.records.length, 0);
});

for (const [site, receipt, url, mode = "run", gate = ""] of domReceipts) {
  test(`${site}: actual adapter leaves Review/validation unconfirmed and records only its visible receipt once`, async (t) => {
    const h = page(
      t,
      site,
      url,
      gate + '<section id="receipt" hidden>' + receipt + "</section>",
    );
    const start = () =>
      mode === "track"
        ? h.w[site + "TrackApplication"](() => {})
        : h.w[site + "RunApplication"](h.input);
    await start();
    await flush();
    assert.equal(
      h.records.length,
      0,
      "hidden success templates are not receipts",
    );
    h.w.document.querySelector("#review").click();
    h.w.document
      .querySelector("#invalid")
      .dispatchEvent(new h.w.Event("invalid", { bubbles: true }));
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="alert">Required answer missing; submission failed</div>',
    );
    await flush();
    assert.equal(
      h.records.length,
      0,
      "Review and validation are not confirmation",
    );
    h.w.document.querySelector("#receipt").hidden = false;
    if (mode === "route") await start();
    await flush();
    assert.equal(
      h.records.length,
      1,
      "real adapter must emit the observed ATS receipt",
    );
    assert.equal(h.records[0].jobsSyncProof, "ats_confirmation");
    h.w.document.querySelector("#receipt").append(" ");
    h.w.document.dispatchEvent(new h.w.Event("change", { bubbles: true }));
    await flush();
    assert.equal(
      h.records.length,
      1,
      "repeated DOM observations must not create a second confirmation",
    );
  });
}
