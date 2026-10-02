import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { resolverWith } from "./helpers/answer-resolver.mjs";

const source = await readWithDependencies(
  new URL("../source/content/adapters/comeet.js", import.meta.url),
  "utf8",
);
const modules = await Promise.all(
  [
    "dom-wait",
    "control-fields",
    "disclosure-controls",
    "option-match",
    "profile-answers",
    "form-pipeline",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function fixture({ evidence = "aria", commit = true, duplicate = false } = {}) {
  const groups = {
    Gender: ["Male", "Female", "Prefer not to say"],
    Ethnicity: ["Asian", "White", "Prefer not to say"],
    Veteran: [
      "I identify as a veteran",
      "I am not a veteran",
      "Prefer not to say",
    ],
    Disability: [
      "Yes, I have a disability",
      "No, I do not have a disability",
      "Prefer not to say",
    ],
  };
  if (duplicate) groups.Gender.push("Female");
  const html = Object.entries(groups)
    .map(
      ([name, labels]) =>
        `<section><div><legend>${name}</legend></div><div><ul id="${name}">${labels
          .map(
            (label, index) =>
              `<li><div ${evidence === "aria" ? 'role="radio" aria-checked="false"' : ""}>${label}${evidence === "native" ? `<input type="radio" name="${name}" value="${index}">` : ""}</div></li>`,
          )
          .join("")}</ul></div></section>`,
    )
    .join("");
  const dom = new JSDOM('<form id="applyForm">' + html + "</form>", {
    url: "https://www.comeet.co/jobs/fixture/apply",
    runScripts: "outside-only",
  });
  const w = dom.window,
    doc = w.document,
    trace = [],
    diagnostics = [];
  for (const code of modules) w.eval(code);
  const until = w.JobsDOMWait.until;
  w.JobsDOMWait.until = (read, opts) => until(read, { ...opts, timeout: 70 });
  w.JobsDiagnostics = {
    note: (type, node, detail) => diagnostics.push({ type, detail }),
  };
  for (const option of doc.querySelectorAll("ul > li > div"))
    option.addEventListener("click", (event) => {
      if (event.target.matches("input")) return;
      trace.push(option.closest("ul").id + ":" + option.firstChild.textContent);
      if (!commit) return;
      if (evidence === "aria") {
        option
          .closest("ul")
          .querySelectorAll("[aria-checked]")
          .forEach((node) => node.setAttribute("aria-checked", "false"));
        option.setAttribute("aria-checked", "true");
      } else if (evidence === "native") option.querySelector("input").click();
    });
  const find = (xpath) =>
    doc.evaluate(xpath, doc, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue;
  const findAll = (xpath) => {
    const found = doc.evaluate(
      xpath,
      doc,
      null,
      w.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: found.snapshotLength }, (_, index) =>
      found.snapshotItem(index),
    );
  };
  const click = (xpath) => {
    const node = find(xpath);
    node?.click();
    return node;
  };
  Object.assign(w, {
    jobsFindXPath: find,
    jobsFindAllXPath: findAll,
    jobsClick: click,
  });
  w.eval(resolverWith("[]"));
  w.eval(source);
  return {
    w,
    doc,
    trace,
    diagnostics,
    api: w.JobsDisclosureControls,
    close: () => w.close(),
  };
}

test("Comeet bindings answer gender, ethnicity and disability from the Profile; veteran status is the rules'", async () => {
  for (const [employment, expected] of [
    [
      {
        gender: "Female",
        ethnicity: "Asian",
        veteran: false,
        disability: false,
      },
      [
        "Gender:Female",
        "Ethnicity:Asian",
        "Disability:No, I do not have a disability",
      ],
    ],
    // Explicit empty gender/race choices carry the nondisclosure preference; missing facts stay unanswered.
    [
      { gender: "", ethnicity: "", veteran: undefined, disability: undefined },
      ["Gender:Prefer not to say", "Ethnicity:Prefer not to say"],
    ],
    [
      { gender: "Male", ethnicity: "White", veteran: true, disability: true },
      ["Gender:Male", "Ethnicity:White", "Disability:Yes, I have a disability"],
    ],
  ]) {
    const h = fixture();
    try {
      await h.w.comeetFillDisclosures(employment);
      assert.deepEqual(h.trace, expected);
    } finally {
      h.close();
    }
  }
});

test("Comeet public scanner discovers one row per list and shares strict option/value writes", async () => {
  const h = fixture();
  try {
    const reader = h.w.JobsControlFields.create(h.doc, () => h.doc, {
      write: true,
    });
    let rows = reader.scan();
    assert.equal(rows.length, 4);
    const row = rows.find((row) => row.public.question === "Gender");
    assert.equal(row.public.supported, true);
    assert.equal(row.public.requiredKnown, false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(await reader.readOptions(row))),
      [
        { value: "Male", label: "Male" },
        { value: "Female", label: "Female" },
        { value: "Prefer not to say", label: "Prefer not to say" },
      ],
    );
    await reader.apply(row, "Female");
    rows = reader.scan();
    assert.equal(
      rows.find((row) => row.public.question === "Gender").raw,
      "Female",
    );
    assert.deepEqual(h.trace, ["Gender:Female"]);
  } finally {
    h.close();
  }
});

test("a browser-trusted native backing radio change from our own click is accepted", async () => {
  const h = fixture({ evidence: "native" });
  try {
    const events = [];
    h.doc
      .getElementById("Gender")
      .addEventListener("change", (event) => events.push(event.isTrusted));
    assert.equal(
      await chooseAnswer(h.doc.getElementById("Gender"), "Female"),
      h.doc.getElementById("Gender"),
    );
    assert.deepEqual(events, [true]);
    assert.equal(
      h.api.describe(h.doc.getElementById("Gender")).commitState,
      "confirmed",
    );
    assert.equal(h.api.value(h.doc.getElementById("Gender")), "Female");
  } finally {
    h.close();
  }
});

test("without selected-state evidence a click stays unconfirmed and is not repeated", async () => {
  const strict = fixture({ evidence: "none" });
  try {
    assert.equal(
      await chooseAnswer(strict.doc.getElementById("Gender"), "Female"),
      null,
    );
    assert.equal(
      strict.api.describe(strict.doc.getElementById("Gender")).commitState,
      "unconfirmed",
    );
    assert.equal(
      await chooseAnswer(strict.doc.getElementById("Gender"), "Female"),
      null,
    );
    assert.deepEqual(
      strict.trace,
      ["Gender:Female"],
      "Unconfirmed attempts must not be repeatedly clicked",
    );
    const descriptor = strict.api.describe(strict.doc.getElementById("Gender"));
    assert.equal(descriptor.value, "");
    assert.equal(descriptor.readable, false);
  } finally {
    strict.close();
  }
});

test("duplicate, hidden and neighbouring disclosure candidates are not guessed; optional markers stay explicit", async () => {
  const h = fixture({ duplicate: true });
  try {
    const gender = h.doc.getElementById("Gender");
    assert.equal(await chooseAnswer(gender, "Female"), null);
    assert.equal(h.trace.length, 0);
    gender.lastElementChild.hidden = true;
    assert.equal(await chooseAnswer(gender, "Female"), gender);
    assert.deepEqual(h.trace, ["Gender:Female"]);
    gender.parentElement.previousElementSibling.firstElementChild.textContent =
      "Gender (optional)";
    assert.equal(h.api.describe(gender).requiredKnown, true);
    assert.equal(h.api.describe(gender).required, false);
  } finally {
    h.close();
  }
});

test("late concrete selected-state evidence clears the earlier unconfirmed attempt", async () => {
  const h = fixture({ commit: false });
  try {
    const gender = h.doc.getElementById("Gender");
    assert.equal(await chooseAnswer(gender, "Female"), null);
    assert.equal(h.api.describe(gender).commitState, "unconfirmed");
    [...gender.querySelectorAll("[aria-checked]")]
      .find((node) => node.textContent === "Female")
      .setAttribute("aria-checked", "true");
    assert.equal(h.api.describe(gender).commitState, "confirmed");
    assert.equal(h.api.value(gender), "Female");
  } finally {
    h.close();
  }
});
