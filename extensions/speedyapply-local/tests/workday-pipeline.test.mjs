import { installPageLifecycle } from "./helpers/page-lifecycle.mjs";
import { inspectAnswerers } from "./helpers/one-answerer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "aria-controls",
    "form-pipeline",
    "answer-memory",
    "review-presenter",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) => read("src/custom/" + name + ".js")),
);
const shared = await Promise.all(
  ["dom-controls", "answer-helpers"].map((name) =>
    read("source/content/shared/" + name + ".js"),
  ),
);
const adapter = await read("source/content/adapters/workday.js");
const profile = {
  profileName: "Fixture",
  nameData: { firstName: "Ada", lastName: "Lovelace" },
  addressData: { country: "United States" },
  employmentData: { eligibilityUS: true, sponsorship: false },
  educationData: [],
  jobData: [],
  websiteData: {},
  resumeData: {},
};
const page = `<main><div data-automation-id="applyFlowPrimaryQuestionsPage">
  <div data-automation-id="formField-authorized"><label id="authorized-label" for="authorized">Are you legally authorized to work in the United States? *</label>
    <div data-automation-id="richText">Are you legally authorized to work in the United States?</div>
    <button id="authorized" aria-haspopup="listbox" aria-labelledby="authorized-label" aria-required="true">Select One</button></div>
  <div data-automation-id="formField-why"><label for="why">Why this company? *</label><div data-automation-id="richText">Why this company?</div><textarea id="why" required></textarea></div>
</div><button data-automation-id="pageFooterNextButton">Save and Continue</button></main>`;

test("Workday declarations wait for country and preferred-name redraws; saveResponses excludes only decided fields", async (t) => {
  const w = new JSDOM(
    '<form data-automation-id="applyFlowMyInfoPage"><label>Country<button type="button" data-automation-id="countryDropdown" aria-haspopup="listbox">Select One</button></label></form>',
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  ).window;
  t.after(() => w.close());
  const root = w.document.querySelector("form"),
    notes = [],
    p = {
      ...profile,
      nameData: {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredName: true,
        preferredFirstName: "Augusta",
      },
      contactData: {},
    };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        assert.equal(message.type, "jobs:tab-profile");
        return { data: { id: "fixture", profile: p } };
      },
    },
  };
  w.JobsDiagnostics = { note: (...args) => notes.push(args), trace() {} };
  for (const code of [...scripts, ...shared]) w.eval(code);
  w.eval(adapter);
  installAnswerResolver(w, []);
  const inspected = inspectAnswerers(w);
  const country = root.querySelector("button");
  let opens = 0;
  country.onclick = () => {
    opens++;
    country.setAttribute("aria-controls", "countries");
    root.insertAdjacentHTML(
      "beforeend",
      '<ul id="countries" role="listbox"><li role="option">United States</li></ul>',
    );
    root.querySelector("li").onclick = () => {
      country.textContent = "United States";
      root.querySelector("ul").remove();
      country.removeAttribute("aria-controls");
      root.insertAdjacentHTML(
        "beforeend",
        '<label>First name<input id="name--legalName--firstName" required></label><label>Last name<input id="name--legalName--lastName" required></label><label>Preferred name<input type="checkbox" id="name--preferredCheck"></label><div data-automation-id="formField-auth"><label>Are you authorized to work in the United States?<input id="auth" required></label></div><label>Personal note<input id="manual"></label>',
      );
      root.querySelector("#name--preferredCheck").onclick = () =>
        root.insertAdjacentHTML(
          "beforeend",
          '<div id="Preferred-Name-section"><label>Preferred first name<input id="name--preferredName--firstName" required></label><label>Preferred last name<input id="name--preferredName--lastName" required></label></div>',
        );
    };
  };
  w.jobsMountManualAnswerControls = async () => {};
  assert.equal(
    await w.JobsAutomatic.advance({
      root,
      profile: p,
      action: "fill",
      resolveAnswers: w.JobsAnswerResolver.resolve,
      fill: async (current) => {
        await w.workdayFillInformationPage(p, current);
        await w.workdayFillQuestionnaire(p, "//form", true, {}, current);
      },
    }),
    true,
    JSON.stringify(notes),
  );
  assert.equal(opens, 1);
  assert.equal(
    root.querySelector("#name--preferredName--firstName").value,
    "Augusta",
  );
  assert.equal(root.querySelector("#auth").value, "Yes");
  inspected.check(root);
  assert.equal(inspected.visits.has(country), false);
  const handlers = {},
    saved = [],
    add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, listener, ...args) => {
    handlers[type] = listener;
    return add(type, listener, ...args);
  };
  w.JobsPageSession = { profile: () => p };
  w.JobsAnswerMemory.start(
    w.document,
    true,
    (rows) => saved.push(...rows),
    () => root,
  );
  root.querySelector("#manual").value = "A manual answer";
  for (const target of root.querySelectorAll("input"))
    handlers.change({ type: "change", isTrusted: true, target });
  w.JobsAnswerMemory.flush();
  await Promise.resolve();
  assert.deepEqual(
    Array.from(saved, (item) => item.response),
    ["A manual answer"],
  );
});

