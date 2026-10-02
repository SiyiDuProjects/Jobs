import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";

const codes = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "workday-controls",
    "ai-review",
    "operation-context",
    "automatic-fill",
  ].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const question = "Please indicate your expected graduation date.";
function setup({
  value = ["", "", ""],
  required = true,
  invalid = false,
  accept = true,
  normalize = false,
  partialBlur = false,
  url = "https://fixture.myworkdayjobs.com/en-US/apply",
} = {}) {
  const dom = new JSDOM(
    `<main><div data-automation-id="formField-graduation"><fieldset><legend><div data-automation-id="richText">${question}${required ? '<abbr title="required">*</abbr>' : ""}</div></legend><div role="group" data-automation-id="dateInputWrapper" id="date">${["Month", "Day", "Year"].map((part, i) => `<input role="spinbutton" aria-label="${part}" data-automation-id="dateSection${part}-input" value="${value[i]}" ${invalid ? 'aria-invalid="true"' : ""}>`).join("")}<div role="button" aria-label="Calendar">Calendar</div></div>${invalid ? '<p data-automation-id="inputAlert">Required date missing</p>' : ""}</fieldset></div><label>Existing answer<input id="keep" value="Keep"></label></main><button id="next">Save and Continue</button>`,
    {
      url: "https://fixture.myworkdayjobs.com/en-US/apply",
      runScripts: "outside-only",
    },
  );
  dom.reconfigure({ url });
  const w = dom.window,
    root = w.document.querySelector("main"),
    profile = { educationData: [{ endDate: "2027-05" }] },
    phases = [],
    requests = [];
  let view,
    act,
    clicks = 0,
    committed = "";
  w.JobsReviewPresenter = {
    show: (data, action) => {
      view = data;
      act = action;
    },
  };
  w.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        requests.push(message);
        throw Error("No model call is allowed for missing date precision");
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  const parts = [...root.querySelectorAll('[role="spinbutton"]')],
    draft = [...value];
  parts.forEach((part, i) => {
    part.addEventListener("input", () => {
      const value = part.value;
      w.setTimeout(() => {
        draft[i] = normalize && value ? String(Number(value)) : value;
        part.value = draft[i];
      }, 0);
    });
    part.addEventListener("focusout", (event) => {
      if (partialBlur && parts.includes(event.relatedTarget)) return;
      const date = w.JobsControlFields.calendarDate(
        `${draft[0]}/${draft[1]}/${draft[2]}`,
      );
      if (date && accept) {
        committed = date.iso;
        parts.forEach((node) => node.removeAttribute("aria-invalid"));
        root.querySelector('[data-automation-id="inputAlert"]')?.remove();
      }
      // Sonos commits the whole date on leaving the group. Committing only
      // the month resets the controlled date to an incomplete year-only value.
      else if (partialBlur && draft[0] && !draft[1] && !draft[2]) {
        draft.splice(0, 3, "", "", String(2000 + Number(draft[0])));
        parts.forEach((node, index) => {
          node.value = draft[index];
        });
      }
    });
  });
  w.document.querySelector("#next").onclick = () => clicks++;
  const reader = w.JobsControlFields.create(w.document, () => root, {
    write: true,
  });
  return {
    w,
    root,
    profile,
    parts,
    reader,
    phases,
    requests,
    view: () => view,
    act: (...args) => act(...args),
    clicks: () => clicks,
    committed: () => committed,
    run: (resolveAnswers) =>
      w.JobsAutomatic.advance({
        root,
        profile,
        action: "next",
        selector: "#next",
        resolveAnswers,
        setMessage: (phase) => phases.push(phase),
      }),
    close: () => w.close(),
  };
}

