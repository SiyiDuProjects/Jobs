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
const worker = await readModule(
  new URL("../source/background-api.js", import.meta.url),
  "utf8",
);
const shell = await readModule(
  new URL("../source/content/shell.js", import.meta.url),
  "utf8",
);
const titleMessages = await readModule(
  new URL("../source/content/shared/runtime-messages.js", import.meta.url),
  "utf8",
);
const profileReader = await readModule(
  new URL("../source/content/shared/profiles.js", import.meta.url),
  "utf8",
);
const profileContract = await readModule(
  new URL("../src/custom/profile-contract.js", import.meta.url),
  "utf8",
);
const registration = await readModule(
  new URL("../source/runtime-registration.js", import.meta.url),
  "utf8",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(
  url = "https://jobs.ashbyhq.com/example/job/application",
  html = "",
) {
  const w = new JSDOM("<!doctype html>" + html, {
      url,
      runScripts: "outside-only",
    }).window,
    sent = [],
    runs = [];
  w.jobsAdapterRoutes = [
    {
      script: async () => {},
      pattern: /jobs\.ashbyhq\.com\/example\/job\/application/,
    },
    { script: async () => {}, selector: "head[data-ph-id]" },
  ];
  w.jobsRunAdapter = async (script, options) => {
    runs.push(options);
  };
  const profile = {
    profileName: "Intern",
    nameData: {},
    addressData: {},
    contactData: {},
    jobData: [],
    educationData: [],
    languageData: [],
    resumeData: {},
    websiteData: {},
    employmentData: {},
  };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === "getAutofillConfig")
          return {
            data: {
              enabled: true,
              autofillSettings: { saveResponses: true },
              accountSettings: {},
            },
          };
        if (message.type === "jobs:tab-profile")
          return { data: { id: "profile-id", profile } };
        if (
          ["storeJobDetails", "jobs:job-title-observed"].includes(message.type)
        )
          return { ok: true };
        return { data: { applied: false } };
      },
    },
  };
  w.TextEncoder = TextEncoder;
  w.JobsJobMatch = JobsJobMatch;
  w.eval(titleMessages);
  w.eval(profileContract);
  w.eval(profileReader);
  w.eval(shell);
  return {
    w,
    sent,
    runs,
    close: () => {
      w.dispatchEvent(new w.Event("pagehide"));
      w.close();
    },
  };
}
test("Workday account startup survives standalone login while posting status checks remain enforced", async () => {
  const posting =
    "https://cae.wd3.myworkdayjobs.com/en-US/career/job/Arlington%2C-TX/Weapons-Simulation-Software-Co-Op_123873/apply/applyManually";
  const login =
    "https://aero.wd5.myworkdayjobs.com/en-US/external/login?redirect=%2Fen-US%2Fexternal%2Fjob%2FEl-Segundo%252C-CA%2FXMLNAME-2027-Software-Systems-Engineer-and-Acquisition-Intern_R016431%2Fapply%2FapplyManually";
  for (const scenario of [
    { url: login, lookups: 0, runs: 1 },
    { url: login.split("?")[0], lookups: 0, runs: 1 },
    { url: posting, lookups: 1, runs: 1 },
    { url: posting, lookups: 1, runs: 0, fail: true },
  ]) {
    const h = fixture(scenario.url);
    let lookups = 0;
    const account = {
      accountEmail: "fixture@example.invalid",
      accountPassword: "synthetic-fixture-only",
    };
    try {
      h.w.jobsAdapterRoutes = [
        { script: async () => {}, pattern: /\.myworkdayjobs\.com\// },
      ];
      h.w.JobsJobMatch = JobsJobMatch;
      h.w.JobsSync = {
        resolveJob: async (url) => {
          lookups++;
          publicJobUrl(url); // Real identity guard which originally blocked login.
          if (scenario.fail) throw Error("Status unavailable");
          return {
            application: {
              submitted: true,
              confirmed: true,
              label: "Already applied",
            },
          };
        },
      };
      h.w.JobsTabProfiles = { ensure: async () => null };
      Object.assign(h.w.chrome.runtime, {
        id: "jobs",
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
      });
      h.w.chrome.storage = {
        local: { get: async () => ({ autofillAccount: account }) },
        session: { get: async () => ({}), set: async () => {} },
      };
      h.w.eval(worker);
      const sender = { id: "jobs", tab: { id: 1 }, url: scenario.url };
      h.w.chrome.runtime.sendMessage = async (message) => {
        h.sent.push(message);
        try {
          return { data: await h.w.handle(message, sender) };
        } catch (error) {
          return { error: error.message };
        }
      };
      await h.w.startPage();
      assert.equal(lookups, scenario.lookups, scenario.url);
      assert.equal(h.runs.length, scenario.runs, scenario.url);
      if (scenario.runs) {
        assert.equal(
          h.runs[0].accountSettings.accountEmail,
          account.accountEmail,
        );
        assert.equal(
          h.runs[0].accountSettings.accountPassword,
          account.accountPassword,
        );
        const status = await h.w.handle(
          { type: "jobs:application-status", url: scenario.url },
          sender,
        );
        assert.equal(status.applied, scenario.url === posting);
        if (scenario.url !== posting) assert.equal(status.unknown, true);
      }
      assert(!h.sent.some((message) => message.type === "saveApplication"));
    } finally {
      h.close();
    }
  }
});
test("native shell extracts job details, presents isolated status and obtains a fresh tab Profile", async () => {
  const h = fixture(
    undefined,
    '<script type="application/ld+json">{"@type":"JobPosting","title":"Fixture engineer","description":"<p>Build instruments</p>"}</script>',
  );
  try {
    assert.equal(await h.w.startPage(), true);
    assert.equal(h.runs.length, 1);
    assert.equal(h.sent[0].title, "Fixture engineer");
    assert.equal(h.sent[0].description, "Build instruments");
    assert(h.w.document.querySelector('[data-jobs-ui="status"]'));
    assert.equal((await h.runs[0].getProfile()).profileName, "Intern");
    assert.equal(h.sent.at(-1).refresh, true);
    h.runs[0].ctx.abort();
    assert(!h.w.document.querySelector('[data-jobs-ui="status"]'));
  } finally {
    h.close();
  }
});
test("a blocked configuration is presented once without an unhandled startup rejection or adapter run", async () => {
  const h = fixture();
  const attach = h.w.Element.prototype.attachShadow;
  let shadow,
    requests = 0;
  h.w.Element.prototype.attachShadow = function (options) {
    shadow = attach.call(this, options);
    return shadow;
  };
  h.w.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "getAutofillConfig") {
      requests++;
      return { error: "旧版插件的本地资料尚未完成受控迁移，自动填写已暂停" };
    }
    return { data: { applied: false } };
  };
  try {
    h.w.watchPage();
    await tick();
    assert.match(shadow.textContent, /受控迁移/);
    assert.equal(h.runs.length, 0);
    h.w.document.body.append(h.w.document.createElement("div"));
    await tick();
    assert.equal(requests, 1);
    assert.equal(
      h.w.document.querySelectorAll('[data-jobs-ui="status"]').length,
      1,
    );
  } finally {
    h.close();
  }
});
test("custom job domains wait for framework markers without uploading unrelated page contents", async () => {
  const h = fixture("https://custom-careers.example/job/fixture");
  try {
    h.w.watchPage();
    await tick();
    assert.equal(h.sent.length, 0);
    h.w.document.head.dataset.phId = "career";
    await tick();
    await tick();
    assert.equal(h.runs.length, 1);
    for (let i = 0; i < 10; i++)
      h.w.document.body.append(h.w.document.createElement("span"));
    await tick();
    assert.equal(h.runs.length, 1);
  } finally {
    h.close();
  }
});
test("SPA routing observes the actual URL and emits one location event without polling", async () => {
  const h = fixture("https://jobs.ashbyhq.com/example/job/overview");
  let observed;
  try {
    const context = h.w.watchPage();
    context.addEventListener(
      h.w,
      "jobs:locationchange",
      (event) => (observed = event.newUrl.href),
    );
    await tick();
    assert.equal(h.sent.length, 0);
    h.w.history.pushState({}, "", "/example/job/application");
    h.w.document.body.append(h.w.document.createElement("div"));
    await tick();
    await tick();
    assert.equal(h.runs.length, 1);
    assert.equal(observed, h.w.location.href);
  } finally {
    h.close();
  }
});
test("LinkedIn records only an observed completion for the current job", async () => {
  const h = fixture("https://www.linkedin.com/jobs/view/12345/");
  try {
    await h.w.startPage();
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      "<h2>Review application</h2>",
    );
    await tick();
    assert(!h.sent.some((x) => x.type === "saveApplication"));
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      "<h2>Application submitted</h2>",
    );
    await tick();
    assert.equal(h.sent.filter((x) => x.type === "saveApplication").length, 1);
    assert.equal(h.sent.at(-1).jobsSyncProof, "ats_confirmation");
    h.w.document.body.append(h.w.document.createElement("span"));
    await tick();
    assert.equal(h.sent.filter((x) => x.type === "saveApplication").length, 1);
  } finally {
    h.close();
  }
});
test("custom-domain injection uses locally registered job candidates and includes required frames only there", async () => {
  const calls = [],
    checked = [];
  let updated;
  vm.runInNewContext(registration, {
    chrome: {
      tabs: { onUpdated: { addListener: (fn) => (updated = fn) } },
      scripting: { executeScript: async (options) => calls.push(options) },
    },
    JobsTabProfiles: {
      candidate: async (tab) => {
        checked.push(tab.url);
        return tab.id === 7;
      },
    },
  });
  updated(
    3,
    { status: "complete" },
    { id: 3, url: "https://example.test/news" },
  );
  updated(
    7,
    { status: "complete" },
    { id: 7, url: "https://custom-careers.example/job/fixture" },
  );
  updated(8, { status: "complete" }, { id: 8, url: "chrome://settings" });
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    target: { tabId: 7, allFrames: true },
    files: ["custom/runtime-bundle.js"],
  });
  assert.equal(checked.length, 2);
});