test("a Workday step is one pipeline run: rule answers, AI for the gap, then one continuation, without fixed delays", async (t) => {
  const dom = new JSDOM("<!doctype html>" + page, {
      url: "https://fixture.wd1.myworkdayjobs.com/en-US/careers/job/Role_R1/apply",
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  installPageLifecycle(w);
  const requests = [],
    notes = [],
    delays = [],
    phases = [];
  let nexts = 0;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          requests.push(message);
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "The mission and the team.",
                source: "ai",
                reason: "fixture",
                needsConfirmation: false,
              })),
            },
          };
        }
        return {};
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace() {},
    perform: (operation, target, run) => run(),
  };
  for (const code of [...scripts, ...shared]) w.eval(code);
  w.eval(adapter);
  installAnswerResolver(w, []);
  const inspected = inspectAnswerers(w);
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  Object.assign(w, {
    jobsMountManualAnswerControls: async () => {},
    jobsDelay: async (ms) => {
      delays.push(ms);
    },
  });
  const button = doc.getElementById("authorized");
  const close = () => {
    doc.getElementById("authorized-options")?.remove();
    button.removeAttribute("aria-controls");
    button.setAttribute("aria-expanded", "false");
  };
  button.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  button.onclick = () => {
    close();
    button.setAttribute("aria-controls", "authorized-options");
    button.setAttribute("aria-expanded", "true");
    doc.body.insertAdjacentHTML(
      "beforeend",
      '<div id="authorized-options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
    );
    for (const option of doc.getElementById("authorized-options").children)
      option.onclick = () => {
        button.textContent = option.textContent;
        close();
      };
  };
  doc.querySelector('[data-automation-id="pageFooterNextButton"]').onclick =
    () => nexts++;
  // Other steps' watchers stay pending; silence them before the page closes.
  t.after(() => {
    w.jobsFindAllXPath = () => [];
    w.jobsFindXPath = () => null;
    w.dispatchEvent(new w.Event("pagehide"));
    w.close();
  });
  await w.workdayRunApplication({
    setMessage: (message) => phases.push(message),
    getProfile: async () => profile,
    autofillSettings: {
      autoClickNextPage: true,
      autoSubmit: false,
      saveResponses: false,
    },
    accountSettings: {},
    ctx: {},
  });
  for (let i = 0; i < 300 && !nexts; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nexts, 1, "one continuation after the step is complete");
  assert.equal(
    button.textContent,
    "Yes",
    "the Profile rule answers the authorization question",
  );
  assert.equal(doc.getElementById("why").value, "The mission and the team.");
  assert.equal(requests.length, 1);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(requests[0].fields.map((field) => field.question)),
    ),
    ["Why this company? *"],
  );
  assert.equal(
    notes.filter((note) => note.type === "auto_step_started").length,
    1,
    "fill, rules, AI and continuation are one run",
  );
  assert.deepEqual(delays, [], "no fixed delays");
  inspected.check(
    doc.querySelector('[data-automation-id="applyFlowPrimaryQuestionsPage"]'),
  );
  assert.equal(inspected.claims.get(button)?.[0], "rule");
});

