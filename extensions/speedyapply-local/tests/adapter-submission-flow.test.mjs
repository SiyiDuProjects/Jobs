import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { readModule } from "./helpers/module-source.mjs";
import { installPageLifecycle } from "./helpers/page-lifecycle.mjs";

const scripts = await Promise.all(
  ["job-match-rules", "job-match", "submission-background", "queue-page"].map(
    (name) =>
      readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
  ),
);
const runtimeMessages = await readModule(
  new URL("../source/content/shared/runtime-messages.js", import.meta.url),
  "utf8",
);
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function flush() {
  await turn();
  await turn();
}

// Chrome's transport, tab binding, and remote persistence are fixture boundaries.
// Page navigation, DOM clicks, native validation, durable guard handling, and
// record message production execute the maintained modules unchanged.
async function page(
  t,
  {
    site,
    storage = {},
    documentId = "synthetic-document",
    html = '<form><label>First name<input name="firstName" value="Example"></label><button type="button" id="submit">Submit Application</button></form>',
    url = "https://jobs.ashbyhq.com/fixture/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/application",
  } = {},
) {
  const h = await adapterPage(t, { site, html, url }),
    w = h.w;
  installPageLifecycle(w);
  Object.defineProperty(w.crypto, "subtle", { value: webcrypto.subtle });
  w.TextEncoder = TextEncoder;
  const messages = [],
    records = [],
    listeners = [];
  const original = w.chrome.runtime.sendMessage;
  w.chrome.storage = {
    local: {
      get: async (key) => ({ [key]: structuredClone(storage[key]) }),
      set: async (values) => Object.assign(storage, structuredClone(values)),
    },
  };
  w.chrome.tabs = {
    sendMessage: async () => ({ active: true, url: w.location.href }),
  };
  w.chrome.runtime.onMessage = { addListener: (fn) => listeners.push(fn) };
  w.JobsTabProfiles = {
    verify: async () => ({ id: "fixture", profileName: "Fixture" }),
  };
  w.JobsSync = {
    removalPending: async () => false,
    resolveJob: async () => ({
      application: { submitted: records.length > 0 },
    }),
    record: async (application, source) => {
      records.push(structuredClone({ application, source }));
    },
  };
  w.JobsPageSession = {
    confirmed() {},
    setAutofill() {},
    root: () => w.document.body,
  };
  w.chrome.runtime.sendMessage = async (message) => {
    messages.push(structuredClone(message));
    if (message.type === "jobs:queue-page")
      return { data: { owned: false, allowed: true } };
    if (message.type.startsWith("jobs:submission-"))
      return new Promise((resolve, reject) => {
        const sender = {
          id: "test",
          tab: { id: 1, title: "Synthetic Engineer" },
          documentId,
          url: w.location.href,
        };
        if (!listeners.some((fn) => fn(message, sender, resolve) === true))
          reject(Error("Missing actual submission worker"));
      });
    return original(message);
  };
  for (const script of scripts) w.eval(script);
  w.eval(runtimeMessages);
  await w.JobsQueuePage.ready;
  return {
    ...h,
    storage,
    messages,
    records,
    run: (options = {}) =>
      w.JobsAutomatic.advance({
        root: w.document.querySelector("form") || w.document.body,
        profile,
        action: "submit",
        selector: "#submit",
        fill: async () => {},
        setMessage() {},
        ...options,
      }),
  };
}

test("actual automatic click persists attempted then native validation; no receipt and no second click", async (t) => {
  const h = await page(t);
  let clicks = 0;
  h.doc.querySelector("#submit").addEventListener("click", () => clicks++);
  await h.run();
  await flush();
  assert.equal(clicks, 1, JSON.stringify(h.notes));
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].source.proof, "submit_attempt");
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "attempted",
  );
  const invalid = h.doc.createElement("input");
  invalid.required = true;
  h.doc.querySelector("form").append(invalid);
  invalid.checkValidity();
  await flush();
  assert.equal(h.records.at(-1).source.proof, "submit_validation_error");
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "validation_error",
  );
  await h.run();
  await flush();
  assert.equal(clicks, 1);
  assert.ok(h.records.every((row) => row.source.proof !== "ats_confirmation"));
});

test("a prepare failure stops the real automatic DOM click", async (t) => {
  const h = await page(t);
  let clicks = 0;
  h.doc.querySelector("#submit").addEventListener("click", () => clicks++);
  h.w.JobsSync.resolveJob = async () => null;
  await h.run();
  await flush();
  assert.equal(clicks, 0);
  assert.equal(h.records.length, 0);
  assert.ok(
    h.messages.some((message) => message.type === "jobs:submission-prepare"),
    JSON.stringify(h.notes),
  );
});

test("a click method throwing before dispatch preserves preparation without inventing an attempt", async (t) => {
  const h = await page(t);
  h.doc.querySelector("#submit").click = () => {
    throw Error("Synthetic pre-dispatch failure");
  };
  await h.run();
  await flush();
  assert.equal(h.records.length, 0);
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "prepared",
  );
  assert.ok(
    !h.messages.some((message) => message.type === "jobs:submission-attempted"),
  );
});

