import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { icimsFixture } from "./helpers/icims-fixture.mjs";
import { replayCase } from "../scripts/repro-runner.mjs";

// This reproduces the observed iCIMS split state: a populated native select,
// a visible placeholder and no State options. No applicant data is retained.
function display(h, placeholder = true) {
  const span = h.doc.createElement("span");
  span.className = "dropdown-text";
  span.innerHTML = placeholder
    ? '<span class="dropdown-placeholder">Make a Selection</span>'
    : "California";
  h.trigger.append(span);
  return span;
}
test("hidden selection with a visible placeholder stays missing in the common reader", () => {
  const h = icimsFixture({ selected: "California", required: true });
  try {
    const shown = display(h);
    const reader = h.w.JobsControlFields.create(h.doc);
    assert.equal(h.select.value, "California");
    assert.equal(h.api.value(h.trigger), "");
    const field = reader.scan().find((r) => r.node === h.trigger).public;
    assert.equal(field.filled, false);
    assert.equal(field.completion, "required-empty");
    shown.textContent = "Alabama";
    assert.equal(h.api.value(h.trigger), "");
    shown.textContent = " California ";
    assert.equal(h.api.value(h.trigger), "California");
    assert.equal(h.trace.length, 0);
  } finally {
    h.close();
  }
});
test("a populated backing select behind the placeholder is selected and verified, then left untouched", async () => {
  const h = icimsFixture({ selected: "California" });
  try {
    const shown = display(h);
    h.list
      .querySelector('[title="California"]')
      .addEventListener("click", () => {
        shown.textContent = "California";
      });
    assert.equal(await chooseAnswer(h.trigger, "California"), h.trigger);
    assert.equal(shown.textContent, "California");
    assert(h.trace.includes("option:click:California"));
    h.trace.length = 0;
    assert.equal(await chooseAnswer(h.trigger, "California"), h.trigger);
    assert.equal(
      h.trace.length,
      0,
      "A genuinely selected value remains untouched",
    );
  } finally {
    h.close();
  }
});
test("native-only writes cannot report completion; a later display reset is visible to all entrances", async () => {
  const h = icimsFixture({ selected: "California" });
  try {
    const shown = display(h);
    assert.equal(await chooseAnswer(h.trigger, "California"), null);
    assert.equal(h.api.value(h.trigger), "");
    assert(h.diagnostics.some((e) => e.detail === "selection_not_committed"));
    h.list
      .querySelector('[title="California"]')
      .addEventListener("click", () => {
        shown.textContent = "California";
      });
    assert.equal(await chooseAnswer(h.trigger, "California"), h.trigger);
    assert.equal(h.api.value(h.trigger), "California");
    shown.innerHTML =
      '<span class="dropdown-placeholder">Make a Selection</span>';
    assert.equal(h.api.value(h.trigger), "");
    assert.equal(
      h.w.JobsControlFields.create(h.doc)
        .scan()
        .find((r) => r.node === h.trigger).public.filled,
      false,
    );
  } finally {
    h.close();
  }
});

const sources = await Promise.all(
  [
    "dom-wait",
    "option-match",
    "profile-answers",
    "control-fields",
    "icims-controls",
    "form-pipeline",
    "repro-case",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const adapter = await readWithDependencies(
  new URL("../source/content/adapters/icims.js", import.meta.url),
  "utf8",
);
const html = `<form><div class="iCIMS_InfoData"><label for="country">Country</label>
<select id="country" icimsdropdown-enabled="1" hidden><option value="12781" selected>United States</option></select>
<a id="country_icimsDropdown" role="combobox" aria-required="true" aria-label="Country"><span class="dropdown-text"><span class="dropdown-placeholder">Make a Selection</span></span></a>
<div id="PersonProfileFields.AddressCountry_icimsDropdown_ctnr" class="dropdown-container"><input><ul><li title="United States" role="option" dropdown-index="0">United States</li></ul></div></div>
<div class="iCIMS_InfoData"><label for="state">State/Province</label><select id="state" icimsdropdown-enabled="1" hidden><option value="-999" selected>No states available</option></select>
<a id="state_icimsDropdown" role="combobox" aria-required="true" aria-label="State/Province"><span class="dropdown-text"><span class="dropdown-placeholder">No states available</span></span></a>
<div id="PersonProfileFields.AddressState_icimsDropdown_ctnr" class="dropdown-container"><input><ul></ul></div></div></form>`;
test("actual address adapter commits Country before State; the same fault exports as an offline case", async () => {
  const dom = new JSDOM(html, {
      url: "https://fixture.icims.com/jobs/1/candidate",
      runScripts: "outside-only",
    }),
    w = dom.window,
    doc = w.document,
    clicks = [];
  try {
    w.TextEncoder = TextEncoder;
    for (const code of sources) w.eval(code);
    const reader = w.JobsControlFields.create(doc),
      rows = reader.scan();
    assert.deepEqual(
      Array.from(rows, (r) => r.public.filled),
      [false, false],
    );
    const search = doc.querySelector(".dropdown-container input");
    assert.equal(
      await w.JobsControlFields.chooseSpec(
        search,
        w.JobsProfileAnswers.countrySpec("USA"),
      ),
      null,
      "search text is never a committed answer",
    );
    assert.equal(search.value, "");
    const report = {
      ats: "icims",
      startedAt: 1,
      events: [],
      fields: rows.map((r) => ({
        id: r.public.id,
        kind: r.public.type,
        component: r.public.component,
        required: r.public.required,
        hasValue: r.public.filled,
        invalid: r.public.invalid,
        completion: r.public.completion,
      })),
    };
    const value = w.JobsReproCase.capture({ report, rows, document: doc });
    assert.equal(value.fields.length, 2);
    for (const result of replayCase(value))
      assert.deepEqual(result.actual, result.expected);
    assert(!JSON.stringify(value).includes("12781"));
    w.jobsFindXPath = (path) =>
      doc.evaluate(path, doc, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue;
    const country = doc.getElementById("country_icimsDropdown"),
      state = doc.getElementById("state_icimsDropdown");
    doc.querySelector("li").onclick = () => {
      clicks.push("country");
      country.querySelector(".dropdown-text").textContent = "United States";
      const li = doc.createElement("li");
      li.title = "California";
      li.textContent = "California";
      li.setAttribute("role", "option");
      li.setAttribute("dropdown-index", "0");
      li.onclick = () => {
        clicks.push("state");
        doc
          .getElementById("state")
          .replaceChildren(new w.Option("California", "CA", true, true));
        state.querySelector(".dropdown-text").textContent = "California";
      };
      state.parentElement.querySelector("ul").append(li);
    };
    w.eval(adapter);
    await w.icimsFillAddress({
      country: "United States of America",
      state: "California",
    });
    assert.deepEqual(clicks, ["country", "state"]);
    assert.deepEqual(
      Array.from(reader.scan(), (r) => r.public.filled),
      [true, true],
    );
    assert.equal(
      w.JobsProfileAnswers.resolve("State/Province", {
        addressData: {
          state: "California",
          country: "United States of America",
        },
      }).answer,
      "California",
    );
  } finally {
    w.close();
  }
});