test("segmented Workday date is one required date question with child errors, stable identity and no Month/Day/Year questions", () => {
  const h = setup({ invalid: true });
  try {
    const rows = h.reader.scan(),
      date = rows[0];
    assert.equal(rows.length, 2);
    assert.equal(date.public.question, question + "*");
    assert.equal(date.public.type, "date");
    assert.equal(date.public.required, true);
    assert.equal(date.public.filled, false);
    assert.equal(date.public.invalid, true);
    assert.equal(date.group.length, 3);
    assert.equal(date.node.id, "date");
    assert.equal(h.reader.scan()[0].public.id, date.public.id);
    assert.equal(h.reader.state().ready, false);
  } finally {
    h.close();
  }
});

test("complete dates read as ISO; partial, impossible and optional blank dates preserve their meaning", () => {
  for (const [value, required, filled, invalid, raw] of [
    [["05", "19", "2027"], true, true, false, "2027-05-19"],
    [["05", "", "2027"], true, true, true, "05/__/2027"],
    [["02", "29", "2027"], true, true, true, "02/29/2027"],
    [["", "", ""], false, false, false, ""],
  ]) {
    const h = setup({ value, required });
    try {
      const row = h.reader.scan()[0];
      assert.equal(row.raw, raw);
      assert.equal(row.public.filled, filled);
      assert.equal(row.public.invalid, invalid);
      if (invalid) assert.equal(h.reader.response(row), null);
      if (!required)
        assert.equal(h.w.JobsControlFields.needsAnswer(row.public), false);
      if (raw === "2027-05-19")
        assert.equal(h.reader.response(row).response, raw);
    } finally {
      h.close();
    }
  }
});

test("writes all leap-day segments before the final blur commit and waits for validation", async () => {
  const h = setup({ invalid: true });
  try {
    await h.reader.apply(h.reader.scan()[0], "02/29/2028");
    assert.equal(h.committed(), "2028-02-29");
    assert.equal(h.reader.response(h.reader.scan()[0]).response, "2028-02-29");
    assert.equal(h.reader.state().ready, true);
    assert.equal(h.root.querySelector("#keep").value, "Keep");
  } finally {
    h.close();
  }
});

test("Workday accepts numerically equal unpadded month and day values", async () => {
  const h = setup({ normalize: true });
  try {
    await h.reader.apply(h.reader.scan()[0], "2030-05-09");
    assert.equal(h.committed(), "2030-05-09");
    assert.deepEqual(
      h.parts.map((part) => part.value),
      ["5", "9", "2030"],
    );
    assert.equal(h.reader.state().ready, true);
  } finally {
    h.close();
  }
});

test("Sonos-style date commits only after all segments are filled, including a year-only recovery", async () => {
  for (const normalize of [false, true])
    for (const value of [
      ["", "", ""],
      ["", "", "2009"],
    ]) {
      const h = setup({ value, normalize, partialBlur: true });
      try {
        await h.reader.apply(h.reader.scan()[0], "2030-09-23", () => true, {
          replace: true,
        });
        assert.equal(h.committed(), "2030-09-23");
        assert.equal(
          h.reader.response(h.reader.scan()[0]).response,
          "2030-09-23",
        );
        assert.equal(h.reader.state().ready, true);
      } finally {
        h.close();
      }
    }
});

test("date segment equivalence rejects changed numbers and malformed readbacks; ordinary text stays exact", async () => {
  for (const actual of ["10", "9.0", ""]) {
    const h = setup();
    try {
      h.parts[0].addEventListener("input", () =>
        h.w.setTimeout(() => {
          h.parts[0].value = actual;
        }, 0),
      );
      await assert.rejects(
        h.reader.apply(h.reader.scan()[0], "2030-09-23"),
        /已变化或未接受/,
      );
      assert.equal(h.parts[1].value, "");
      assert.equal(h.parts[2].value, "");
    } finally {
      h.close();
    }
  }
  const h = setup();
  try {
    const input = h.root.querySelector("#keep");
    input.addEventListener("input", () =>
      h.w.setTimeout(() => {
        input.value = input.value.trim();
      }, 0),
    );
    assert.equal(await h.w.JobsControlFields.writeText(input, " test "), null);
  } finally {
    h.close();
  }
});