test("a click method returning without dispatch also leaves only preparation", async (t) => {
  const h = await page(t);
  h.doc.querySelector("#submit").click = () => {};
  await h.run();
  await flush();
  assert.equal(h.records.length, 0);
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "prepared",
  );
});

test("an observed DOM click followed by an exception still records its actual attempt", async (t) => {
  const h = await page(t),
    button = h.doc.querySelector("#submit"),
    click = button.click.bind(button);
  let dispatched = 0;
  button.addEventListener("click", () => dispatched++);
  button.click = () => {
    click();
    throw Error("Synthetic post-dispatch failure");
  };
  await h.run();
  await flush();
  assert.equal(dispatched, 1);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].source.proof, "submit_attempt");
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "attempted",
  );
});

test("worker and page restart preserve an unknown submission guard and refuse another actual click", async (t) => {
  const storage = {},
    first = await page(t, { storage });
  await first.run();
  await flush();
  assert.equal(first.records.length, 1);
  first.w.close();
  const second = await page(t, { storage });
  let clicks = 0;
  second.doc.querySelector("#submit").addEventListener("click", () => clicks++);
  await second.run();
  await flush();
  assert.equal(clicks, 0);
  assert.equal(second.records.length, 0);
  assert.equal(
    Object.values(storage.jobsSubmissionGuardsV1)[0].state,
    "attempted",
  );
});

test("a real Next/Review navigation never creates a submission attempt", async (t) => {
  const h = await page(t);
  let clicks = 0;
  h.doc.querySelector("#submit").textContent = "Review";
  h.doc.querySelector("#submit").addEventListener("click", () => clicks++);
  await h.run({ action: "next" });
  await flush();
  assert.equal(clicks, 1);
  assert.equal(h.records.length, 0);
  assert.ok(
    !h.messages.some((message) => message.type.startsWith("jobs:submission-")),
  );
});

test("native validation fired synchronously by Submit remains a validation event after the attempt", async (t) => {
  const h = await page(t);
  h.doc.querySelector("#submit").addEventListener("click", () => {
    const invalid = h.doc.createElement("input");
    invalid.required = true;
    h.doc.querySelector("form").append(invalid);
    invalid.checkValidity();
  });
  await h.run();
  await flush();
  assert.equal(h.records[0]?.source.proof, "submit_attempt");
  assert.equal(h.records.at(-1)?.source.proof, "submit_validation_error");
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "validation_error",
  );
});

async function oraclePage(t, options = {}) {
  const h = await page(t, {
    ...options,
    site: "oracle",
    url: "https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123/apply",
    html: '<main id="main"><form><div class="input-row"></div><button type="button" id="submit">Submit Application</button></form></main>',
  });
  // Keep the adapter's declared fill boundary observable without supplying
  // unrelated Oracle controls. The page and worker tracking remain real.
  const advances = [];
  h.w.JobsAutomatic = {
    advance: async (options) => {
      advances.push(options);
      return true;
    },
  };
  await h.w.oracleRunApplication({
    getProfile: async () => profile,
    setMessage() {},
    autofillSettings: { saveApplications: true },
    ctx: {
      addEventListener: (target, type, fn) => target.addEventListener(type, fn),
    },
  });
  await flush();
  assert.equal(advances.length, 1);
  assert.equal(advances[0].action, "fill");
  assert.equal(h.records.length, 0);
  return h;
}

test("ordinary Oracle Submit clicks are recorded as attempts even though the adapter only fills", async (t) => {
  const h = await oraclePage(t);
  h.doc.querySelector("#submit").click();
  await flush();
  assert.ok(
    h.records.some((record) => record.source.proof === "submit_attempt"),
    "a real manual Submit cannot disappear from the attempt ledger",
  );
  assert.ok(
    h.records.every((record) => record.source.proof !== "ats_confirmation"),
  );
});

test("Oracle manual click survives a lost ACK and duplicate observations keep one guard/event", async (t) => {
  const h = await oraclePage(t),
    send = h.w.chrome.runtime.sendMessage;
  let lost = false;
  h.w.chrome.runtime.sendMessage = async (message) => {
    const response = await send(message);
    if (message.type === "jobs:submission-observed" && !lost) {
      lost = true;
      throw Error("Synthetic lost ACK");
    }
    return response;
  };
  const button = h.doc.querySelector("#submit");
  button.click();
  await flush();
  assert.equal(h.records.length, 1);
  const id = Object.values(h.storage.jobsSubmissionGuardsV1)[0].id;
  button.click();
  await flush();
  assert.equal(h.records.length, 1);
  assert.equal(Object.values(h.storage.jobsSubmissionGuardsV1)[0].id, id);
  assert.equal(h.records[0].source.eventId, id);
});

