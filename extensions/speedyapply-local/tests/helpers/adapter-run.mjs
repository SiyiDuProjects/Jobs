import { readWithDependencies } from "./runtime-source.mjs";
import { installAnswerResolver } from "./answer-resolver.mjs";
import { JSDOM } from "jsdom";
import { format, parse } from "date-fns";

// The real runtime (rules, controls, components, pipeline, run) and one
// adapter module in a page. An adapter's fill runs inside one run, exactly as
// its step does: bindings, then the rules, AI (a fixture reply) and review.
const read = (path) =>
  readWithDependencies(new URL("../../" + path, import.meta.url), "utf8");
const custom = await Promise.all(
  [
    "answer-policy",
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "oracle-controls",
    "tag-controls",
    "legacy-select-controls",
    "menu-controls",
    "ats-choice-controls",
    "shadow-controls",
    "disclosure-controls",
    "icims-controls",
    "successfactors-controls",
    "greenhouse-controls",
    "ashby-controls",
    "tesla-controls",
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
  ["profile-format", "dom-controls", "answer-helpers", "response-capture"].map(
    (name) => read("source/content/shared/" + name + ".js"),
  ),
);
const adapters = new Map();

// The date library the runtime bundles: only the formats adapters use.
const dates = `
  function dN(value){const [year,month]=String(value).split('-').map(Number);return new Date(year,month-1,1);}
  function $j(date,format){
    const pad=value=>String(value).padStart(2,'0'),months=['January','February','March','April','May','June','July','August','September','October','November','December'];
    return format.replace(/yyyy|MMMM|MMM|MM|dd|d/g,token=>token==='yyyy'?date.getFullYear():token==='MMMM'?months[date.getMonth()]:token==='MMM'?months[date.getMonth()].slice(0,3):
      token==='MM'?pad(date.getMonth()+1):token==='dd'?pad(date.getDate()):date.getDate());
  }`;

export const profile = Object.freeze({
  profileName: "Fixture",
  nameData: {
    firstName: "Example",
    lastName: "Applicant",
    preferredName: false,
  },
  contactData: { email: "applicant@example.test", phoneNumber: "5550100" },
  addressData: {
    country: "United States",
    state: "Massachusetts",
    city: "Boston",
    line1: "1 Main St",
    postalCode: "02110",
  },
  educationData: [
    {
      school: "Example University",
      degree: "Bachelor's",
      fieldOfStudy: "Physics",
      startDate: "2021-09",
      endDate: "2025-05",
    },
  ],
  jobData: [],
  languageData: [],
  skillsData: [],
  websiteData: { websites: [] },
  employmentData: {
    eligibilityUS: true,
    sponsorship: false,
    gender: "Male",
    ethnicity: "Asian",
    veteran: false,
    disability: false,
  },
  resumeData: {},
});

export async function adapterPage(
  t,
  { site, html, url = "https://fixture.invalid/apply", saved = [], ai } = {},
) {
  if (site && !adapters.has(site))
    adapters.set(site, await read("source/content/adapters/" + site + ".js"));
  const dom = new JSDOM("<!doctype html><body>" + html + "</body>", {
      url,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }),
    w = dom.window,
    doc = w.document;
  t?.after(() => w.close());
  const notes = [],
    traces = [],
    requests = [],
    phases = [];
  let active = profile;
  w.chrome = {
    runtime: {
      id: "test",
      sendMessage: async (message) => {
        // The run checks the tab's bound Profile before and after writing.
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile: active } };
        if (message.type === "jobs:auto-answers") {
          requests.push(message);
          return {
            data: {
              answers: message.fields.map((field) => ({
                fieldId: field.fieldId,
                ...(ai?.(field) || { state: "needs_input", reason: "fixture" }),
                source: "ai",
                reason: "fixture",
              })),
            },
          };
        }
        return {};
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, node, detail }),
    trace: (node, entry) => traces.push({ node, ...entry }),
    perform: (operation, target, run) => run(),
  };
  Object.assign(w, { format, parse });
  for (const code of [...custom, ...shared]) w.eval(code);
  installAnswerResolver(w, saved);
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    configurable: true,
  });
  Object.assign(w, {
    jobsMountManualAnswerControls: async () => {},
    jobsReportJobTitle: async () => false,
    jobsSaveApplicationRecord: async () => {},
  });
  if (site) w.eval(adapters.get(site));
  // Real pages wait seconds for late options; fixtures settle at once.
  const wait = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (check, options = {}) =>
    wait(check, {
      ...options,
      timeout: options.timeout == null ? null : Math.min(options.timeout, 400),
    });
  // One run whose fill is the given adapter function; resolves when the run ends.
  async function fill(
    run,
    {
      root = doc.querySelector("form") || doc.body,
      current = profile,
      action = "fill",
    } = {},
  ) {
    active = current;
    return w.JobsAutomatic.advance({
      root,
      profile: current,
      action,
      setMessage: (message) => phases.push(message),
      resolveAnswers: w.JobsAnswerResolver.resolve,
      fill: (canProceed) => run(w, canProceed),
    });
  }
  const value = (selector) => doc.querySelector(selector)?.value;
  const checked = (selector) =>
    [...doc.querySelectorAll(selector)]
      .filter((node) => node.checked)
      .map((node) => node.value);
  return { w, doc, fill, notes, traces, requests, phases, value, checked };
}
