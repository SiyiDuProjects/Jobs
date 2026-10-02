import { readWithDependencies } from "./helpers/runtime-source.mjs";
// Acceptance: a wrong fill can be explained from the records alone, and one
// field gets the same answer from every entrance (first fill, supplement, AI,
// remote review).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const read = (path) =>
  readWithDependencies(new URL("../" + path, import.meta.url), "utf8");
const custom = Object.fromEntries(
  await Promise.all(
    [
      "job-match-rules",
      "job-match",
      "option-match",
      "profile-answers",
      "repro-case",
      "diagnostics",
      "dom-wait",
      "control-fields",
      "form-pipeline",
      "operation-context",
      "control-content",
    ].map(async (name) => [name, await read("src/custom/" + name + ".js")]),
  ),
);
const domControls = await read("source/content/shared/dom-controls.js");
const history = await read("src/custom/history-background.js");

function harness(html) {
  const dom = new JSDOM(
      '<form aria-labelledby="job-application-form">' + html + "</form>",
      {
        url: "https://jobs.ashbyhq.com/example/job/application",
        runScripts: "outside-only",
      },
    ),
    w = dom.window;
  w.TextEncoder = TextEncoder;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version_name: "test" }),
      sendMessage: async (message) =>
        message.type === "jobs:tab-profile"
          ? { data: { id: "ng", profile: { profileName: "Newgrad" } } }
          : {},
      onMessage: { addListener() {} },
    },
  };
  for (const name of Object.keys(custom)) w.eval(custom[name]);
  w.eval(domControls);
  const options = {
    autofillSettings: {},
    ctx: { onInvalidated() {} },
    getProfile: async () => ({ profileName: "Newgrad" }),
    setMessage() {},
  };
  async function eL(opts) {
    await opts.getProfile();
    return true;
  }
  Object.defineProperty(eL, "name", { value: "ashby" });
  return {
    w,
    doc: w.document,
    start: () =>
      w.JobsPageSession.run(eL, { ...options, jobsAdapterId: "ashby" }),
    close() {
      w.JobsDiagnostics.stop();
      dom.window.close();
    },
  };
}
const degreeSelect =
  '<label>Degree<select id="degree"><option value="">Select...</option><option value="bs">Bachelor of Science</option><option value="ba">Bachelor of Arts</option></select></label>';

test("a deliberate wrong first-pass fill is explained by its record alone, and the record reaches the retained history", async () => {
  const h = harness(degreeSelect);
  try {
    await h.start();
    // A wrong declaration: the binding names Bachelor of Science for this field.
    await h.w.JobsFormPipeline.bind([
      {
        name: "degree",
        find: "#degree",
        answer: h.w.JobsProfileAnswers.literalSpec(
          "known-answer",
          "Bachelor of Science",
        ),
      },
    ]);
    assert.equal(
      h.doc.getElementById("degree").value,
      "bs",
      "the constructed misfill happened",
    );
    const field = h.w.JobsDiagnostics.snapshot().fields.find(
      (item) => item.question === "Degree",
    );
    const record = field.traces.find(
      (item) => item.source === "binding:degree" && item.result === "committed",
    );
    // Who wrote it, what was asked, what the page offered, how it matched, what it chose.
    assert.equal(record.decider, "binding:degree");
    assert.equal(record.method, "exact");
    assert.equal(record.chosen, "Bachelor of Science");
    assert.deepEqual(
      [...record.options],
      ["Bachelor of Science", "Bachelor of Arts"],
    );
    assert.equal(field.value, "Bachelor of Science");
    // The persistent history the agent reads over SSH/MCP keeps the same evidence.
    const local = {},
      session = {};
    const c = vm.createContext({
      URL,
      TextEncoder,
      console,
      crypto: webcrypto,
      chrome: {
        storage: {
          session: {
            get: async () => structuredClone(session),
            set: async (data) => Object.assign(session, structuredClone(data)),
          },
          local: {
            get: async () => structuredClone(local),
            set: async (data) => Object.assign(local, structuredClone(data)),
          },
        },
      },
    });
    vm.runInContext(history, c);
    await c.JobsDiagnosticHistory.capture({
      ...h.w.JobsDiagnostics.snapshot(),
      pageUrl: "https://jobs.ashbyhq.com/example/job/application",
    });
    const kept = (
      await c.JobsDiagnosticHistory.pending(300000)
    ).items[0].snapshots
      .at(-1)
      .fields.find((item) => item.question === "Degree");
    assert.match(kept.value, /^synthetic-/);
    assert.equal(kept.trace.source, "binding:degree");
    assert.equal(kept.trace.chosen, kept.value);
    assert.equal(kept.trace.options[0], kept.value);
    assert.notEqual(kept.trace.options[1], kept.value);
  } finally {
    h.close();
  }
});

test("the shared rule gives the same degree from the first fill, the supplement and an exact AI or remote value", async () => {
  const lists = [
    ["Select...", "Bachelor of Science", "Bachelor of Arts"],
    ["Select...", "Bachelor's Degree", "Master's Degree"],
    [
      "Select...",
      "College - Bachelor of Arts",
      "College - Bachelor of Science",
    ],
    ["Select...", "Bachelor of Science (B.S)", "Bachelor of Arts (B.A)"],
  ];
  for (const profileDegree of ["Bachelor of Arts", "Bachelor's"])
    for (const labels of lists) {
      const html =
        '<label>Degree<select id="degree">' +
        labels
          .map(
            (label, i) =>
              `<option value="${i ? "v" + i : ""}">${label}</option>`,
          )
          .join("") +
        "</select></label>";
      const first = harness(html);
      let adapter;
      try {
        await first.w.JobsControlFields.chooseSpec(
          first.doc.getElementById("degree"),
          first.w.JobsProfileAnswers.degreeSpec(profileDegree),
        );
        const chosen = first.doc.getElementById("degree").selectedOptions[0];
        adapter = chosen?.value ? chosen.text : "";
      } finally {
        first.close();
      }
      // Supplement: the Profile decision over the same visible options.
      const second = harness(html);
      let supplement;
      try {
        const w = second.w;
        supplement =
          w.JobsProfileAnswers.select(
            w.JobsProfileAnswers.resolve("Degree", {
              educationData: [{ degree: profileDegree }],
            }),
            labels.slice(1),
          ) || "";
        // AI and remote review commit an exact option through the same writer.
        if (supplement) {
          const reader = w.JobsControlFields.create(
            second.doc,
            () => second.doc.querySelector("form"),
            { write: true },
          );
          const row = reader
            .scan()
            .find((item) => item.public.question === "Degree");
          await reader.apply(
            row,
            row.public.options.find((option) => option.label === supplement)
              .value,
            () => true,
            { source: "remote" },
          );
          assert.equal(
            second.doc.getElementById("degree").selectedOptions[0].text,
            supplement,
          );
        }
      } finally {
        second.close();
      }
      assert.equal(
        adapter,
        supplement,
        `${profileDegree} over ${labels.slice(1).join(" / ")}`,
      );
      // A generic Bachelor's never becomes a Bachelor of Science on any entrance.
      if (profileDegree === "Bachelor's")
        assert(!/science|b\.s/i.test(adapter), adapter);
    }
});
