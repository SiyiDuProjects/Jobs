import { chooseAnswer } from "./helpers/choose-answer.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { legacySelectFixture as fixture } from "./helpers/legacy-select-fixtures.mjs";
const plain = (value) => JSON.parse(JSON.stringify(value));
// Every widget kind the legacy-select component reads.
const kinds = [
  "pinpoint",
  "rippling",
  "rippling-legacy",
  "greenhouse",
  "greenhouse-location",
  "rippling-location",
  "ashby",
  "lever",
  "seek",
];

test("a preexisting collapsed flag is not commit evidence and a failed click is not refilled blindly", async () => {
  const f = fixture("rippling", { options: ["California"], committed: false });
  try {
    f.canonical.setAttribute("aria-expanded", "false");
    assert.equal(
      await chooseAnswer(f.canonical, "California", { timeout: 35 }),
      null,
    );
    const row = f.reader.scan().find((row) => row.node === f.canonical);
    assert.equal(row.public.filled, false);
    assert.equal(row.public.completion, "unconfirmed");
    assert.equal(f.window.JobsControlFields.needsAnswer(row.public), false);
    assert.equal(f.reader.response(row), null);
    await assert.rejects(
      f.reader.apply(row, "California"),
      /no longer an editable empty control/,
    );
  } finally {
    f.close();
  }
});

test("strict search cannot select a hidden stale candidate", async () => {
  const f = fixture("rippling", { options: ["California"] });
  try {
    f.doc.addEventListener("input", () =>
      f.doc.querySelectorAll("li").forEach((option) => {
        option.hidden = true;
      }),
    );
    assert.equal(
      await chooseAnswer(f.canonical, "California", { timeout: 35 }),
      null,
    );
    assert.equal(f.controls.value(f.canonical), "");
    assert.equal(
      f.events.some((event) => event.startsWith("option:")),
      false,
    );
  } finally {
    f.close();
  }
});

test("migrated Select2 does not press Enter for a missing or partial school result", async () => {
  for (const options of [["No matches found"], ["California College"]]) {
    const f = fixture("greenhouse", { options });
    try {
      assert.equal(
        await f.controls.chooseFrom(
          f.canonical,
          (labels) =>
            f.window.JobsOptionMatch.pick(
              labels,
              f.window.JobsProfileAnswers.schoolSpec("California"),
            )?.label,
          { query: "California", timeout: 20 },
        ),
        null,
      );
      assert.equal(
        f.events.some((event) => event.endsWith(":Enter")),
        false,
      );
    } finally {
      f.close();
    }
  }
});

for (const kind of ["greenhouse", "greenhouse-location", "ashby"])
  test(
    kind + " declaration searches once and commits the shared exact identity",
    async () => {
      const label =
        kind === "greenhouse"
          ? "University of California - Berkeley"
          : "Boston, Massachusetts, United States";
      const f = fixture(kind, { options: ["Wrong result", label] });
      try {
        const api = f.window.JobsProfileAnswers,
          spec =
            kind === "greenhouse"
              ? api.schoolSpec("University of California, Berkeley")
              : api.locationSpec({
                  city: "Boston",
                  state: "Massachusetts",
                  country: "United States",
                });
        assert(
          await f.window.JobsFormPipeline.bind([
            { name: kind, find: () => f.canonical, answer: spec },
          ]),
        );
        assert.equal(f.controls.value(f.canonical), label);
        assert.equal(
          f.events.filter(
            (event) =>
              event ===
              (kind === "greenhouse" ? "search:input" : "input:input"),
          ).length,
          1,
        );
      } finally {
        f.close();
      }
    },
  );

test("common reader sees every family once and strict writer selects exact unique candidates", async () => {
  for (const kind of kinds) {
    const f = fixture(kind);
    try {
      let rows = f.reader.scan();
      assert.equal(rows.length, 1, kind);
      assert.equal(rows[0].public.type, "combobox", kind);
      assert.equal(rows[0].public.required, true, kind);
      const options = await f.reader.readOptions(rows[0], () => true, {
        answer: "California",
      });
      assert.deepEqual(
        plain(options).map((option) => option.label),
        ["California North", "California"],
        kind,
      );
      rows = f.reader.scan();
      assert.equal(rows.length, 1, kind + " after search");
      assert.equal(
        rows[0].public.filled,
        false,
        kind + " query is not selection",
      );
      await f.reader.apply(rows[0], "California");
      assert.equal(f.input.value, "California", kind);
      assert.equal(f.reader.scan()[0].public.filled, true, kind);
      assert.equal(f.reader.state().ready, true, kind);
    } finally {
      f.close();
    }
  }
});

test("bare queries are not committed; selected labels are read without clicking", () => {
  for (const kind of kinds) {
    const f = fixture(kind, { initial: "California" });
    try {
      assert.equal(f.controls.value(f.canonical), "", kind);
      assert.equal(f.reader.scan()[0].public.filled, false, kind);
      assert.deepEqual(f.events, []);
    } finally {
      f.close();
    }
  }
  for (const kind of ["pinpoint", "rippling-legacy", "greenhouse"]) {
    const f = fixture(kind, { preselected: "California" });
    try {
      assert.equal(f.controls.value(f.canonical), "California");
      assert.equal(f.reader.scan()[0].public.filled, true);
      assert.deepEqual(f.events, []);
    } finally {
      f.close();
    }
  }
});

test("AI and remote require exact unique options and actual committed state", async () => {
  for (const kind of kinds) {
    for (const config of [
      { options: ["California North"], answer: "California" },
      { options: ["California", "California"], answer: "California" },
      { options: ["California"], answer: "California", committed: false },
    ]) {
      const f = fixture(kind, config);
      try {
        assert.equal(
          await chooseAnswer(f.canonical, config.answer, { timeout: 25 }),
          null,
          kind,
        );
        assert.equal(f.reader.scan()[0].public.filled, false, kind);
      } finally {
        f.close();
      }
    }
  }
});

test("ordinary optional versus unknown requiredness stay separate for new family descriptors", () => {
  for (const required of [false, undefined]) {
    const f = fixture("rippling");
    try {
      required === undefined
        ? f.input.removeAttribute("aria-required")
        : f.input.setAttribute("aria-required", "false");
      const row = f.reader.scan()[0];
      assert.equal(row.public.requiredKnown, required !== undefined);
      assert.equal(f.reader.state().ready, required === false);
    } finally {
      f.close();
    }
  }
});

test("later candidate arrival cannot write after cancellation, replacement or human edits", async () => {
  for (const change of ["cancel", "replace", "edit"]) {
    const f = fixture("ashby", { delay: 25 });
    let allowed = true;
    try {
      const pending = chooseAnswer(f.canonical, "California", {
        timeout: 60,
        canProceed: () => allowed,
      });
      await new Promise((resolve) => f.window.setTimeout(resolve, 5));
      if (change === "cancel") allowed = false;
      if (change === "replace") f.input.replaceWith(f.input.cloneNode());
      if (change === "edit") {
        f.input.value = "User edit";
        f.input.dispatchEvent(new f.window.Event("input", { bubbles: true }));
      }
      assert.equal(await pending, null);
      assert.equal(
        f.events.some((event) => /^option:.*:click$/.test(event)),
        false,
      );
    } finally {
      f.close();
    }
  }
});