const postingUrl =
  "https://pacificlife.wd1.myworkdayjobs.com/en-US/PacificLifeCareers/job/Newport-Beach-CA-700/Summer-2027-Data-Engineering-Internship_R17828";
const fullTitle = "Summer 2027 Data Engineering Internship";
function postingFixture(html = "") {
  const h = fixture(postingUrl, html);
  h.w.jobsAdapterRoutes = [{ pattern: /\.myworkdayjobs\.com\// }];
  h.w.chrome.runtime.sendMessage = async (message) => {
    h.sent.push(structuredClone(message));
    if (message.type === "getAutofillConfig")
      return { data: { enabled: false } };
    return { ok: true };
  };
  h.reports = () =>
    h.sent.filter((message) => message.type === "jobs:job-title-observed");
  return h;
}

test("opening a posting reports its full h2 title without autofill, Profile or application records", async () => {
  const h = postingFixture(
    `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2><h3>Similar Jobs (2)</h3>`,
  );
  try {
    h.w.watchPage();
    await tick();
    assert.deepEqual(h.reports(), [
      { type: "jobs:job-title-observed", title: fullTitle, url: postingUrl },
    ]);
    assert.equal(
      h.sent.find((message) => message.type === "storeJobDetails").title,
      fullTitle,
    );
    assert.equal(h.runs.length, 0);
    assert(
      !h.sent.some((message) =>
        /Profile|saveApplication|saveResponses/i.test(message.type),
      ),
    );
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      "<input><div>Form changed</div>",
    );
    h.w.dispatchEvent(new h.w.Event("focus"));
    await tick();
    assert.equal(h.reports().length, 1, "acknowledged titles are deduplicated");
  } finally {
    h.close();
  }
});

test("late heading and text updates feed both existing metadata paths", async () => {
  const h = postingFixture("<title>Careers</title><h3>Similar Jobs (2)</h3>");
  try {
    h.w.watchPage();
    await tick();
    assert.equal(h.reports().length, 0);
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2>`,
    );
    await tick();
    assert.equal(h.reports()[0].title, fullTitle);
    h.w.document.querySelector("h2").firstChild.data =
      "Updated Engineering Internship";
    await tick();
    assert.equal(h.reports().at(-1).title, "Updated Engineering Internship");
    assert.equal(
      h.sent.filter((message) => message.type === "storeJobDetails").at(-1)
        .title,
      "Updated Engineering Internship",
    );
  } finally {
    h.close();
  }
});

test("metadata mounting during account startup is observed after startup settles", async () => {
  const h = postingFixture();
  let release;
  const send = h.w.chrome.runtime.sendMessage;
  h.w.chrome.runtime.sendMessage = (message) =>
    message.type === "getAutofillConfig"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : send(message);
  try {
    h.w.watchPage();
    await tick();
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2>`,
    );
    await tick();
    release({ data: { enabled: false } });
    await tick();
    assert.equal(h.reports().at(-1).title, fullTitle);
  } finally {
    h.close();
  }
});

