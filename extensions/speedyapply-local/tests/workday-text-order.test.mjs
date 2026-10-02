import { readModule, functionBlock } from "./helpers/module-source.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const bundle = await readModule(
  new URL("../source/content/adapters/workday.js", import.meta.url),
  "utf8",
);
const fields = await readWithDependencies(
  new URL("../src/custom/control-fields.js", import.meta.url),
  "utf8",
);
const semantics = await Promise.all(
  ["option-match", "profile-answers", "workday-controls", "form-pipeline"].map(
    (name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
  ),
);
const block = (name) => functionBlock(bundle, name);
function fixture(ids) {
  const dom = new JSDOM(ids.map((id) => `<input id="${id}">`).join(""), {
      runScripts: "outside-only",
    }),
    w = dom.window;
  w.eval(fields);
  semantics.forEach((code) => w.eval(code));
  w.eval(
    [
      "workdayFillName",
      "workdayFillAddress",
      "workdayFillContact",
      "workdayFillWebsites",
      "workdayFillSelfIdentification",
    ]
      .map(block)
      .join("\n"),
  );
  w.jobsFindXPath = () => null;
  w.jobsProfileWebsiteEntries = () => [];
  w.jobsFormatFullName = (name) =>
    [name.firstName, name.lastName].filter(Boolean).join(" ") || "Fixture Name";
  const committed = new Map(),
    early = [];
  for (const node of w.document.querySelectorAll("input")) {
    let draft = "";
    // A field can paint immediately while its framework update is pending.
    node.addEventListener("input", () => {
      const value = node.value;
      w.setTimeout(() => {
        draft = value;
      }, 0);
    });
    node.addEventListener("blur", () => {
      committed.set(node.id, draft);
      if (draft !== node.value) early.push(node.id);
    });
  }
  return { dom, w, committed, early };
}

test("actual Workday name adapter finishes each commit before focusing the next name", async () => {
  const f = fixture([
    "name--legalName--firstName",
    "name--legalName--lastName",
  ]);
  try {
    await f.w.workdayFillName({ firstName: "Fixture", lastName: "Applicant" });
    assert.deepEqual(
      f.early,
      [],
      "no field should blur before its input handler settles",
    );
    assert.deepEqual(
      [...f.committed.values()],
      ["Fixture", "Applicant"],
      "adapter completion means both names committed",
    );
  } finally {
    f.dom.window.close();
  }
});

test("actual Workday address adapter awaits its final postal-code write", async () => {
  const f = fixture([
    "address--addressLine1",
    "address--addressLine2",
    "address--city",
    "address--postalCode",
  ]);
  try {
    await f.w.workdayFillAddress({
      line1: "Fixture Street",
      line2: "Suite A",
      city: "Fixture City",
      postalCode: "12345",
    });
    assert.deepEqual(f.early, []);
    assert.deepEqual(
      [...f.committed.values()],
      ["Fixture Street", "Suite A", "Fixture City", "12345"],
    );
  } finally {
    f.dom.window.close();
  }
});

test("actual Workday contact adapter does not return before telephone blur validation", async () => {
  const f = fixture(["phoneNumber--phoneNumber"]);
  try {
    await f.w.workdayFillContact({
      email: "fixture@example.test",
      phoneNumber: "5550100100",
    });
    assert.equal(f.committed.get("phoneNumber--phoneNumber"), "5550100100");
    assert.deepEqual(f.early, []);
  } finally {
    f.dom.window.close();
  }
});

test("actual Workday website adapter commits every social URL before moving focus", async () => {
  const f = fixture(["linkedin", "github", "personal", "twitter"]);
  try {
    for (const [id, name] of [
      ["linkedin", "linkedinQuestion"],
      ["github", "githubQuestion"],
      ["personal", "personalWebsiteQuestion"],
      ["twitter", "twitterQuestion"],
    ])
      f.w.document.getElementById(id).dataset.automationId = name;
    await f.w.workdayFillWebsites({
      linkedin: "https://linkedin.test/me",
      github: "https://github.test/me",
      personal: "https://personal.test",
      twitter: "https://twitter.test/me",
    });
    assert.deepEqual(f.early, []);
    assert.equal(f.committed.size, 4);
    assert.equal(f.committed.get("linkedin"), "https://linkedin.test/me");
  } finally {
    f.dom.window.close();
  }
});

test("actual Workday self-identification commits the name before the date picker takes focus", async () => {
  const f = fixture(["name", "date"]);
  try {
    f.w.document.getElementById("name").dataset.automationId = "name";
    f.w.JobsProfileAnswers = { ...f.w.JobsProfileAnswers, eeoSpec: () => null }; // EEO choices are covered by eeo-rule.test.mjs
    await f.w.workdayFillSelfIdentification({
      languageData: [],
      nameData: {},
      employmentData: { disability: false },
    });
    assert.equal(f.committed.get("name"), "Fixture Name");
    assert.deepEqual(f.early, []);
  } finally {
    f.dom.window.close();
  }
});
