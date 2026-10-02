import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";

const codes = await Promise.all(
  ["dom-wait", "control-fields", "option-match", "profile-answers"].map(
    (name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
  ),
);
const profile = {
  nameData: { firstName: "Example", lastName: "Applicant" },
  employmentData: { veteran: false },
};
// Reduced from Cotiviti's nested IForm DOM. No standard labels surround these
// radios: the text is a sibling of each iCIMS wrapper, separated by BRs.
function setup({
  hostname = "tenant.icims.com",
  title = "VOLUNTARY SELF-IDENTIFICATION OF VETERAN STATUS",
  name = "Example Applicant",
} = {}) {
  const choices = [
    [
      "ProtectedVeteran",
      "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE",
    ],
    ["NotProtectedVeteran", "I AM NOT A PROTECTED VETERAN"],
    ["optout", "I DON'T WISH TO ANSWER"],
  ];
  const dom = new JSDOM(
    `<form><h1>${title}</h1><span>Instructions<br><br>${choices.map(([value, label]) => `<span class="iCIMS_Forms_RadioGroup iCIMS_Forms_QVeteran customFieldContainer"><input type="radio" name="icims_f_Veteran" id="icims_f_Veteran_${value}" value="${value}" aria-required="true" i_required="true"></span> ${label}<br><br>`).join("")}</span><input id="icims_f_Name" aria-label="Name" value="${name}"><span><input type="checkbox" class="iCIMS_Forms_Qsignature" id="icims_f_signature" aria-label="Signature" aria-required="true"></span><button type="submit">Submit</button></form>`,
    { url: `https://${hostname}/forms`, runScripts: "outside-only" },
  );
  const w = dom.window,
    doc = w.document,
    root = doc.querySelector("form");
  w.chrome = { runtime: { sendMessage: async () => ({ data: [] }) } };
  for (const code of codes) w.eval(code);
  w.eval(resolverWith("[]"));
  const reader = w.JobsControlFields.create(doc, () => root, { write: true });
  const resolve = async (p = profile) => {
    const decisions = [];
    const rows = reader
      .scan()
      .filter((row) => w.JobsControlFields.needsAnswer(row.public));
    const result = await w.JobsAnswerResolver.resolve(
      rows.map((row) => ({
        ...row.public,
        node: row.node,
        options: (row.public.options || []).map((option) => option.label),
      })),
      p,
      { root, onDecision: (d) => decisions.push(d) },
    );
    return { rows, result, decisions };
  };
  return { w, doc, root, reader, resolve, close: () => w.close() };
}

test("IForm captions produce one supported required veteran group and a boolean signature answer", async () => {
  const h = setup();
  try {
    let submits = 0;
    h.root.addEventListener("submit", (event) => {
      event.preventDefault();
      submits++;
    });
    const { rows, result } = await h.resolve();
    assert.deepEqual(
      Array.from(rows, (row) => [
        row.public.question,
        row.public.type,
        row.public.supported,
      ]),
      [
        ["Protected veteran status", "radio", true],
        ["Signature", "checkbox", true],
      ],
    );
    assert.deepEqual(
      Array.from(rows[0].public.options, (option) => option.label),
      [
        "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE",
        "I AM NOT A PROTECTED VETERAN",
        "I DON'T WISH TO ANSWER",
      ],
    );
    assert.deepEqual(
      Array.from(result, (item) => item.answer),
      ["I AM NOT A PROTECTED VETERAN", "Yes"],
    );
    for (const item of result) {
      const row = rows[item.index];
      const value =
        row.public.type === "checkbox"
          ? item.answer === "Yes"
          : row.public.options.find((option) => option.label === item.answer)
              .value;
      await h.reader.apply(row, value, () => true);
    }
    assert.equal(
      h.doc.querySelector("#icims_f_Veteran_NotProtectedVeteran").checked,
      true,
    );
    assert.equal(h.doc.querySelector("#icims_f_signature").checked, true);
    assert.equal(
      h.doc.querySelector("#icims_f_Name").value,
      "Example Applicant",
    );
    assert.equal(
      h.reader
        .scan()
        .filter((row) => h.w.JobsControlFields.needsAnswer(row.public)).length,
      0,
    );
    assert.equal(submits, 0);
    assert.equal(
      (await h.resolve()).result.length,
      0,
      "a second pass leaves filled answers alone",
    );
  } finally {
    h.close();
  }
});

test("protected veteran choices respect nondisclosure and do not infer protected status from veteran Yes", async () => {
  const h = setup();
  try {
    for (const [value, expected] of [
      ["undisclosed", "I DON'T WISH TO ANSWER"],
      [true, undefined],
      [undefined, undefined],
    ]) {
      const { result, decisions } = await h.resolve({
        ...profile,
        employmentData: { veteran: value },
      });
      assert.equal(
        result.find((answer) => answer.index === 0)?.answer,
        expected,
      );
      if (!expected) assert.equal(decisions[0].status, "needs-input");
    }
  } finally {
    h.close();
  }
});

test("signature checkbox mapping requires the identified voluntary IForm and the matching entered name", async () => {
  for (const config of [
    { hostname: "other.example" },
    { title: "Employment Agreement" },
    { name: "Different Person" },
    { name: "" },
  ]) {
    const h = setup(config);
    try {
      const { decisions } = await h.resolve();
      const decision = decisions.find(
        (item) => item.field === "nameData.fullName",
      );
      assert.equal(decision.status, "needs-input");
      assert.equal(decision.reason, "signature_requires_input");
      assert.equal(h.doc.querySelector("#icims_f_signature").checked, false);
    } finally {
      h.close();
    }
  }
  const h = setup();
  try {
    const value = h.w.JobsProfileAnswers.resolve("Signature", profile, {
      type: "text",
    });
    assert.equal(
      value.answer,
      "Example Applicant",
      "text signatures retain the full name",
    );
  } finally {
    h.close();
  }
});

test("IForm fallback does not borrow the next option caption when a caption is missing", () => {
  const h = setup();
  try {
    h.doc.querySelector(
      "#icims_f_Veteran_ProtectedVeteran",
    ).parentElement.nextSibling.textContent = "";
    const row = h.reader.scan().find((row) => row.public.type === "radio");
    assert.equal(row.public.options[0].label, "");
    assert.equal(row.public.supported, false);
  } finally {
    h.close();
  }
});