test("rejects missing precision, impossible dates, partial overwrites and disabled segments before writing", async () => {
  for (const value of [
    "2027-05",
    "May 2027",
    "2027-02-29",
    "2027-04-31",
    "2027-13-01",
  ]) {
    const h = setup();
    try {
      await assert.rejects(
        h.reader.apply(h.reader.scan()[0], value),
        /完整、有效/,
      );
      assert(h.parts.every((part) => part.value === ""));
    } finally {
      h.close();
    }
  }
  for (const mode of ["partial", "disabled"]) {
    const h = setup({
      value: mode === "partial" ? ["05", "", "2027"] : ["", "", ""],
    });
    try {
      if (mode === "disabled") h.parts[1].disabled = true;
      const before = h.parts.map((part) => part.value);
      await assert.rejects(h.reader.apply(h.reader.scan()[0], "2027-05-19"));
      assert.deepEqual(
        h.parts.map((part) => part.value),
        before,
      );
    } finally {
      h.close();
    }
  }
});

test("replacement during date entry cancels the remaining writes; persistent errors never count as acceptance", async () => {
  const h = setup();
  try {
    h.parts[0].addEventListener(
      "input",
      () => h.parts[1].replaceWith(h.parts[1].cloneNode(true)),
      { once: true },
    );
    await assert.rejects(
      h.reader.apply(h.reader.scan()[0], "2027-05-19"),
      /已变化/,
    );
    assert.equal(h.reader.scan()[0].group[1].value, "");
    assert.equal(h.parts[2].value, "");
  } finally {
    h.close();
  }
  const bad = setup({ invalid: true, accept: false });
  try {
    await assert.rejects(
      bad.reader.apply(bad.reader.scan()[0], "2027-05-19"),
      /尚未接受/,
    );
    assert.equal(bad.reader.state().ready, false);
  } finally {
    bad.close();
  }
});

test("known complete date resolves as one question, preserves existing answers and continues exactly once", async () => {
  const h = setup({ invalid: true });
  try {
    let asked;
    const result = await h.run(async (fields) => {
      asked = fields;
      return [{ index: 0, answer: "05/19/2027" }];
    });
    assert.equal(result, true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].question, question + "*");
    assert.equal(h.requests.length, 0);
    assert.equal(h.clicks(), 1);
    assert.equal(h.committed(), "2027-05-19");
    assert.equal(h.root.querySelector("#keep").value, "Keep");
    assert.equal(h.phases.at(-1), "awaiting-transition");
  } finally {
    h.close();
  }
});

test("month-only answer goes to one date editor without guessing or AI; user answer commits and confirmation continues once", async () => {
  const h = setup({ invalid: true });
  try {
    assert.equal(
      await h.run(async () => [{ index: 0, answer: "May 2027" }]),
      false,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.clicks(), 0);
    assert(h.parts.every((part) => part.value === ""));
    const view = h.view();
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].editor.inputType, "date");
    assert.equal(view.items[0].originalQuestion, question + "*");
    const result = await h.act("answer", view.items[0].id, {
      value: "2027-05-19",
      version: view.items[0].editor.version,
    });
    assert.equal(result.ok, true);
    assert.equal(h.committed(), "2027-05-19");
    assert.equal(h.clicks(), 0);
    assert.equal(await h.w.JobsAIReview.confirm(), true);
    assert.equal(h.clicks(), 1);
    assert.equal(h.requests.length, 0);
  } finally {
    h.close();
  }
});

test("date grouping stays Workday-only and does not consume the existing month/year education adapter", () => {
  const h = setup();
  try {
    h.parts[1].remove();
    const rows = h.reader.scan();
    assert.equal(rows.length, 3);
    assert(rows.every((row) => !row.dateParts));
  } finally {
    h.close();
  }
  const other = setup({ url: "https://example.test/apply" });
  try {
    const rows = other.reader.scan();
    assert.equal(rows.length, 4);
    assert(rows.every((row) => !row.dateParts));
  } finally {
    other.close();
  }
});