test("SPA job navigation never sends the previous posting title with the new URL", async () => {
  const h = postingFixture(
    `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2>`,
  );
  try {
    h.w.watchPage();
    await tick();
    const next = postingUrl.replace("R17828", "R17829");
    h.w.history.pushState({}, "", next);
    h.w.document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-automation-id="jobPostingDescription">Next job description</div>',
    );
    await tick();
    assert.equal(h.reports().length, 1);
    h.w.document.querySelector("h2").textContent =
      "Summer 2027 Actuarial Internship";
    await tick();
    assert.deepEqual(h.reports().at(-1), {
      type: "jobs:job-title-observed",
      title: "Summer 2027 Actuarial Internship",
      url: next,
    });
    assert(
      !h.sent.some(
        (message) => message.appUrl === next && message.title === fullTitle,
      ),
    );
  } finally {
    h.close();
  }
});

test("a failed title upload retries on reconnect without blocking page startup", async () => {
  const h = postingFixture(
    `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2>`,
  );
  const send = h.w.chrome.runtime.sendMessage;
  let release;
  h.w.chrome.runtime.sendMessage = (message) =>
    message.type === "jobs:job-title-observed"
      ? new Promise((resolve) => {
          h.sent.push(structuredClone(message));
          release = resolve;
        })
      : send(message);
  try {
    h.w.watchPage();
    await tick();
    assert(
      h.sent.some((message) => message.type === "getAutofillConfig"),
      "upload does not block startup",
    );
    release({ ok: false });
    await tick();
    h.w.chrome.runtime.sendMessage = send;
    h.w.dispatchEvent(new h.w.Event("online"));
    await tick();
    assert.equal(h.reports().length, 2);
    h.w.dispatchEvent(new h.w.Event("online"));
    await tick();
    assert.equal(h.reports().length, 2);
  } finally {
    h.close();
  }
});

