import { readWithDependencies } from "./helpers/runtime-source.mjs";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { successfactorsFixture } from "./helpers/successfactors-fixture.mjs";

const load = async (window, names) => {
  for (const name of names)
    window.eval(
      await readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    );
};
async function fixture(mode) {
  const dom = new JSDOM(
    `<form><div>
    <label for="preference">Preferred schedule*</label>
    <select id="preference" icimsdropdown-enabled="1" required style="display:none"><option value="-1">Select</option><option value="day">Daytime</option><option value="night">Nighttime</option></select>
    <a role="combobox" id="preference_icimsDropdown" aria-label="Preferred schedule*" aria-required="true" aria-expanded="false"></a>
    <div class="dropdown-container" id="preference_icimsDropdown_ctnr"><input aria-label="Search schedules"><ul></ul></div>
  </div></form><button id="next">Next</button>`,
    {
      url: "https://fixture.icims.com/jobs/1/candidate",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    root = doc.querySelector("form"),
    trigger = doc.querySelector("a"),
    backing = doc.querySelector("select"),
    search = doc.querySelector("input");
  const listeners = [],
    events = [],
    clicks = [],
    profile = { profileName: "Fixture" };
  let aiCalls = 0,
    navigations = 0;
  w.JobsControlConfig = { enabled: mode === "remote", observe: true };
  w.JobsDiagnostics = {
    note: (...args) => events.push(args),
    useReader() {},
    recentEvents: () => [],
  };
  w.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version_name: "fixture" }),
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          aiCalls++;
          assert.equal(
            message.fields.length,
            1,
            "Search box/backing select must not become duplicate AI questions",
          );
          assert.equal(message.fields[0].type, "combobox");
          const option = message.fields[0].options.find(
            (option) => option.label === "Daytime",
          );
          assert(option);
          return {
            data: {
              answers: [
                {
                  fieldId: message.fields[0].fieldId,
                  state: "answer",
                  value: option.value,
                  source: "profile",
                  needsConfirmation: false,
                },
              ],
            },
          };
        }
        return {};
      },
    },
  };
  trigger.onclick = () =>
    trigger.setAttribute(
      "aria-expanded",
      String(trigger.getAttribute("aria-expanded") !== "true"),
    );
  for (const [index, label] of ["Daytime", "Nighttime"].entries()) {
    const li = doc.createElement("li");
    li.id = "result-selectable_preference_" + index;
    li.setAttribute("role", "option");
    li.setAttribute("dropdown-index", String(index));
    li.title = label;
    li.textContent = label;
    li.onclick = () => {
      clicks.push(label);
      backing.value = index ? "night" : "day";
      trigger.textContent = label;
      trigger.setAttribute("aria-expanded", "false");
      search.value = "";
      backing.dispatchEvent(new w.Event("change", { bubbles: true }));
    };
    doc.querySelector("ul").append(li);
  }
  doc.querySelector("button").onclick = () => navigations++;
  await load(w, [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "icims-controls",
  ]);
  const reader = w.JobsControlFields.create(doc, () => root, { write: true });
  const inspect = () => {
    let result;
    for (const listener of listeners)
      listener(
        { type: "jobs:control-inspect" },
        { id: "test" },
        (value) => (result = value),
      );
    return result.data;
  };
  const dispatch = (message) =>
    new Promise((resolve) => {
      for (const listener of listeners)
        if (listener(message, { id: "test" }, resolve) === true) return;
    });
  return {
    w,
    doc,
    root,
    reader,
    profile,
    trigger,
    backing,
    search,
    clicks,
    events,
    inspect,
    dispatch,
    aiCalls: () => aiCalls,
    navigations: () => navigations,
    close: () => w.close(),
  };
}

test("iCIMS search text is not completion, optional blanks do not block, and populated controls cannot be refilled implicitly", async () => {
  const h = await fixture("reader");
  try {
    h.search.value = "Daytime";
    assert.equal(h.reader.scan()[0].public.filled, false);
    assert.equal(h.reader.state().ready, false);
    h.backing.required = false;
    h.trigger.setAttribute("aria-required", "false");
    h.trigger.setAttribute("aria-label", "Preferred schedule");
    h.doc.querySelector("label").textContent = "Preferred schedule";
    assert.equal(h.reader.scan()[0].public.completion, "optional-empty");
    assert.equal(h.reader.state().ready, true);
    h.backing.value = "night";
    h.trigger.textContent = "Nighttime";
    h.search.value = "";
    assert.equal(h.reader.scan()[0].raw, "Nighttime");
    await assert.rejects(
      h.reader.apply(h.reader.scan()[0], "Daytime"),
      /no longer an editable empty control/,
    );
    assert.equal(h.clicks.length, 0);
  } finally {
    h.close();
  }
});

