import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { replayCase, readerModules } from "../scripts/repro-runner.mjs";
import { importCase } from "../scripts/repro-case.mjs";
import { pathToFileURL } from "node:url";
const sources = await Promise.all(
  readerModules.map((n) =>
    readModule(new URL("../src/custom/" + n + ".js", import.meta.url), "utf8"),
  ),
);
function fixture(
  html,
  url = "https://job-boards.greenhouse.io/example/jobs/123?token=secret",
  prepare = () => {},
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" }),
    w = dom.window;
  w.TextEncoder = TextEncoder;
  for (const source of sources) w.eval(source);
  prepare(w);
  const rows = w.JobsControlFields.create(w.document).scan();
  const report = {
    ats: "greenhouse",
    startedAt: 1,
    fields: rows.map((r) => ({
      id: r.public.id,
      kind: r.public.type,
      component: r.public.component,
      required: r.public.required,
      hasValue: r.public.filled,
      invalid: r.public.invalid,
      completion: w.JobsControlFields.completion(r.public),
    })),
    events: [
      { at: 2, type: "build_info", detail: '{"build":"0123456789abcdef"}' },
    ],
  };
  return {
    dom,
    w,
    rows,
    report,
    capture: () =>
      w.JobsReproCase.capture({ report, rows, document: w.document }),
  };
}
test("cases retain real component structure and states with synthetic text and values, without page actions", () => {
  const h = fixture(
    '<form><div class="field"><label for="email">Private Person email</label><input id="email" type="email" value="private@example.com" required aria-invalid="true"><input type="password" value="DoNotExport"><button onclick="alert(1)">Submit private name</button><a href="https://secret.invalid">Private link</a></div></form>',
  );
  try {
    let events = 0;
    h.w.document.addEventListener("click", () => events++);
    h.w.document.addEventListener("input", () => events++);
    const value = h.capture(),
      serialized = JSON.stringify(value);
    h.w.JobsReproCase.validate(value);
    for (const secret of [
      "private@example.com",
      "Private Person",
      "DoNotExport",
      "secret.invalid",
      "onclick",
      "token=secret",
      "Submit private",
    ])
      assert(!serialized.includes(secret), secret);
    assert.equal(events, 0);
    assert.equal(
      h.w.document.querySelector("input").value,
      "private@example.com",
    );
    assert.equal(value.build, "0123456789abcdef");
    for (const row of replayCase(value))
      assert.deepEqual(row.actual, row.expected);
  } finally {
    h.dom.window.close();
  }
});
test("native invalid state survives synthetic answer replacement", () => {
  const h = fixture(
    '<div class="field"><label>Email<input type="email" value="not-an-email"></label></div>',
  );
  try {
    const value = h.capture();
    assert(value.fields[0].observed.invalid);
    for (const r of replayCase(value)) assert.deepEqual(r.actual, r.expected);
  } finally {
    h.dom.window.close();
  }
});
test("Greenhouse pending search, selected pills and linked portal remain distinct", () => {
  for (const selected of [false, true]) {
    const h = fixture(
      `<div class="field"><div class="select"><label for="school--0">School*</label><div class="select__value-container">${selected ? '<div class="select__single-value">Private University</div>' : ""}<input class="select__input" id="school--0" role="combobox" aria-required="true" aria-invalid="true" aria-controls="portal" value="private search"></div></div></div><div id="portal" role="listbox"><div role="option">Private University</div></div>`,
    );
    try {
      const value = h.capture();
      assert.equal(value.fields[0].observed.hasValue, selected);
      assert.equal(value.fields[0].portals.length, 1);
      for (const r of replayCase(value)) assert.deepEqual(r.actual, r.expected);
    } finally {
      h.dom.window.close();
    }
  }
});
test("Workday exclusive checkbox group and prompt search preserve component state", () => {
  const h = fixture(
    '<form><fieldset data-automation-id="disability-CheckboxGroup"><legend>Please check one of the boxes below:*</legend><label><input name="private-group" type="checkbox" aria-required="true">Private choice one</label><label><input name="private-group" type="checkbox" aria-required="true">Private choice two</label></fieldset><div data-automation-id="formField"><label for="skills">Skills</label><div data-automation-id="multiSelectContainer"><input id="skills" data-uxi-widget-type="selectinput" aria-required="true" value="private query"></div></div></form>',
    "https://example.myworkdayjobs.com/en-US/job/123",
  );
  try {
    const value = h.capture();
    assert.equal(value.fields.length, 2);
    assert.equal(value.fields[0].observed.kind, "radio");
    for (const r of replayCase(value)) assert.deepEqual(r.actual, r.expected);
  } finally {
    h.dom.window.close();
  }
});
test("open shadow roots and bounded truncation are explicit", () => {
  const h = fixture(
    "<form><fixture-host></fixture-host></form>",
    "https://fixture.invalid",
    (w) => {
      w.document
        .querySelector("fixture-host")
        .attachShadow({ mode: "open" }).innerHTML =
        "<label>Name<input required></label>";
    },
  );
  try {
    const input = h.w.document
      .querySelector("fixture-host")
      .shadowRoot.querySelector("input");
    h.rows.push({ node: input, public: { id: "shadow" } });
    h.report.fields.push({
      id: "shadow",
      kind: "text",
      component: "text",
      required: true,
      hasValue: false,
      invalid: true,
      completion: "invalid",
    });
    const value = h.capture();
    assert(value.fields[0].tree.shadow.length);
    h.w.JobsReproCase.validate(value);
  } finally {
    h.dom.window.close();
  }
  const many = fixture(
    '<form><div class="field"><label>Name<input required></label>' +
      Array.from({ length: 1000 }, () => "<span>Private</span>").join("") +
      "</div></form>",
  );
  try {
    const value = many.capture();
    assert(value.coverage.truncated);
    assert(value.coverage.nodes <= 900);
    many.w.JobsReproCase.validate(value);
  } finally {
    many.dom.window.close();
  }
});
test("required native selections preserve selected state and option relationships without original choices", () => {
  const h = fixture(
    '<form><div class="field"><label for="s">Private school</label><select id="s" required aria-invalid="true"><option value="">Select...</option><option selected value="private-university">Private University</option></select></div></form>',
  );
  try {
    const value = h.capture();
    assert(!JSON.stringify(value).includes("private-university"));
    assert(!JSON.stringify(value).includes("Private University"));
    for (const row of replayCase(value))
      assert.deepEqual(row.actual, row.expected);
  } finally {
    h.dom.window.close();
  }
});
test("inert fixture validation rejects executable attributes and unbounded trees", () => {
  const h = fixture("<form><label>Summary<input required></label></form>");
  try {
    const value = h.capture();
    value.fields[0].tree.attrs.onclick = "steal()";
    assert.throws(() => h.w.JobsReproCase.validate(value), /Unsafe/);
    delete value.fields[0].tree.attrs.onclick;
    value.origin = "javascript:alert(1)";
    assert.throws(() => h.w.JobsReproCase.validate(value), /origin/);
  } finally {
    h.dom.window.close();
  }
});
test("case import verifies observations, refuses mismatches and never overwrites a saved case", async () => {
  const directory = await fs.mkdtemp(
      new URL("../.qa/repro-import-", import.meta.url),
    ),
    url = pathToFileURL(directory + "/");
  const h = fixture(
    '<div class="field"><label>Summary<input required></label></div>',
  );
  try {
    const value = JSON.parse(JSON.stringify(h.capture()));
    const file = await importCase(value, "native-required", url);
    assert.deepEqual(JSON.parse(await readModule(file, "utf8")), value);
    await assert.rejects(importCase(value, "native-required", url), /EEXIST/);
    value.fields[0].observed.hasValue = true;
    await assert.rejects(
      importCase(value, "mismatch", url),
      /does not reproduce/,
    );
    assert.deepEqual(await fs.readdir(directory), ["native-required.json"]);
    await assert.rejects(importCase(value, "../escape", url), /Case name/);
  } finally {
    h.dom.window.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