test("closing a document during metadata storage prevents a delayed title report", async () => {
  const h = postingFixture(
    `<h2 data-automation-id="jobPostingHeader">${fullTitle}</h2>`,
  );
  const send = h.w.chrome.runtime.sendMessage;
  let release;
  h.w.chrome.runtime.sendMessage = (message) =>
    message.type === "storeJobDetails"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : send(message);
  try {
    h.w.watchPage();
    await tick();
    h.w.dispatchEvent(new h.w.Event("pagehide"));
    release({ ok: true });
    await tick();
    assert.equal(h.reports().length, 0);
  } finally {
    h.close();
  }
});

test("temporary job context retains the title through form steps and resets for another job", async () => {
  const session = {};
  const context = vm.createContext({
    JobsJobMatch,
    chrome: {
      runtime: {
        id: "jobs",
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
      },
      storage: {
        session: {
          get: async (key) => ({ [key]: session[key] }),
          set: async (data) => Object.assign(session, data),
        },
      },
    },
  });
  vm.runInContext(worker, context);
  const sender = { id: "jobs", tab: { id: 7 }, url: postingUrl };
  const store = (message) =>
    context.handle({ type: "storeJobDetails", ...message }, sender);
  await store({
    appUrl: postingUrl,
    title: fullTitle,
    observedTitle: fullTitle,
    description: "Posting description",
  });
  const h = postingFixture("<h1>Review Application</h1><title>Review</title>");
  try {
    h.w.history.replaceState({}, "", postingUrl + "/apply");
    const details = h.w.extractJob();
    assert.equal(details.observedTitle, "");
    await store(details);
    assert.equal(session.job_7.title, fullTitle);
    assert.equal(session.job_7.description, "Posting description");
    await store({
      appUrl: postingUrl.replace("R17828", "R17829"),
      title: "",
      observedTitle: "",
      description: "",
    });
    assert.equal(session.job_7.title, "");
    assert.equal(session.job_7.description, "");
  } finally {
    h.close();
  }
});
