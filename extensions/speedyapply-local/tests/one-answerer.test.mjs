import { readModule } from "./helpers/module-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";

const scripts = await Promise.all(
  [
    "option-match",
    "profile-answers",
    "dom-wait",
    "control-fields",
    "form-pipeline",
    "answer-memory",
    "review-presenter",
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
function fixture(t, html, saved = []) {
  const w = new JSDOM("<form>" + html + "</form>", {
    url: "https://example.test/apply",
    runScripts: "outside-only",
  }).window;
  const profile = {
      nameData: { firstName: "Ada" },
      addressData: { country: "United States" },
      employmentData: { eligibilityUS: true },
    },
    traces = [],
    notes = [],
    calls = new Map(),
    requests = [];
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        requests.push(message);
        return {
          data: {
            answers: message.fields.map((field) => ({
              fieldId: field.fieldId,
              state: "needs_input",
              reason: "Unknown",
            })),
          },
        };
      },
    },
  };
  w.JobsDiagnostics = {
    note: (type, node, detail) => notes.push({ type, node, detail }),
    trace: (node, entry) => traces.push({ node, ...entry }),
  };
  scripts.forEach((s) => w.eval(s));
  const resolve = installAnswerResolver(w, saved),
    root = w.document.querySelector("form");
  const run = (fill) =>
    w.JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      fill,
      resolveAnswers: (items, ...rest) => {
        items.forEach((item) =>
          calls.set(item.node, (calls.get(item.node) || 0) + 1),
        );
        return resolve(items, ...rest);
      },
    });
  t.after(() => w.close());
  return { w, root, profile, traces, notes, calls, requests, run };
}
test("bindings precede one resolver visit, including newly revealed questions; optional keyword memory stays blank", async (t) => {
  const f = fixture(
    t,
    '<label>First name<input id="name" required></label><label>Are you authorized to work in the United States?<select id="auth" required><option value="">Select</option><option>Yes</option><option>No</option></select></label><label>Favorite color<input id="optional"></label>',
    [
      { keywords: ["favorite"], appearances: 1, response: "Blue" },
      {
        question: "Conditional answer",
        response: "Confirmed",
        keywords: ["conditional"],
        appearances: 1,
      },
    ],
  );
  f.root
    .querySelector("#auth")
    .addEventListener(
      "change",
      () =>
        f.root.insertAdjacentHTML(
          "beforeend",
          '<label>Conditional answer<input id="child" required></label>',
        ),
      { once: true },
    );
  assert.equal(
    await f.run(() =>
      f.w.JobsFormPipeline.bind([
        {
          name: "name",
          find: () => f.root.querySelector("#name"),
          answer: "Ada",
        },
      ]),
    ),
    true,
  );
  assert.equal(f.root.querySelector("#name").value, "Ada");
  assert.equal(f.calls.has(f.root.querySelector("#name")), false);
  assert.equal(f.root.querySelector("#child").value, "Confirmed");
  assert.equal(f.root.querySelector("#optional").value, "");
  assert([...f.calls.values()].every((count) => count === 1));
  assert.equal(f.requests.length, 0);
  for (const id of ["name", "auth", "child"])
    assert.equal(
      f.traces.filter((e) => e.node.id === id && e.result === "decided").length,
      1,
      id,
    );
  assert.equal(f.w.JobsFormPipeline.answered(f.root).size, 3);
});
test("a second deciding binding is diagnosed and blocks the run before overwriting", async (t) => {
  const f = fixture(t, '<label>Name<input id="name" required></label>');
  assert.equal(
    await f.run(() =>
      f.w.JobsFormPipeline.bind(
        ["one", "two"].map((name) => ({
          name,
          find: () => f.root.querySelector("#name"),
          answer: name,
        })),
      ),
    ),
    false,
  );
  assert.equal(f.root.querySelector("#name").value, "one");
  assert.equal(
    f.notes.filter((e) => e.type === "auto_duplicate_decider").length,
    1,
  );
});
test("unknown optional answers are never sent to AI", async (t) => {
  const f = fixture(
    t,
    "<label>Unknown optional<input></label><label>Unknown required<input required></label>",
  );
  await f.run();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    Array.from(f.requests[0].fields, (x) => x.question),
    ["Unknown required"],
  );
  assert([...f.calls.values()].every((count) => count === 1));
});