test("a component descriptor cannot turn unknown read or requiredness into proof of completion", async () => {
  const dom = new JSDOM('<form><input id="outer"><input id="second"></form>', {
    url: "https://fixture.example/apply",
    runScripts: "outside-only",
  });
  const w = dom.window,
    doc = w.document,
    outer = doc.querySelector("#outer"),
    second = doc.querySelector("#second");
  let readable = false,
    requiredKnown = true;
  w.JobsIcimsControls = {
    find: () => [outer, second],
    isControl: (node) => node === outer || node === second,
    describe: (node) => ({
      type: "combobox",
      question: node.id,
      value: "Visible label",
      group: [outer, second],
      required: false,
      requiredKnown,
      readable,
      supported: true,
    }),
  };
  try {
    await load(w, ["control-fields"]);
    const reader = w.JobsControlFields.create(doc, () =>
      doc.querySelector("form"),
    );
    assert.equal(
      reader.scan().length,
      2,
      "A broad component group cannot hide a second canonical question",
    );
    assert.equal(reader.scan()[0].public.capabilities.read, false);
    assert.equal(reader.scan()[0].public.completion, "unreadable");
    assert.equal(reader.state().ready, false);
    readable = true;
    requiredKnown = false;
    assert.equal(reader.scan()[0].public.completion, "unknown-requiredness");
    assert.equal(reader.state().ready, false);
    requiredKnown = true;
    assert.equal(reader.state().ready, true);
  } finally {
    w.close();
  }
});

test("disabled backing widget and its internal search are excluded together", async () => {
  const h = await fixture("reader");
  try {
    h.backing.disabled = true;
    assert.equal(h.reader.scan().length, 0);
    assert.equal(h.reader.state().ready, false);
  } finally {
    h.close();
  }
});

for (const entry of ["ai", "known-answer", "remote"])
  test(`SuccessFactors ${entry} reads later pages and uses the same committed-value writer`, async () => {
    const first = Array.from(
      { length: 100 },
      (_, index) => "Schedule " + index,
    );
    const h = successfactorsFixture({
      pages: [first, ["Daytime"]],
      required: true,
      readonly: true,
      question: "Preferred schedule*",
    });
    const w = h.window,
      root = h.doc.querySelector("form"),
      profile = { profileName: "Fixture" },
      listeners = [],
      trace = [];
    let calls = 0;
    w.JobsControlConfig = { enabled: entry === "remote", observe: true };
    w.JobsDiagnostics = {
      note: (...args) => trace.push(args),
      useReader() {},
      recentEvents: () => [],
    };
    w.chrome = {
      runtime: {
        id: "test",
        getManifest: () => ({ version_name: "fixture" }),
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async (message) => {
          if (message.type === "jobs:tab-profile")
            return { data: { id: "fixture", profile } };
          if (message.type === "jobs:auto-answers") {
            calls++;
            assert.equal(message.fields.length, 1);
            assert.equal(message.fields[0].options.length, 101);
            return {
              data: {
                answers: [
                  {
                    fieldId: message.fields[0].fieldId,
                    state: "answer",
                    value: "Daytime",
                    source: "profile",
                    needsConfirmation: false,
                  },
                ],
              },
            };
          }
          return {};
        },
      },
    };
    try {
      if (entry === "remote") {
        await load(w, ["diagnostics", "operation-context", "control-content"]);
        await w.JobsPageSession.run(
          async (options) => {
            await options.getProfile();
            options.setMessage("autofill-complete");
          },
          {
            jobsAdapterId: "successfactors",
            getProfile: async () => profile,
            setMessage() {},
          },
        );
        let inspected;
        for (const listener of listeners)
          listener(
            { type: "jobs:control-inspect" },
            { id: "test" },
            (result) => (inspected = result),
          );
        const page = inspected.data;
        assert.equal(page.fields.length, 1);
        assert(page.actions.includes("fill_answers"));
        const result = await new Promise((resolve) => {
          const message = {
            type: "jobs:control-execute",
            command: {
              id: "sf-fill",
              target: { documentId: page.documentId, revision: page.revision },
              expiresAt: Date.now() + 10000,
              action: "fill_answers",
              args: {
                answers: [{ fieldId: page.fields[0].id, value: "Daytime" }],
              },
            },
          };
          for (const listener of listeners)
            if (listener(message, { id: "test" }, resolve) === true) return;
        });
        assert.equal(result.data.appliedFieldIds.length, 1);
        assert.equal(result.data.failedFieldIds.length, 0);
      } else {
        await load(w, [
          "option-match",
          "profile-answers",
          "review-presenter",
          "ai-review",
          "operation-context",
          "automatic-fill",
        ]);
        assert.equal(
          await w.JobsAutomatic.advance({
            root,
            profile,
            action: "fill",
            ...(entry === "known-answer"
              ? {
                  resolveAnswers: async () => [{ index: 0, answer: "Daytime" }],
                }
              : {}),
          }),
          true,
        );
      }
      assert.equal(calls, entry === "ai" ? 1 : 0);
      assert.equal(h.reader.scan().length, 1);
      assert.equal(h.reader.scan()[0].raw, "Daytime");
      assert.equal(h.reader.state().ready, true);
      assert.equal(h.reader.response(h.reader.scan()[0]).response, "Daytime");
      assert.equal(
        h.events.filter((event) => event === "option:click:Daytime").length,
        1,
      );
      assert(
        entry === "remote"
          ? w.JobsDiagnostics.snapshot().events.some(
              (event) => event.type === "auto_control_result",
            )
          : trace.some((event) => event[0] === "auto_control_result"),
      );
    } finally {
      h.close();
    }
  });
