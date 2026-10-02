import { functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";
const adapter = await readWithDependencies(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "control-fields",
    "workday-controls",
    "dom-wait",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const supplemental = await Promise.all(
  ["review-presenter", "ai-review", "operation-context", "automatic-fill"].map(
    (name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
  ),
);
const block = (name) => functionBlock(adapter, name);

function fixture(labels) {
  const dom = new JSDOM(
    '<div aria-labelledby="Education-section"><div data-automation-id="education-1"><div data-automation-id="formField-degree"><label for="degree">Degree*</label><button id="degree" name="degree" aria-haspopup="listbox" aria-required="true">Select One</button></div></div></div>',
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    button = w.document.querySelector("button");
  let opens = 0;
  w.jobsFindXPath = (x) =>
    w.document.evaluate(x, w.document, null, 9, null).singleNodeValue;
  w.jobsLowercaseXPath = (x) =>
    `translate(${x}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  button.onclick = () => {
    opens++;
    const list = w.document.createElement("ul");
    list.id = "degree-options";
    list.setAttribute("role", "listbox");
    button.setAttribute("aria-controls", list.id);
    w.document.body.append(list);
    for (const label of labels) {
      const option = w.document.createElement("li");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.onclick = () => {
        button.textContent = label;
        list.remove();
      };
      list.append(option);
    }
  };
  button.onkeydown = (e) => {
    if (e.key === "Escape")
      w.document.getElementById("degree-options")?.remove();
  };
  scripts.forEach((code) => w.eval(code));
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, opts) => until(read, { ...opts, timeout: 50 });
  w.eval(block("workdayFillEducationHistory"));
  return { w, button, opens: () => opens, close: () => w.close() };
}
const generic = [
  "Bachelor",
  "Bachelor's",
  "Bachelors",
  "Bachelor's Degree",
  "Bachelor’s Degree",
  "Bachelor Degree",
  "Bachelors Degree",
];
const specific = [
  "BA",
  "B.A.",
  "Bachelor of Arts",
  "Bachelor of Arts (B.A)",
  "Bachelor of Arts (B.A.)",
  "Bachelor of Arts (BA)",
];
const cases = [
  ...generic.map((label) => ["Bachelor of Arts", [label], label]),
  ...specific.map((label) => [
    "Bachelor of Arts",
    ["Bachelor of Science (B.S)", label],
    label,
  ]),
  ...generic.map((label) => [
    "Bachelor of Arts",
    [label, "Bachelor of Arts (B.A)"],
    "Bachelor of Arts (B.A)",
  ]),
  ...generic.map((label) => ["Bachelor's", [label, "Master"], label]),
  [
    "Bachelor of Arts",
    ["College - Bachelor's Degree"],
    "College - Bachelor's Degree",
  ],
  [
    "Bachelor's",
    ["College - Bachelor's Degree"],
    "College - Bachelor's Degree",
  ],
  ["Bachelor's", ["College - Bachelor of Science"], null],
  ["Bachelor of Arts", ["College - Bachelor of Science"], null],
  ["Bachelor of Arts", ["Bachelor of Science (B.S)"], null],
  ["Bachelor's", ["Bachelor of Arts", "Bachelor of Science"], null],
  ["Master's", ["Master's Degree"], "Master's Degree"],
  ["Associate's", ["Associate's Degree"], "Associate's Degree"],
  ["PhD", ["Doctor of Philosophy (Ph.D.)"], "Doctor of Philosophy (Ph.D.)"],
  [
    "MBA",
    ["Master of Business Administration"],
    "Master of Business Administration",
  ],
  ["Custom diploma", ["Custom diploma"], "Custom diploma"],
];
for (const [degree, labels, expected] of cases)
  test(`degree paths: ${degree} -> ${labels.join(" / ")}`, async () => {
    const h = fixture(labels);
    try {
      const api = h.w.JobsProfileAnswers,
        result = api.resolve("Degree", { educationData: [{ degree }] });
      assert.equal(
        api.select(result, labels),
        expected,
        "shared supplementary resolver",
      );
      await h.w.workdayFillEducationHistory([{ degree }]);
      assert.equal(
        h.button.textContent,
        expected || "Select One",
        "actual first-pass adapter",
      );
      assert.equal(h.opens(), 1, "one inventory read, not one popup per alias");
      assert.equal(
        h.w.JobsControlFields.create(h.w.document).scan()[0].public.filled,
        !!expected,
        "committed selection state",
      );
    } finally {
      h.close();
    }
  });
for (const labels of [
  ["Bachelor's Degree"],
  ["Bachelor", "Bachelor of Arts (B.A)"],
  ["Bachelor of Science", "Bachelor of Arts"],
])
  test(
    "automatic missing-degree loop fills without AI: " + labels.join(" / "),
    async () => {
      const h = fixture(labels),
        profile = {
          profileName: "Fixture",
          educationData: [{ degree: "Bachelor of Arts" }],
        };
      let ai = 0;
      try {
        h.w.chrome = {
          runtime: {
            sendMessage: async (message) => {
              if (message.type === "jobs:tab-profile")
                return { data: { id: "fixture", profile } };
              if (message.type === "jobs:auto-answers") {
                ai++;
                throw Error("Degree must resolve without AI");
              }
              return {};
            },
          },
        };
        supplemental.forEach((code) => h.w.eval(code));
        h.w.eval(resolverWith("[]"));
        assert.equal(
          await h.w.JobsAutomatic.advance({
            root: h.w.document.querySelector(
              '[data-automation-id="education-1"]',
            ),
            profile,
            action: "fill",
            resolveAnswers: h.w.JobsAnswerResolver.resolve,
          }),
          true,
        );
        assert.equal(
          h.button.textContent,
          h.w.JobsProfileAnswers.selectDegree("Bachelor of Arts", labels),
        );
        assert.equal(ai, 0);
        assert.equal(h.w.JobsAIReview.pending(), false);
      } finally {
        h.close();
      }
    },
  );