test("Oracle manual click captures synchronous invalid once and Review/disabled buttons do not record", async (t) => {
  const h = await oraclePage(t),
    button = h.doc.querySelector("#submit");
  button.textContent = "Review";
  button.click();
  await flush();
  assert.equal(h.records.length, 0);
  button.textContent = "Submit Application";
  button.disabled = true;
  button.click();
  await flush();
  assert.equal(h.records.length, 0);
  button.disabled = false;
  button.addEventListener("click", () => {
    const invalid = h.doc.createElement("input");
    invalid.required = true;
    h.doc.querySelector("form").append(invalid);
    invalid.checkValidity();
  });
  button.click();
  await flush();
  assert.deepEqual(
    h.records.map((row) => row.source.proof),
    ["submit_attempt", "submit_validation_error"],
  );
  h.doc.querySelector("input").checkValidity();
  await flush();
  assert.equal(h.records.length, 2);
  assert.equal(
    Object.values(h.storage.jobsSubmissionGuardsV1)[0].state,
    "validation_error",
  );
});

test("validation during preparation is not an executed submit validation", async (t) => {
  const h = await page(t),
    send = h.w.chrome.runtime.sendMessage;
  h.w.chrome.runtime.sendMessage = async (message) => {
    const reply = await send(message);
    if (message.type === "jobs:submission-prepare") {
      const input = h.doc.createElement("input");
      input.required = true;
      h.doc.body.append(input);
      input.checkValidity();
      input.remove();
    }
    return reply;
  };
  await h.run();
  await flush();
  assert.deepEqual(
    h.records.map((row) => row.source.proof),
    ["submit_attempt"],
  );
});

test("manual observation cannot claim a different job identity", async (t) => {
  const h = await page(t);
  const reply = await h.w.chrome.runtime.sendMessage({
    type: "jobs:submission-observed",
    url: "https://jobs.ashbyhq.com/other/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/application",
  });
  assert.match(reply.error, /identity/);
  assert.equal(h.records.length, 0);
  assert.equal(h.storage.jobsSubmissionGuardsV1, undefined);
});

const earlierPreparation = {
  id: "earlier-guard",
  state: "prepared",
  at: 1,
  tabId: 9,
  documentId: "earlier-document",
  profileId: "earlier-profile",
  profileName: "Earlier Profile",
};
test("Oracle manual click in a new document records its own attempt without replacing an earlier preparation", async (t) => {
  const h = await oraclePage(t),
    key = h.w.JobsJobMatch.key(h.w.location.href);
  h.storage.jobsSubmissionGuardsV1 = { [key]: earlierPreparation };
  let clicks = 0;
  h.doc.querySelector("#submit").addEventListener("click", () => clicks++);
  h.doc.querySelector("#submit").click();
  await flush();
  assert.equal(clicks, 1);
  assert.equal(h.records.length, 1);
  const { observed, ...root } = h.storage.jobsSubmissionGuardsV1[key];
  assert.deepEqual(root, earlierPreparation);
  const child = observed["synthetic-document"];
  assert.equal(child.state, "attempted");
  assert.notEqual(child.id, root.id);
  assert.equal(h.records[0].source.eventId, child.id);
  assert.equal(h.records[0].source.profileId, "fixture");
  assert.equal(h.records[0].application.profileName, "Fixture");
  const blocked = await h.w.chrome.runtime.sendMessage({
    type: "jobs:submission-prepare",
    url: h.w.location.href,
  });
  assert.match(blocked.error, /待核实/);
});

test("a child manual attempt survives lost ACK and worker restart with one validation identity", async (t) => {
  const storage = {},
    h = await oraclePage(t, { storage }),
    key = h.w.JobsJobMatch.key(h.w.location.href),
    send = h.w.chrome.runtime.sendMessage;
  storage.jobsSubmissionGuardsV1 = { [key]: earlierPreparation };
  let lost = false;
  h.w.chrome.runtime.sendMessage = async (message) => {
    const result = await send(message);
    if (message.type === "jobs:submission-observed" && !lost) {
      lost = true;
      throw Error("Synthetic lost ACK");
    }
    return result;
  };
  h.doc.querySelector("#submit").click();
  await flush();
  h.doc.querySelector("#submit").click();
  await flush();
  assert.equal(h.records.length, 1);
  const id =
    storage.jobsSubmissionGuardsV1[key].observed["synthetic-document"].id;
  const restarted = await oraclePage(t, { storage });
  restarted.doc.querySelector("#submit").click();
  await flush();
  assert.equal(restarted.records.length, 0);
  const input = restarted.doc.createElement("input");
  input.required = true;
  restarted.doc.querySelector("form").append(input);
  input.checkValidity();
  await flush();
  input.checkValidity();
  await flush();
  assert.equal(restarted.records.length, 1);
  assert.equal(restarted.records[0].source.eventId, id + ":validation");
  const { observed, ...root } = storage.jobsSubmissionGuardsV1[key];
  assert.deepEqual(root, earlierPreparation);
  assert.equal(observed["synthetic-document"].state, "validation_error");
});

test("an observed manual click records only an attempt even when the service already reports a submission", async (t) => {
  const h = await oraclePage(t);
  h.w.JobsSync.resolveJob = async () => ({
    application: { submitted: true, confirmed: true },
  });
  h.doc.querySelector("#submit").click();
  await flush();
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].source.proof, "submit_attempt");
});
