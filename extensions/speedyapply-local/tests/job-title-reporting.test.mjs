import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readModule } from "./helpers/module-source.mjs";

const read = (file) =>
  readModule(new URL("../" + file, import.meta.url), "utf8");
const common = await Promise.all(
  [
    "src/custom/job-match-rules.js",
    "src/custom/job-match.js",
    "src/custom/platform-config.js",
    "source/content/shared/dom-controls.js",
    "source/content/shared/runtime-messages.js",
    "source/content/shared/response-capture.js",
  ].map(read),
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function page(
  t,
  url = "https://jobs.ashbyhq.com/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application",
  html = "",
) {
  const dom = new JSDOM(
    "<!doctype html><title>Apply - Research Engineer</title>" + html,
    { url, runScripts: "outside-only" },
  );
  const w = dom.window,
    sent = [];
  t.after(() => w.close());
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(structuredClone(message));
        return { ok: true };
      },
    },
  };
  w.JobsPageSession = { confirmed() {} };
  w.jobsWaitForConfirmation = () => new Promise(() => {});
  w.JobsDOMWait = { until: async () => true };
  common.forEach((source) => w.eval(source));
  // A pending confirmation is not an observed receipt.
  w.jobsWaitForConfirmation = () => new Promise(() => {});
  return { w, sent, dom };
}

test("title transport normalizes whitespace, deduplicates acknowledgements and never persists", async (t) => {
  const { w, sent } = page(t);
  assert.equal(await w.jobsReportJobTitle("  Research\n Engineer\t "), true);
  assert.equal(await w.jobsReportJobTitle("Research Engineer"), true);
  assert.deepEqual(sent, [
    {
      type: "jobs:job-title-observed",
      title: "Research Engineer",
      url: w.location.href,
    },
  ]);
  for (const title of [
    "",
    "Apply now",
    "Thank you!",
    "Application submitted",
    "Confirmation",
    "Review",
    "Review Application.",
    "Review Your Application!",
    "Careers",
    "Similar Jobs (2)",
    "My Experience",
    "Application Questions",
    "Sign In",
    "Loading...",
    "https://example.test/jobs/1",
    "x".repeat(501),
    "Engineer\0",
    "\ud800",
  ])
    assert.equal(await w.jobsReportJobTitle(title), false, title);
  assert.equal(sent.length, 1);
});

