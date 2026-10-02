import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const waitSource = await readWithDependencies(
  new URL("../src/custom/dom-wait.js", import.meta.url),
  "utf8",
);
const contentSource = await readModule(
  new URL("../source/content/shared/dom-controls.js", import.meta.url),
  "utf8",
);
const ashbySource = await readWithDependencies(
  new URL("../src/custom/ashby-controls.js", import.meta.url),
  "utf8",
);
const pipelineSource = await readWithDependencies(
  new URL("../src/custom/form-pipeline.js", import.meta.url),
  "utf8",
);
const fieldsSource = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const helperNames = [
  "jobsWaitForCssNodes",
  "jobsWaitForXPathNodes",
  "jobsFindXPath",
  "jobsFindAllXPath",
  "jobsWaitForXPathNodesWithRetry",
  "jobsWaitForXPathRemoval",
];
const actualFunction = (name) => functionBlock(contentSource, name);
function fixture(t) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://jobs.ashbyhq.com/test",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    doc = w.document;
  assert.equal(doc.hidden, true);
  let rafCalls = 0,
    nextTimer = 0,
    activeObservers = 0;
  const timers = new Map();
  // Model a hidden tab where RAF never fires and every timer is delayed until
  // the test explicitly releases it. DOM mutation microtasks remain available.
  w.requestAnimationFrame = () => {
    rafCalls++;
    return 1;
  };
  w.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  const Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer {
    active = false;
    observe(...args) {
      super.observe(...args);
      if (!this.active) {
        this.active = true;
        activeObservers++;
      }
    }
    disconnect() {
      super.disconnect();
      if (this.active) {
        this.active = false;
        activeObservers--;
      }
    }
  };
  w.eval(waitSource);
  w.eval(fieldsSource);
  w.eval(
    helperNames.map(actualFunction).join("\n") +
      "\nwindow.helpers = {" +
      helperNames.join(",") +
      "};",
  );
  w.eval(ashbySource);
  w.eval(pipelineSource);
  return {
    w,
    doc,
    h: w.helpers,
    fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert(entry, "expected scheduled timer: " + delay);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    clean() {
      assert.equal(activeObservers, 0);
      assert.equal(timers.size, 0);
      assert.equal(rafCalls, 0);
    },
  };
}

test(
  "hidden-tab CSS and XPath waits react to DOM changes with every frame/timer paused",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { doc, h } = f;
    const css = h.jobsWaitForCssNodes("button.ready"),
      xpath = h.jobsWaitForXPathNodes('//button[text()="Ready"]');
    doc.body.innerHTML = "<button>Waiting</button>";
    await Promise.resolve();
    const button = doc.querySelector("button");
    button.className = "ready";
    button.firstChild.data = "Ready";
    assert.equal((await css)[0], button);
    assert.equal((await xpath)[0], button);
    f.clean();
  },
);

test(
  "bounded XPath waits preserve retry count and return empty only after all attempts",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      retries = [];
    const missing = f.h.jobsWaitForXPathNodesWithRetry(
      "//input",
      25,
      2,
      (attempt) => retries.push(attempt),
    );
    f.fire(25);
    await Promise.resolve();
    assert.deepEqual(retries, [1]);
    f.fire(25);
    assert.equal((await missing).length, 0);
    f.clean();
    const found = f.h.jobsWaitForXPathNodesWithRetry("//input", 25, 2, () => {
      f.doc.body.innerHTML = "<input>";
    });
    f.fire(25);
    assert.equal((await found)[0], f.doc.querySelector("input"));
    f.clean();
  },
);

test(
  "delayed timeout checks current DOM before expiring, without waiting for an observer delivery",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    const pending = f.h.jobsWaitForXPathNodesWithRetry("//input", 25);
    f.doc.body.innerHTML = "<input>";
    f.fire(25);
    assert.equal((await pending)[0], f.doc.querySelector("input"));
    f.clean();
  },
);

test(
  "an already-satisfied removal wait resolves without a new event",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { h } = f;
    assert.equal(await h.jobsWaitForXPathRemoval("//nosuchtag"), undefined);
    f.clean();
  },
);

