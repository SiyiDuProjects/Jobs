import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { installWorkdayCommitObserver } from "../src/custom/workday-page-state.js";
import { readModule } from "./helpers/module-source.mjs";
import { functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";

const codes = await Promise.all(
  ["dom-wait", "page-commit"].map((n) =>
    readModule(new URL(`../src/custom/${n}.js`, import.meta.url), "utf8"),
  ),
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function page() {
  const w = new JSDOM("<main><input></main>", {
    url: "https://fixture.myworkdayjobs.com/apply",
    runScripts: "outside-only",
  }).window;
  Object.assign(w, { Headers, MessageChannel });
  codes.forEach((code) => w.eval(code));
  return w;
}
const endpoint = "/wday/cxs/fixture/jobapplication/fixture-id/selfidentify";
const init = { method: "POST", headers: { "form-definition": "true" } };

test("Workday body completion and form-state continuation precede the next field", async () => {
  const w = page();
  let complete,
    state = { choice: null },
    calls = 0;
  w.fetch = async () => {
    calls++;
    return {
      ok: true,
      json: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    };
  };
  installWorkdayCommitObserver(w);
  try {
    const captured = { ...state };
    const update = (async () => {
      const r = await w.fetch(endpoint, init);
      await r.json();
      state = captured;
    })();
    await tick();
    let wrote = false;
    const next = w.JobsPageCommit.wait(w.document.querySelector("input")).then(
      (ok) => {
        assert.equal(ok, true);
        state.choice = "fixture";
        wrote = true;
      },
    );
    await tick();
    assert.equal(
      wrote,
      false,
      "response headers alone do not release the writer",
    );
    complete({});
    await update;
    await next;
    assert.equal(state.choice, "fixture");
    assert.equal(calls, 1, "observer issues no request");
    assert.deepEqual(
      JSON.parse(
        w.document.documentElement.getAttribute("data-jobs-form-commit"),
      ),
      { pending: 0, revision: 2, failed: false },
    );
  } finally {
    w.close();
  }
});

test("overlapping definitions must all settle; unrelated fetches are not tracked", async () => {
  const w = page(),
    bodies = [];
  w.fetch = async () => ({
    ok: true,
    json: () => new Promise((resolve) => bodies.push(resolve)),
  });
  installWorkdayCommitObserver(w);
  try {
    const requests = [w.fetch(endpoint, init), w.fetch(endpoint, init)];
    const responses = await Promise.all(requests);
    const reads = responses.map((r) => r.json());
    bodies[1]({});
    await reads[1];
    await w.JobsDOMWait.until(
      () =>
        JSON.parse(
          w.document.documentElement.getAttribute("data-jobs-form-commit"),
        ).pending === 1,
      { root: w.document, timeout: 1000 },
    );
    assert.equal(
      JSON.parse(
        w.document.documentElement.getAttribute("data-jobs-form-commit"),
      ).pending,
      1,
    );
    bodies[0]({});
    await reads[0];
    assert.equal(await w.JobsPageCommit.wait(w.document), true);
    await w.fetch("/unrelated", init);
    assert.equal(
      JSON.parse(
        w.document.documentElement.getAttribute("data-jobs-form-commit"),
      ).pending,
      0,
    );
  } finally {
    w.close();
  }
});

test("network failure or cancellation never acknowledges a pending form update", async () => {
  const w = page();
  w.fetch = async () => {
    throw Error("fixture network failure");
  };
  installWorkdayCommitObserver(w);
  try {
    await assert.rejects(w.fetch(endpoint, init));
    await tick();
    assert.equal(await w.JobsPageCommit.wait(w.document), false);
    assert.equal(
      await w.JobsPageCommit.wait(w.document, { canProceed: () => false }),
      false,
    );
  } finally {
    w.close();
  }
});

test("the actual Self Identify adapter waits for the date update before selecting disability", async () => {
  const w = page();
  w.document.body.innerHTML = `<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowSelfIdentifyPage">
    <fieldset><legend>Date*</legend><div id="date" data-automation-id="dateInputWrapper" role="group">
    ${["Month", "Day", "Year"].map((part) => `<input role="spinbutton" data-automation-id="dateSection${part}-input" aria-label="${part}">`).join("")}</div></fieldset>
    <fieldset data-automation-id="disabilityStatus-CheckboxGroup"><legend>Please check one of the boxes below:*</legend><div role="grid">
    ${["Yes, I have a disability, or have had one in the past", "No, I do not have a disability and have not had one in the past", "I do not want to answer"].map((label, i) => `<div role="row"><div role="cell"><input type="checkbox" id="choice-${i}" aria-required="true"><label for="choice-${i}">${label}</label></div></div>`).join("")}</div></fieldset>
    </section></main>`;
  for (const name of ["control-fields", "workday-controls", "form-pipeline"])
    w.eval(
      await readWithDependencies(
        new URL(`../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
    );
  w.eval(
    functionBlock(
      await readModule(
        new URL("../source/content/adapters/workday.js", import.meta.url),
        "utf8",
      ),
      "workdayFillSelfIdentification",
    ),
  );
  w.jobsFormatFullName = () => "Fixture Applicant";
  const root = w.document.querySelector("section"),
    date = w.document.querySelector("#date"),
    parts = [...date.querySelectorAll("input")],
    choices = [...root.querySelectorAll('input[type="checkbox"]')],
    requests = [],
    updates = [];
  let state = { date: "", choice: null };
  w.fetch = async () => ({
    ok: true,
    json: () => new Promise((resolve) => (requests.at(-1).finish = resolve)),
  });
  installWorkdayCommitObserver(w);
  const render = () =>
    choices.forEach((input, i) => {
      input.checked = state.choice === i;
      input.setAttribute("aria-checked", String(input.checked));
      input.disabled = state.choice !== null && !input.checked;
    });
  const setValue = (field, value) => {
    const captured = { ...state, [field]: value };
    state = captured;
    render();
    requests.push({ field });
    updates.push(
      (async () => {
        await (await w.fetch(endpoint, init)).json();
        state = captured;
        render();
      })(),
    );
  };
  date.addEventListener("focusout", (event) => {
    if (
      date.contains(event.relatedTarget) ||
      !parts.every((input) => input.value)
    )
      return;
    const value = parts.map((input) => input.value).join("/");
    if (state.date !== value) setValue("date", value);
  });
  choices.forEach((input, i) =>
    input.addEventListener("change", () =>
      setValue("choice", input.checked ? i : null),
    ),
  );
  try {
    const book = w.JobsFormPipeline.ledger(root);
    const fill = w.JobsFormPipeline.within(
      { root, ledger: book, canProceed: () => true },
      () =>
        w.workdayFillSelfIdentification({
          nameData: {},
          employmentData: { disability: false },
        }),
    );
    const waitFor = (condition) =>
      w.JobsDOMWait.until(condition, { root, timeout: 3000, interval: 10 });
    assert(await waitFor(() => requests[0]?.finish));
    assert.deepEqual(
      requests.map((request) => request.field),
      ["date"],
    );
    assert.equal(
      choices[1].checked,
      false,
      "choice must not overlap the pending date definition",
    );
    requests[0].finish({});
    assert(await waitFor(() => requests[1]?.finish));
    assert.deepEqual(
      requests.map((request) => request.field),
      ["date", "choice"],
    );
    requests[1].finish({});
    await Promise.all(updates);
    await fill;
    assert.equal(choices[1].checked, true);
    assert.equal(book.get(choices[1]).state, "decided");
  } finally {
    w.close();
  }
});

test("an unobservable response stays usable by the page but cannot acknowledge a commit", async () => {
  const w = page();
  w.fetch = async () =>
    Object.freeze({ ok: true, json: async () => ({ fixture: true }) });
  installWorkdayCommitObserver(w);
  try {
    const response = await w.fetch(endpoint, init);
    assert.deepEqual(await response.json(), { fixture: true });
    assert.equal(await w.JobsPageCommit.wait(w.document), false);
  } finally {
    w.close();
  }
});

test("a prior failure does not poison a later write, but this write's failure does", async () => {
  const w = page();
  let ok = false;
  w.fetch = async () => ({ ok, json: async () => ({}) });
  installWorkdayCommitObserver(w);
  try {
    await w.fetch(endpoint, init);
    await w.JobsDOMWait.until(
      () =>
        JSON.parse(
          w.document.documentElement.getAttribute("data-jobs-form-commit"),
        ).pending === 0,
      { root: w.document },
    );
    assert.equal(await w.JobsPageCommit.wait(w.document, { idle: true }), true);
    const before = w.JobsPageCommit.revision(w.document);
    assert.equal(
      await w.JobsPageCommit.wait(w.document, { since: before }),
      true,
    );
    await w.fetch(endpoint, init);
    assert.equal(
      await w.JobsPageCommit.wait(w.document, { since: before }),
      false,
    );
    ok = true;
    const retry = w.JobsPageCommit.revision(w.document);
    await (await w.fetch(endpoint, init)).json();
    assert.equal(
      await w.JobsPageCommit.wait(w.document, { since: retry }),
      true,
    );
  } finally {
    w.close();
  }
});

test("text and cloned responses settle once; stalled reads fail promptly then recover", async () => {
  const w = page();
  w.fetch = async () => new Response("{}");
  installWorkdayCommitObserver(w, { timeout: 20 });
  try {
    const response = await w.fetch(endpoint, init);
    await w.JobsDOMWait.until(
      () =>
        JSON.parse(
          w.document.documentElement.getAttribute("data-jobs-form-commit"),
        ).stalled,
      { root: w.document, interval: 5 },
    );
    assert.equal(
      await w.JobsPageCommit.wait(w.document, { idle: true }),
      false,
    );
    await response.clone().text();
    await response.json();
    assert.equal(await w.JobsPageCommit.wait(w.document), true);
    const state = JSON.parse(
      w.document.documentElement.getAttribute("data-jobs-form-commit"),
    );
    assert.equal(state.pending, 0);
    assert.equal(state.revision, 2);
  } finally {
    w.close();
  }
});
