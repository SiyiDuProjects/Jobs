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
const questions = [
  "Are you able to perform the essential functions of the job for which you are applying, either with or without accommodation?",
  "Are you at 18 years old? (If under 18, hire is subject to verification that you are of minimum legal age.)",
  "Are you currently subject to a non-compete agreement?",
  "If hired can you present evidence of your U.S. citizenship or proof of your legal right to live and work in this country?",
  "Were you referred by a current employee? If so, who and do you have any friends or relatives working for the Allen Lund Company?",
  "Did you notice the location of the role and are you able to commute there daily?",
  "I certify that I have read and understand the applicant instructions included with this application and that the answers given by me to the foregoing questions and statements made by me are complete and true to the best of my knowledge and belief. I understand that any false information, omissions or misrepresentations of facts called for in this application, whether on this document or not, may result in rejection of my application or discharge at any time during my employment. I understand that this application form is intended for use in evaluating my qualifications for employment and that this application is not an offer of employment. I further understand that if hired, my employment will be considered at-will and that my employment may be terminated for any reason, with or without cause or notice, at any time by me or the Company and that this application is not intended to constitute a contract of continued employment.",
  "Do you have a College Degree?",
];
const select = (question, id, extra = "") =>
  `<div class="form-group"><label for="${id}">${question}*</label><select id="${id}" class="resumator-select-field" ${extra}><option value="resumator_no_selection">-- No answer --</option><option value="Yes">Yes</option><option value="No">No</option><option value="0">Zero</option></select></div>`;
function setup({
  host = "fixture.applytojob.com",
  html = questions.map((q, i) => select(q, "question-" + i)).join(""),
  answer = () => [],
} = {}) {
  const dom = new JSDOM(
    "<form>" + html + '</form><button id="submit">Submit</button>',
    {
      url: "https://" + host + "/apply/fixture/role",
      runScripts: "outside-only",
    },
  );
  const w = dom.window,
    profile = { profileName: "Fixture", employmentData: {} },
    messages = [];
  let calls = 0,
    clicks = 0;
  w.JobsControlConfig = { enabled: false, observe: true };
  w.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        calls++;
        return { data: { answers: await answer(message) } };
      },
    },
  };
  codes.forEach((code) => w.eval(code));
  w.document.querySelector("#submit").onclick = () => clicks++;
  const root = w.document.querySelector("form"),
    reader = w.JobsControlFields.create(w.document, () => root, {
      write: true,
    });
  return {
    w,
    reader,
    messages,
    calls: () => calls,
    clicks: () => clicks,
    close: () => w.close(),
    run: (options) =>
      w.JobsAutomatic.advance({
        root,
        profile,
        selector: "#submit",
        action: "fill",
        autoConfirm: false,
        setMessage: (value) => messages.push(value),
        ...options,
      }),
  };
}

for (const host of ["fixture.applytojob.com", "fixture.theresumator.com"])
  test(`JazzHR eight unanswered questions block completion on ${host}`, () => {
    const h = setup({ host });
    try {
      const state = h.reader.state();
      assert.equal(state.rows.length, 8);
      assert.equal(
        state.invalid.length,
        8,
        "long certification remains required after its display label is truncated",
      );
      assert.equal(state.ready, false);
      assert.equal(state.phase, "complete-required");
      for (const row of state.rows) {
        assert.equal(row.public.filled, false);
        assert.equal(h.w.JobsControlFields.needsAnswer(row.public), true);
        assert.equal(h.reader.response(row), null);
        assert.deepEqual(
          Array.from(row.public.options, (o) => o.value),
          ["Yes", "No", "0"],
        );
      }
    } finally {
      h.close();
    }
  });

test("JazzHR real No and zero answers are preserved, while placeholder writes are rejected", async () => {
  const h = setup({ html: select("Fixture choice", "choice") });
  try {
    await assert.rejects(
      h.reader.apply(h.reader.scan()[0], "resumator_no_selection"),
      /not committed/,
    );
    for (const value of ["No", "0"]) {
      h.w.document.querySelector("select").value = "resumator_no_selection";
      await h.reader.apply(h.reader.scan()[0], value);
      const row = h.reader.scan()[0];
      assert.equal(row.public.filled, true);
      assert.equal(h.reader.state().ready, true);
      assert.equal(
        h.reader.response(row).response,
        value === "No" ? "No" : "Zero",
      );
      await assert.rejects(
        h.reader.apply(row, "Yes"),
        /editable empty control/,
      );
    }
  } finally {
    h.close();
  }
});

test("JazzHR multiple selects discard only the unanswered sentinel", () => {
  const h = setup({ html: select("Fixture choices", "choices", "multiple") });
  try {
    const options = h.w.document.querySelector("select").options;
    options[0].selected = true;
    assert.equal(h.reader.scan()[0].public.filled, false);
    options[2].selected = true;
    options[3].selected = true;
    assert.deepEqual(Array.from(h.reader.scan()[0].raw), ["No", "0"]);
  } finally {
    h.close();
  }
});

test("JazzHR sentinel normalization does not reinterpret values on another ATS", () => {
  const h = setup({
    host: "fixture.example.com",
    html: select("Fixture choice", "choice"),
  });
  try {
    assert.equal(h.reader.scan()[0].public.filled, true);
  } finally {
    h.close();
  }
});

test("JazzHR confirmed answers fill gaps, preserve existing answers, and leave unknowns pending without submitting", async () => {
  const h = setup({
    answer: (message) => {
      assert.equal(message.fields.length, 6);
      assert(
        message.fields.every(
          (f) =>
            f.required &&
            !f.options.some((o) => o.value === "resumator_no_selection"),
        ),
      );
      return message.fields.map((f) => ({
        fieldId: f.fieldId,
        state: "needs_input",
        value: null,
        reason: "No confirmed fact",
      }));
    },
  });
  try {
    h.w.document.querySelector("#question-7").value = "No";
    assert.equal(
      await h.run({
        resolveAnswers: async (fields) => {
          assert.equal(fields.length, 7);
          return [{ index: 0, answer: "Yes", source: "profile" }];
        },
      }),
      false,
    );
    assert.equal(h.w.document.querySelector("#question-0").value, "Yes");
    assert.equal(h.w.document.querySelector("#question-7").value, "No");
    assert.equal(h.reader.state().invalid.length, 6);
    assert.equal(h.reader.state().phase, "complete-required");
    assert.equal(h.calls(), 1);
    assert.equal(h.clicks(), 0);
    assert(!h.messages.includes("page-complete"));
  } finally {
    h.close();
  }
});

test("JazzHR reaches page complete only after all fixture answers are resolved", async () => {
  const h = setup({
    html: select("Fixture choice A", "a") + select("Fixture choice B", "b"),
  });
  try {
    assert.equal(
      await h.run({
        resolveAnswers: async (fields) =>
          fields.map((_, index) => ({
            index,
            answer: "No",
            source: "profile",
          })),
      }),
      true,
    );
    assert.deepEqual(
      Array.from(h.w.document.querySelectorAll("select"), (node) => node.value),
      ["No", "No"],
    );
    assert.equal(h.reader.state().ready, true);
    assert(h.messages.includes("page-complete"));
    assert.equal(h.calls(), 0);
    assert.equal(h.clicks(), 0, "fill-only does not submit");
  } finally {
    h.close();
  }
});