test(
  "text disappearance wakes a removal wait while hidden",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { doc, h } = f;
    doc.body.innerHTML = "<div><span>loading</span></div>";
    const wait = h.jobsWaitForXPathRemoval('//span[text()="loading"]');
    doc.querySelector("span").firstChild.data = "done";
    await wait;
    f.clean();
  },
);

test(
  "input events and page resume detect property-only changes with throttled timers",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { w, doc } = f;
    doc.body.innerHTML = "<input>";
    const input = doc.querySelector("input");
    const changed = w.JobsDOMWait.until(() => input.value === "saved");
    input.value = "saved";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    assert.equal(await changed, true);
    f.clean();
    const resumed = w.JobsDOMWait.until(() => input.value === "resumed");
    input.value = "resumed";
    doc.dispatchEvent(new w.Event("resume"));
    assert.equal(await resumed, true);
    f.clean();
  },
);

test(
  "fallback polling handles property changes with no DOM mutation or input event",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t);
    let ready = false;
    const pending = f.w.JobsDOMWait.until(() => ready);
    ready = true;
    f.fire(1000);
    assert.equal(await pending, true);
    f.clean();
  },
);

test(
  "aborted and invalid waits clean observers, timers and lifecycle handlers",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      controller = new f.w.AbortController();
    let reads = 0;
    const pending = f.w.JobsDOMWait.until(
      () => {
        reads++;
        return false;
      },
      { signal: controller.signal },
    );
    controller.abort();
    assert.equal(await pending, null);
    f.clean();
    const before = reads;
    f.doc.dispatchEvent(new f.w.Event("resume"));
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    f.doc.body.innerHTML = "<input>";
    await Promise.resolve();
    assert.equal(reads, before);
    await assert.rejects(f.h.jobsWaitForCssNodes("["));
    f.clean();
    assert.equal(
      await f.w.JobsDOMWait.until(
        () => {
          throw Error("must not read");
        },
        { signal: controller.signal },
      ),
      null,
    );
    f.clean();
  },
);

test(
  "shadow-root waits stay scoped and abort cleanly",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { doc, h } = f;
    const shadow = doc.body
      .appendChild(doc.createElement("div"))
      .attachShadow({ mode: "open" });
    doc.body.appendChild(doc.createElement("button"));
    const pending = h.jobsWaitForCssNodes("button", shadow);
    const button = shadow.appendChild(doc.createElement("button"));
    assert.equal((await pending)[0], button);
    f.clean();
  },
);

test(
  "Ashby dropdown waits for actual async option and committed selection with no animation frames or timers",
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t),
      { doc, w } = f;
    doc.body.innerHTML =
      '<fieldset><label class="ashby-application-form-question-title">How did you hear about us?</label><div><input role="combobox" aria-expanded="false"><button type="button">Open</button></div></fieldset>';
    const input = doc.querySelector("input"),
      toggle = doc.querySelector("button");
    let commit;
    toggle.onclick = () => {
      if (input.getAttribute("aria-expanded") === "true") {
        input.setAttribute("aria-expanded", "false");
        doc.getElementById("options")?.remove();
        return;
      }
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-controls", "options");
      w.queueMicrotask(() => {
        const popup = doc.createElement("div");
        popup.id = "options";
        popup.setAttribute("role", "listbox");
        doc.body.append(popup);
        w.queueMicrotask(() => {
          const option = doc.createElement("div");
          option.setAttribute("role", "option");
          option.textContent = "Job Board";
          option.onclick = () => {
            commit = () => {
              input.value = "Job Board";
              input.setAttribute("aria-expanded", "false");
              popup.remove();
            };
          };
          popup.append(option);
        });
      });
    };
    let finished = false;
    const filling = w.JobsControlFields.chooseSpec(
      input,
      w.JobsProfileAnswers.literalSpec("known-answer", "Job Board"),
    ).then(() => {
      finished = true;
    });
    for (let i = 0; i < 60 && !commit; i++) await Promise.resolve();
    assert.equal(typeof commit, "function");
    assert.equal(finished, false);
    // Searching may put the answer text in the input, but it is still only a
    // query: the transaction must wait for the page to commit and close.
    assert.equal(input.value, "Job Board");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    commit();
    await filling;
    assert.equal(input.value, "Job Board");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    // The scanner cache lives for the page session; operation waits must release
    // their own observers, and ending the session releases the cache observer.
    w.JobsControlFields.dispose();
    f.clean();
  },
);