test("two aliases of one radio question cannot claim separate decision ownership", async (t) => {
  const f = fixture(
    t,
    '<fieldset><legend>Choice</legend><label><input id="a" type="radio" name="choice" value="A" required>A</label><label><input id="b" type="radio" name="choice" value="B">B</label></fieldset>',
  );
  assert.equal(
    await f.run(() =>
      f.w.JobsFormPipeline.bind(
        ["a", "b"].map((id) => ({
          name: id,
          find: () => f.root.querySelector("#" + id),
          answer: id.toUpperCase(),
        })),
      ),
    ),
    false,
  );
  assert.equal(f.root.querySelector(":checked").id, "a");
  assert.equal(
    f.notes.filter((e) => e.type === "auto_duplicate_decider").length,
    1,
  );
});

test("a binding that cannot match abstains: AI proposes an answer to confirm, the resolver is not asked again", async (t) => {
  const f = fixture(
    t,
    '<label>Degree<select required><option value="">Select</option><option>Master</option></select></label>',
  );
  await f.run(() =>
    f.w.JobsFormPipeline.bind([
      {
        name: "degree",
        find: () => f.root.querySelector("select"),
        answer: "Bachelor",
      },
    ]),
  );
  assert.equal(f.calls.size, 0);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    Array.from(f.requests[0].fields, (x) => x.question),
    ["Degree"],
  );
  assert(f.notes.some((e) => e.type === "auto_decider_abstained"));
  // The fixture's AI declines, so nothing is decided and the field stays for the person.
  assert.equal(f.traces.filter((e) => e.result === "decided").length, 0);
  assert.equal(f.root.querySelector("select").value, "");
});

test("concurrent fills run one at a time and each binding is decided by its own run", async (t) => {
  const f = fixture(
    t,
    '<label>A<input id="a"></label><label>B<input id="b"></label>',
  );
  const pipeline = f.w.JobsFormPipeline,
    one = pipeline.ledger(f.root),
    two = pipeline.ledger(f.root);
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    started = [];
  const first = pipeline.within({ root: f.root, ledger: one }, async () => {
    started.push("first");
    await gate;
    await pipeline.bind([
      { name: "a", find: () => f.root.querySelector("#a"), answer: "A" },
    ]);
  });
  const second = pipeline.within({ root: f.root, ledger: two }, async () => {
    started.push("second");
    await pipeline.bind([
      { name: "b", find: () => f.root.querySelector("#b"), answer: "B" },
    ]);
  });
  await Promise.resolve();
  assert.deepEqual(started, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.equal(one.peek(f.root.querySelector("#a")).decider, "binding:a");
  assert.equal(one.peek(f.root.querySelector("#b")), null);
  assert.equal(two.peek(f.root.querySelector("#b")).decider, "binding:b");
  assert.equal(two.peek(f.root.querySelector("#a")), null);
  assert.equal(f.root.querySelector("#a").value, "A");
  assert.equal(f.root.querySelector("#b").value, "B");
});

test("explicit review edits record user as the decider of the manual write", async (t) => {
  const f = fixture(t, "<label>Name<input required></label>"),
    pipeline = f.w.JobsFormPipeline;
  await pipeline.write(
    f.root.querySelector("input"),
    { value: "Manual" },
    {
      ledger: pipeline.ledger(f.root),
      decider: "user",
      source: "review-card",
      replace: true,
    },
  );
  assert.equal(f.root.querySelector("input").value, "Manual");
  assert.equal(f.traces.at(-1).decider, "user");
});

test("every adapter declares answers and contains no direct field writers, resolver calls or page actions", async () => {
  const fs = await import("node:fs/promises"),
    { parse } = await import("@babel/parser");
  // Writers and option transactions belong to the run (JobsFormPipeline.write);
  // which answer a question gets belongs to the resolver.
  const forbidden = new Set([
    "chooseSpec",
    "choose",
    "chooseFrom",
    "chooseMultiple",
    "chooseDate",
    "writeText",
    "writeChecked",
    "writeChoice",
    "readOptions",
  ]);
  const adapters = (
    await fs.readdir(new URL("../source/content/adapters/", import.meta.url))
  ).filter((name) => name.endsWith(".js"));
  assert(adapters.length >= 28);
  for (const file of adapters) {
    const platform = file.replace(/\.js$/, "");
    const source = await readModule(
      new URL("../source/content/adapters/" + file, import.meta.url),
      "utf8",
    );
    for (const node of parse(source, { sourceType: "module" }).program.body) {
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (value.type === "CallExpression") {
          const called = value.callee.name || value.callee.property?.name;
          assert(!forbidden.has(called), platform + ": " + called);
          assert(
            value.callee.object?.property?.name !== "JobsAnswerResolver",
            platform + ": resolver call",
          );
          // Page actions go through the one boundary, which refuses a paused queue or a cancelled run.
          if (["click", "dispatchEvent"].includes(value.callee.property?.name))
            assert.equal(
              value.callee.object?.property?.name || value.callee.object?.name,
              "JobsPageActions",
              platform + ": direct " + value.callee.property.name,
            );
          assert(
            !(
              called === "answer" &&
              value.callee.object?.property?.name === "JobsFormPipeline"
            ),
            platform + ": second rule stage",
          );
        }
        for (const child of Object.values(value))
          Array.isArray(child) ? child.forEach(visit) : visit(child);
      };
      visit(node);
    }
  }
});

