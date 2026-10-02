import { chooseAnswer } from "./helpers/choose-answer.mjs";
import { readWithDependencies } from "./helpers/runtime-source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { fixture } from "./helpers/ats-choice-fixtures.mjs";

const memoryCode = (
  await Promise.all(
    ["job-match-rules", "job-match", "answer-memory"].map((name) =>
      readWithDependencies(
        new URL("../src/custom/" + name + ".js", import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
function observe(h) {
  const records = [],
    handlers = {};
  const add = h.doc.addEventListener.bind(h.doc);
  h.doc.addEventListener = (type, listener, ...rest) => {
    handlers[type] = listener;
    return add(type, listener, ...rest);
  };
  h.w.eval(memoryCode);
  const memory = h.w.JobsAnswerMemory.start(
    h.doc,
    true,
    (rows) => {
      records.push(...JSON.parse(JSON.stringify(rows)));
      return Promise.resolve();
    },
    () => h.root,
  );
  return { records, handlers, memory };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("automatic component multiselect does not learn intermediate or final answers before review", async () => {
  const h = await fixture("eightfold-choice", { multi: true });
  try {
    h.w.history.replaceState(null, "", "/careers?pid=123");
    const { records, memory } = observe(h),
      row = h.reader.scan()[0];
    assert.equal(row.public.type, "select-multiple");
    await h.reader.apply(row, ["Daytime", "Nighttime"]);
    memory.flush();
    await settle();
    assert.deepEqual(
      records,
      [],
      "native trusted input/change from programmatic clicks are not user answers",
    );
    memory.remember(row.public.question, h.control, { requireReview: true });
    memory.flush();
    await settle();
    assert.deepEqual(records, []);
    memory.confirmReview([h.control]);
    await settle();
    assert.deepEqual(records, [
      {
        question: row.public.question,
        response: "Daytime; Nighttime",
        jobKey: h.w.JobsJobMatch.key(h.w.location.href),
      },
    ]);
  } finally {
    h.close();
  }
});

test("manual component multiselect still learns the committed complete selection", async () => {
  const h = await fixture("eightfold-choice", { multi: true });
  try {
    const { records, handlers } = observe(h);
    for (const input of h.control.querySelectorAll("input")) {
      handlers.pointerdown({
        type: "pointerdown",
        isTrusted: true,
        target: input,
      });
      input.click();
      await settle();
    }
    assert.equal(records.length, 2);
    assert.equal(records[0].response, "Daytime");
    assert.equal(records[1].response, "Daytime; Nighttime");
    assert.deepEqual(Array.from(h.reader.scan()[0].raw), [
      "Daytime",
      "Nighttime",
    ]);
  } finally {
    h.close();
  }
});

const workdayCode = await Promise.all(
  ["dom-wait", "control-fields", "workday-controls"].map((name) =>
    readWithDependencies(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
function workdayFixture(exclusive) {
  const question = exclusive
    ? "Please choose one option"
    : "Select all relevant options";
  const dom = new JSDOM(
    `<form data-automation-id="ApplyFlowPage"><fieldset id="control" data-automation-id="${exclusive ? "disabilityStatus" : "ethnicityMulti"}-CheckboxGroup" aria-required="true"><legend>${question}</legend>${["First choice", "Second choice"].map((label, index) => `<div role="cell"><input type="checkbox" id="choice-${index}"><label for="choice-${index}">${label}</label></div>`).join("")}</fieldset></form>`,
    {
      url: "https://fixture.myworkdayjobs.com/apply",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    doc = w.document,
    root = doc.querySelector("form"),
    control = doc.getElementById("control");
  for (const code of workdayCode) w.eval(code);
  return {
    w,
    doc,
    root,
    control,
    reader: w.JobsControlFields.create(doc, () => root, { write: true }),
    close: () => w.close(),
  };
}

for (const exclusive of [false, true]) {
  test(`Workday ${exclusive ? "exclusive" : "multiple"} checkbox label forwarding from automatic writes requires user intent before memory capture`, async () => {
    const h = workdayFixture(exclusive);
    try {
      const { records, memory } = observe(h),
        row = h.reader.scan()[0],
        forwarded = [];
      h.doc.addEventListener("click", (event) => {
        if (event.target.matches('input[type="checkbox"]'))
          forwarded.push(event.isTrusted);
      });
      assert.equal(
        row.public.type,
        exclusive ? "custom-radio" : "select-multiple",
      );
      await h.reader.apply(
        row,
        exclusive ? "First choice" : ["First choice", "Second choice"],
      );
      memory.flush();
      await settle();
      assert(
        forwarded.includes(true),
        "real label.click() forwards a native trusted input click in this fixture",
      );
      assert.deepEqual(
        records,
        [],
        "automatic shared writer must not learn a label-forwarded trusted click",
      );
      for (const input of h.control.querySelectorAll("input"))
        input.checked = false;
      await chooseAnswer(h.control, "First choice");
      if (!exclusive)
        await chooseAnswer(h.control, ["First choice", "Second choice"], {
          replace: true,
        });
      memory.flush();
      await settle();
      assert.deepEqual(
        records,
        [],
        "the component writer must not learn either the intermediate or final answer",
      );
      const final = h.reader.scan()[0];
      assert.equal(final.public.completion, "filled");
      assert.equal(
        h.reader.response(final).response,
        exclusive ? "First choice" : "First choice; Second choice",
      );
    } finally {
      h.close();
    }
  });

  test(`Workday ${exclusive ? "exclusive" : "multiple"} checkbox manual pointer intent and real label clicks capture the complete answer`, async () => {
    const h = workdayFixture(exclusive);
    try {
      const { records, handlers, memory } = observe(h),
        labels = [...h.control.querySelectorAll("label")];
      for (const label of exclusive ? labels.slice(0, 1) : labels) {
        handlers.pointerdown({
          type: "pointerdown",
          isTrusted: true,
          target: label,
        });
        label.click();
        await settle();
      }
      memory.flush();
      await settle();
      assert(records.length > 0);
      assert.equal(records[0].response, "First choice");
      assert.equal(
        records.at(-1).response,
        exclusive ? "First choice" : "First choice; Second choice",
      );
      assert.equal(records.at(-1).question, h.reader.scan()[0].public.question);
      assert.equal(h.reader.scan()[0].public.completion, "filled");
    } finally {
      h.close();
    }
  });
}