test("failure, missing acknowledgement and concurrent messages do not block a later retry", async (t) => {
  const { w } = page(t);
  let attempts = 0,
    finish;
  w.chrome.runtime.sendMessage = () => {
    attempts++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = w.jobsReportJobTitle("Research Engineer");
  assert.equal(await w.jobsReportJobTitle("Research Engineer"), false);
  assert.equal(attempts, 1);
  finish({ ok: false });
  assert.equal(await first, false);
  w.chrome.runtime.sendMessage = () => {
    attempts++;
    throw Error("Disconnected");
  };
  assert.equal(await w.jobsReportJobTitle("Research Engineer"), false);
  w.chrome.runtime.sendMessage = async () => {
    attempts++;
    return { ok: true };
  };
  assert.equal(await w.jobsReportJobTitle("Research Engineer"), true);
  assert.equal(attempts, 3);
});

test("stale captured title and stale receipt closure cannot rename the new SPA job", async (t) => {
  const { w, sent } = page(t);
  const oldUrl = w.location.href;
  w.history.replaceState(
    null,
    "",
    "/fixture/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/application",
  );
  assert.equal(await w.jobsReportJobTitle("Old title", oldUrl), false);
  w.jobsTrackApplicationOnUnload(
    "#submit",
    "Old title",
    oldUrl,
    "",
    "",
    false,
    5000,
    undefined,
    false,
  );
  await w.jobsSaveApplicationRecord({
    jobTitle: "Old title",
    jobLink: oldUrl,
    jobsSyncProof: "submit_attempt",
  });
  assert.deepEqual(
    sent.map((x) => x.type),
    ["saveApplication"],
  );
  await w.jobsSaveApplicationRecord({
    jobTitle: "New title",
    jobLink: w.location.href,
    jobsSyncProof: "submit_attempt",
  });
  assert.deepEqual(
    sent.map((x) => x.type),
    ["saveApplication", "jobs:job-title-observed", "saveApplication"],
  );
});

const tracks = [
  [
    "ashby",
    "ashbyTrackApplication",
    "https://jobs.ashbyhq.com/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application",
    "<h1>Research Engineer</h1>",
    [() => {}, undefined],
  ],
  [
    "breezy",
    "breezyTrackApplication",
    "https://fixture.breezy.hr/p/abcdef-engineer",
    '<div id="heroBackgroundColor"><h1>Research Engineer</h1></div>',
    [],
  ],
  [
    "comeet",
    "comeetTrackApplication",
    "https://www.comeet.com/jobs/fixture/123/engineer/456",
    '<script>POSITION_DATA={"position_uid":"456","name":"Research Engineer","careers_page_url":"https://www.comeet.com/jobs/fixture/123/engineer/456"}</script>',
    [() => {}],
  ],
  [
    "dover",
    "doverTrackApplication",
    "https://app.dover.com/apply/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    "<section><a><img></a><div><div>Research Engineer</div></div></section>",
    [() => {}],
  ],
  [
    "eightfold",
    "eightfoldTrackApplication",
    "https://fixture.eightfold.ai/careers?pid=123",
    '<div class="apply-position-title">Research Engineer</div>',
    [() => {}],
  ],
  [
    "eightfold",
    "eightfoldTrackAlternateApplication",
    "https://fixture.eightfold.ai/careers?pid=123",
    '<div class="jobCartPositionName">Research Engineer</div>',
    [() => {}],
  ],
  [
    "freshteam",
    "freshteamTrackApplication",
    "https://fixture.freshteam.com/jobs/123/engineer",
    '<h1 class="brand-color">Research Engineer</h1>',
    [() => {}],
  ],
  [
    "greenhouse",
    "greenhouseTrackApplication",
    "https://job-boards.greenhouse.io/fixture/jobs/123",
    '<div class="job__title"><h1>Research Engineer</h1></div>',
    [undefined],
  ],
  [
    "greenhouse",
    "greenhouseLegacyTrackApplication",
    "https://boards.greenhouse.io/fixture/jobs/123",
    '<h1 class="app-title">Research Engineer</h1>',
    [],
  ],
  [
    "jazzhr",
    "jazzhrTrackApplication",
    "https://fixture.applytojob.com/apply/ABC123/engineer",
    '<h1 class="job_title">Research Engineer</h1>',
    [],
  ],
  [
    "phenom",
    "phenomTrackApplication",
    "https://careers.fixture.test/global/en/job/123",
    '<a id="job-description-url" href="https://careers.fixture.test/global/en/job/123">Research Engineer</a>',
    [],
  ],
  [
    "polymer",
    "polymerTrackApplication",
    "https://jobs.polymer.co/fixture/123/application",
    '<div class="title">Research Engineer</div>',
    [() => {}],
  ],
  [
    "rippling",
    "ripplingLegacyTrackApplication",
    "https://fixture.rippling-ats.com/job/123/engineer",
    '<div class="job-title-container"><h2>Research Engineer</h2></div>',
    [],
  ],
  [
    "seek",
    "seekTrackApplication",
    "https://www.seek.com.au/job/123/apply",
    "<h1>Research Engineer</h1>",
    [],
  ],
  [
    "successfactors",
    "successfactorsTrackApplication",
    "https://career4.successfactors.com/career?company=fixture&career_job_req_id=123",
    '<div id="pageTitle"><h1>Research Engineer</h1></div>',
    [],
  ],
  [
    "tiktok",
    "tiktokTrackApplication",
    "https://careers.tiktok.com/resume/123/apply",
    '<div class="resumeEditForm-headerText">Research Engineer</div>',
    [
      {
        ctx: {
          addEventListener() {
            throw Error("Unexpected listener");
          },
        },
        setMessage() {},
      },
    ],
  ],
  [
    "workable",
    "workableTrackApplication",
    "https://apply.workable.com/fixture/j/ABC123/",
    '<h1 data-ui="job-title">Research Engineer</h1>',
    [],
  ],
  [
    "workday",
    "workdayTrackReviewSubmitClick",
    "https://fixture.wd1.myworkdayjobs.com/en-US/jobs/job/City/Engineer_R123/apply",
    "<h3>Research Engineer</h3>",
    [],
  ],
];
for (const [site, name, url, html, args] of tracks) {
  const source = await read("source/content/adapters/" + site + ".js");
  test(
    name +
      " reports existing title with recording disabled and no receipt/submit wait",
    async (t) => {
      const { w, sent } = page(t, url, html);
      w.eval(source);
      w.jobsWaitForConfirmation = () => {
        throw Error("Unexpected receipt wait");
      };
      w.jobsWaitForCssNodes = () => {
        throw Error("Unexpected submit wait");
      };
      w.JobsDOMWait.until = () => {
        throw Error("Unexpected metadata wait");
      };
      await w[name](...args, false);
      await flush();
      assert.deepEqual(sent, [
        { type: "jobs:job-title-observed", title: "Research Engineer", url },
      ]);
    },
  );
}

test("Dover does not pair pre-wait metadata with a later SPA URL", async (t) => {
  const { w, sent } = page(t, tracks[3][2], tracks[3][3]);
  w.eval(await read("source/content/adapters/dover.js"));
  w.JobsDOMWait.until = async () => {
    w.history.replaceState(
      null,
      "",
      "/apply/fixture/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    );
  };
  await w.doverTrackApplication(() => {});
  assert.equal(sent.length, 0);
});

test("Workday generic Review heading does not rename the job or interrupt its existing attempt record", async (t) => {
  const { w, sent } = page(
    t,
    "https://fixture.wd1.myworkdayjobs.com/en-US/jobs/job/City/Engineer_R123/apply",
    '<section data-automation-id="applyFlowReviewPage"><h3>Review</h3></section><button data-automation-id="pageFooterNextButton">Submit</button>',
  );
  w.eval(await read("source/content/adapters/workday.js"));
  const button = w.document.querySelector("button");
  w.jobsWaitForCssNodes = async () => [button];
  await w.workdayTrackReviewSubmitClick();
  assert.equal(sent.length, 0);
  button.click();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "saveApplication");
  assert.equal(sent[0].jobsSyncProof, "submit_attempt");
  assert.equal(
    sent[0].jobTitle,
    "Review",
    "the original receipt payload is unchanged",
  );
});

test("Indeed review observes existing header without recording an application", async (t) => {
  const { w, sent } = page(
    t,
    "https://smartapply.indeed.com/beta/indeedapply/form/review",
    '<div class="ia-JobHeader"><h1>Research Engineer</h1><span>Fixture</span></div><script>{"jk":"abc123"}</script>',
  );
  w.eval(await read("source/content/adapters/indeed.js"));
  const attempt = w.indeedReadAttempt("https://www.indeed.com");
  assert.equal(attempt.jobTitle, "Research Engineer");
  assert.deepEqual(
    sent.map((x) => x.type),
    ["jobs:job-title-observed"],
  );
});

for (const saveApplications of [false, undefined])
  test(`Comeet actual run observes a title when saveApplications=${saveApplications} without registering a receipt`, async (t) => {
    const { w, sent } = page(t, tracks[2][2], tracks[2][3] + "<form></form>");
    w.eval(await read("source/content/adapters/comeet.js"));
    w.jobsWaitForCssNodes = async () => [w.document.querySelector("form")];
    w.jobsMountManualAnswerControls = async () => {};
    w.jobsWaitForConfirmation = () => {
      throw Error("Recording is disabled");
    };
    const advances = [];
    w.JobsAutomatic = {
      advance: async (options) => {
        advances.push(options.action);
      },
    };
    await w.comeetRunApplication({
      getProfile: async () => ({}),
      setMessage() {},
      autofillSettings: { saveApplications, autoSubmit: false },
      ctx: {},
    });
    await flush();
    assert.deepEqual(
      sent.map((x) => x.type),
      ["jobs:job-title-observed"],
    );
    assert.deepEqual(advances, ["fill"]);
  });

test("Lever form metadata reports before pending Profile fetch, with no submission record", async (t) => {
  const { w, sent } = page(
    t,
    "https://jobs.lever.co/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/apply",
    "<h2>Research Engineer</h2><form></form>",
  );
  w.eval(await read("source/content/adapters/lever.js"));
  w.jobsWaitForCssNodes = async () => [w.document.querySelector("form")];
  w.jobsWaitForConfirmation = () => {
    throw Error("Recording is disabled");
  };
  await w.leverRunApplication({
    getProfile: () => new Promise(() => {}),
    setMessage() {},
    autofillSettings: { saveApplications: false },
    ctx: {},
  });
  await flush();
  assert.deepEqual(sent, [
    {
      type: "jobs:job-title-observed",
      title: "Research Engineer",
      url: w.location.href,
    },
  ]);
});