test("a field revealed by an earlier binding is found by a later one in the same fill (Workday language proficiency)", async (t) => {
  const f = fixture(
    t,
    '<label>Language<select id="language" required><option value="">Select</option><option>English</option></select></label>',
  );
  f.root
    .querySelector("#language")
    .addEventListener(
      "change",
      () =>
        f.root.insertAdjacentHTML(
          "beforeend",
          '<label>Reading<select class="level" required><option value="">Select</option><option>Fluent</option></select></label><label>Writing<select class="level" required><option value="">Select</option><option>Fluent</option></select></label>',
        ),
      { once: true },
    );
  await f.run(async () => {
    const pipeline = f.w.JobsFormPipeline;
    await pipeline.bind([
      {
        name: "language",
        find: () => f.root.querySelector("#language"),
        answer: "English",
      },
    ]);
    // The adapter discovers the proficiency controls only after the language is chosen.
    const levels = [...f.root.querySelectorAll(".level")];
    await pipeline.bind(
      levels.map((level, index) => ({
        name: "level-" + index,
        find: () => level,
        answer: "Fluent",
      })),
    );
  });
  assert.deepEqual(
    [...f.root.querySelectorAll(".level")].map((node) => node.value),
    ["Fluent", "Fluent"],
  );
  assert.equal(f.requests.length, 0);
});

test("a failed binding records its error and preserves later independent bindings", async (t) => {
  const f = fixture(
    t,
    '<label>Date<input id="date" type="date" required></label><label>Name<input id="name" required></label>',
  );
  await f.run(() =>
    f.w.JobsFormPipeline.bind([
      {
        name: "date",
        find: () => f.root.querySelector("#date"),
        answer: "not-a-date",
      },
      {
        name: "name",
        find: () => f.root.querySelector("#name"),
        answer: "Ada",
      },
    ]),
  );
  assert.equal(f.root.querySelector("#name").value, "Ada");
  assert.equal(f.root.querySelector("#date").value, "");
  assert(
    f.notes.some(
      (note) =>
        note.type === "auto_binding_failed" ||
        note.type === "auto_decider_abstained",
    ),
  );
  // The failed required date is proposed by AI (declined by this fixture), not asked again by rule.
  assert.deepEqual(
    f.requests.flatMap((request) =>
      Array.from(request.fields, (x) => x.question),
    ),
    ["Date"],
  );
});

test("a remembered answer the options cannot take goes to AI once, never back to the rules", async (t) => {
  const f = fixture(
    t,
    '<label>Preferred shift<select id="shift" required><option value="">Select</option><option>Day</option><option>Night</option></select></label>',
    [
      {
        question: "Preferred shift",
        response: "Weekend",
        keywords: ["shift"],
        appearances: 1,
      },
    ],
  );
  await f.run();
  assert.equal(
    f.calls.get(f.root.querySelector("#shift")),
    1,
    "the resolver is asked once",
  );
  assert.deepEqual(
    f.requests.flatMap((request) =>
      Array.from(request.fields, (x) => x.question),
    ),
    ["Preferred shift"],
    "then AI once",
  );
});

test("a rule answer and an exact answer reach a native list through the same setter: same events, one trace each", async (t) => {
  const runs = [];
  for (const via of ["rule", "exact"]) {
    const f = fixture(
      t,
      '<label>Degree<select id="degree" required><option value="">Select</option><option value="b">Bachelor of Arts</option><option value="m">Master of Science</option></select></label>',
    );
    const select = f.root.querySelector("#degree"),
      events = [];
    for (const type of ["input", "change"])
      select.addEventListener(type, () => events.push(type));
    const answer =
      via === "rule"
        ? { specs: [f.w.JobsProfileAnswers.degreeSpec("BA")] }
        : { value: "b" };
    const result = await f.w.JobsFormPipeline.write(select, answer, {
      root: f.root,
      decider: via === "rule" ? "rule" : "ai",
    });
    assert(result.ok, via);
    assert.equal(select.value, "b");
    runs.push({
      events,
      traces: f.traces.filter(
        (entry) => entry.node === select && entry.result === "committed",
      ).length,
    });
  }
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0], { events: ["change"], traces: 1 });
});