test("a run without the step fill (queue resume, remote command) never swallows the adapter step fill", async (t) => {
  const dom = new JSDOM("<!doctype html>" + page, {
      url: "https://fixture.wd1.myworkdayjobs.com/en-US/careers/job/Role_R1/apply",
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  installPageLifecycle(w);
  const notes = [];
  let nexts = 0,
    releaseFallback;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers")
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "The mission and the team.",
                source: "ai",
                reason: "fixture",
                needsConfirmation: false,
              })),
            },
          };
        return {};
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace() {},
    perform: (operation, target, run) => run(),
  };
  for (const code of [...scripts, ...shared]) w.eval(code);
  w.eval(adapter);
  installAnswerResolver(w, []);
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  Object.assign(w, {
    jobsMountManualAnswerControls: async () => {},
    jobsDelay: async () => {},
  });
  const button = doc.getElementById("authorized");
  const close = () => {
    doc.getElementById("authorized-options")?.remove();
    button.removeAttribute("aria-controls");
  };
  button.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  button.onclick = () => {
    close();
    button.setAttribute("aria-controls", "authorized-options");
    doc.body.insertAdjacentHTML(
      "beforeend",
      '<div id="authorized-options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
    );
    for (const option of doc.getElementById("authorized-options").children)
      option.onclick = () => {
        button.textContent = option.textContent;
        close();
      };
  };
  doc.querySelector('[data-automation-id="pageFooterNextButton"]').onclick =
    () => nexts++;
  t.after(() => {
    w.jobsFindAllXPath = () => [];
    w.jobsFindXPath = () => null;
    w.dispatchEvent(new w.Event("pagehide"));
    w.close();
  });
  const setMessage = () => {};
  // Another run on this step without the adapter's fill; its resolver is still waiting.
  const step = doc.querySelector(
    '[data-automation-id="applyFlowPrimaryQuestionsPage"]',
  );
  const fallback = w.JobsAutomatic.advance({
    root: step,
    profile,
    action: "fill",
    setMessage,
    resolveAnswers: () =>
      new Promise((resolve) => {
        releaseFallback = () => resolve([]);
      }),
  });
  for (let i = 0; i < 100 && !releaseFallback; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await w.workdayRunApplication({
    setMessage,
    getProfile: async () => profile,
    autofillSettings: {
      autoClickNextPage: true,
      autoSubmit: false,
      saveResponses: false,
    },
    accountSettings: {},
    ctx: {},
  });
  for (
    let i = 0;
    i < 200 && !notes.some((note) => note.type === "auto_run_superseded");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFallback();
  await fallback;
  for (let i = 0; i < 300 && !nexts; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(notes.some((note) => note.type === "auto_run_superseded"));
  assert(
    notes.some((note) => note.type === "auto_adapter_fill_started"),
    "the adapter step fill runs",
  );
  assert.equal(button.textContent, "Yes");
  assert.equal(doc.getElementById("why").value, "The mission and the team.");
  assert.equal(nexts, 1, "one continuation");
});

test("status reports from a single-pipeline adapter never start another run", async (t) => {
  const dom = new JSDOM("<!doctype html>" + page, {
      url: "https://fixture.wd1.myworkdayjobs.com/en-US/careers/job/Role_R1/apply",
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document;
  installPageLifecycle(w);
  const notes = [],
    phases = [];
  let nexts = 0;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers")
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                state: "answer",
                value: "The mission and the team.",
                source: "ai",
                reason: "fixture",
                needsConfirmation: false,
              })),
            },
          };
        return {};
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, detail }),
    trace() {},
    perform: (operation, target, run) => run(),
  };
  for (const code of [...scripts, ...shared]) w.eval(code);
  w.eval(adapter);
  installAnswerResolver(w, []);
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  Object.assign(w, {
    jobsMountManualAnswerControls: async () => {},
    jobsDelay: async () => {},
  });
  const button = doc.getElementById("authorized");
  const close = () => {
    doc.getElementById("authorized-options")?.remove();
    button.removeAttribute("aria-controls");
  };
  button.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  button.onclick = () => {
    close();
    button.setAttribute("aria-controls", "authorized-options");
    doc.body.insertAdjacentHTML(
      "beforeend",
      '<div id="authorized-options" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>',
    );
    for (const option of doc.getElementById("authorized-options").children)
      option.onclick = () => {
        button.textContent = option.textContent;
        close();
      };
  };
  doc.querySelector('[data-automation-id="pageFooterNextButton"]').onclick =
    () => nexts++;
  const stops = [];
  t.after(() => {
    for (const stop of stops) stop();
    w.jobsFindAllXPath = () => [];
    w.jobsFindXPath = () => null;
    w.dispatchEvent(new w.Event("pagehide"));
    w.close();
  });
  // The adapter's status goes through the real status observer, as in the extension.
  const options = w.JobsAutomatic.observe({
    setMessage: (message) => phases.push(message),
    getProfile: async () => profile,
    autofillSettings: {
      autoClickNextPage: true,
      autoSubmit: false,
      saveResponses: false,
    },
    accountSettings: {},
    ctx: { onInvalidated: (stop) => stops.push(stop) },
  });
  await w.workdayRunApplication(options);
  options.setMessage("complete-manually");
  for (let i = 0; i < 300 && !nexts; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nexts, 1);
  assert.equal(button.textContent, "Yes");
  assert.equal(
    notes.filter((note) => note.type === "auto_step_started").length,
    1,
    "only the step run",
  );
  assert(
    !notes.some(
      (note) =>
        note.type === "auto_fallback_checked" ||
        note.type === "auto_run_superseded",
    ),
    "no fallback run was started",
  );
});
