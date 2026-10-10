import test from "node:test";
import assert from "node:assert/strict";
import { captureCorpus } from "../src/custom/corpus-case.js";
import { recordCorpusOptions } from "../src/custom/corpus-observations.js";
import { readerWindow } from "../scripts/corpus-runner.mjs";
import { replayCorpusFlow } from "../scripts/corpus-flow.mjs";

const profile = {
  profileName: "Synthetic",
  nameData: { firstName: "Example" },
  contactData: { email: "example@example.test" },
  employmentData: { gender: "Female" },
};
const bound = { id: "synthetic", lastSync: "2026-01-01T00:00:00Z" };
function capture(
  html,
  url = "https://fixture.invalid/apply",
  record = () => {},
) {
  const dom = readerWindow(html, url);
  try {
    const reader = dom.window.JobsControlFields.create(dom.window.document);
    record(reader.scan());
    return captureCorpus({
      root: dom.window.document.querySelector("form"),
      rows: reader.scan(),
      platform: url.includes("myworkdayjobs") ? "workday" : "other",
    });
  } finally {
    dom.window.close();
  }
}
function answer(request, value = "Fixture answer") {
  return {
    answers: request.fields.map((field) => ({
      fieldId: field.fieldId,
      kind: "answer",
      value,
      questionZh: "测试问题",
      answerZh: "测试回答",
      reasonZh: "虚构资料",
      source: "ai",
      binding: { profileId: bound.id, profileVersion: bound.lastSync, field },
    })),
  };
}
test("snapshot flow fills local fields first and sends actual remaining fields plus formContext", async () => {
  const page = capture(
    "<form><label>First name<input required></label><label>Email<input required></label><label>Why this role?<textarea required></textarea></label></form>",
  );
  const calls = [];
  const result = await replayCorpusFlow({
    page,
    profile,
    bound,
    generate: async (request) => {
      calls.push(request);
      return answer(request);
    },
  });
  assert.equal(calls.length, 1, JSON.stringify(result));
  assert.deepEqual(
    calls[0].fields.map((field) => field.question),
    ["Why this role?"],
  );
  assert(
    calls[0].formContext.some(
      (row) => row.question === "First name" && row.answer === "Example",
    ),
  );
  assert.equal(
    result.fields.filter((field) => field.stage === "local").length,
    2,
  );
  assert.equal(
    result.fields.find((field) => field.stage === "server").readback,
    "Fixture answer",
  );
  assert.equal(result.liveATSVerified, false);
});
test("recorded Workday dropdown participates in actual local pipeline without provider call", async () => {
  const page = capture(
    '<form><div data-automation-id="formField-gender"><label for="g">Gender</label><button id="g" aria-haspopup="listbox" aria-label="Gender Required">Select One</button></div></form>',
    "https://example.myworkdayjobs.com/apply",
    (rows) => recordCorpusOptions(rows[0].node, ["Female", "Male"]),
  );
  const result = await replayCorpusFlow({
    page,
    profile,
    bound,
    generate: async () => {
      throw Error("Local rule should answer");
    },
  });
  assert.equal(result.requests.length, 0, JSON.stringify(result));
  assert.equal(result.fields[0].readback, "Female", JSON.stringify(result));
  assert.equal(result.fields[0].transport, "recorded_control");
});
test("remaining Workday choice uses recorded IDs through request preparation and writer", async () => {
  const page = capture(
    '<form><div data-automation-id="formField-choice"><label for="q">Preferred arrangement</label><button id="q" aria-haspopup="listbox" aria-label="Preferred arrangement Required">Select One</button></div></form>',
    "https://example.myworkdayjobs.com/apply",
    (rows) => recordCorpusOptions(rows[0].node, ["A", "B"]),
  );
  const result = await replayCorpusFlow({
    page,
    profile,
    bound,
    generate: async (request) => {
      assert.deepEqual(
        request.fields[0].options.map((option) => option.label),
        ["A", "B"],
      );
      return answer(request, request.fields[0].options[1].value);
    },
  });
  assert.equal(result.fields[0].readback, "B", JSON.stringify(result));
  assert.equal(result.fields[0].written, true);
});

function searchPage(recording) {
  return capture(
    '<form><div data-automation-id="formField-school"><label for="s">School</label><div data-automation-id="multiSelectContainer"><input id="s" data-uxi-widget-type="selectinput" aria-required="true"><ul data-automation-id="selectedItemList"></ul></div></div></form>',
    "https://example.myworkdayjobs.com/apply",
    (rows) => {
      if (recording)
        recordCorpusOptions(
          rows[0].node,
          ["Example University"],
          "Example University",
        );
    },
  );
}
test("unrecorded search is a gap even when the provider supplies a plausible label", async () => {
  const result = await replayCorpusFlow({
    page: searchPage(false),
    profile,
    bound,
    generate: async (request) => answer(request, "Example University"),
  });
  assert.equal(result.fields[0].written, false);
  assert.equal(result.fields[0].readback, null);
  assert(result.gaps.some((gap) => gap.reason === "unrecorded_search"));
});
test("recorded search can keep only a label from the exact recorded query", async () => {
  const result = await replayCorpusFlow({
    page: searchPage(true),
    profile,
    bound,
    generate: async (request) => answer(request, "Example University"),
  });
  assert.equal(
    result.fields[0].readback,
    "Example University",
    JSON.stringify(result),
  );
  assert.equal(result.fields[0].written, true);
});
test("damaged labels and changed snapshot semantics are excluded before any model request", async () => {
  for (const damage of ["redacted", "semantics"]) {
    const page = capture(
      "<form><label>First name<input required></label></form>",
    );
    if (damage === "redacted") page.fields[0].question = "[private]";
    else
      page.trees[0].children[0].children[1].attrs["aria-label"] += " Required";
    const result = await replayCorpusFlow({
      page,
      profile,
      bound,
      generate: async () => {
        throw Error("Damaged snapshots cannot be scored");
      },
    });
    assert.equal(result.excluded, true);
    assert.equal(result.requests.length, 0);
  }
});

test("snapshot native select does not invent a first-option answer as form context", async () => {
  const page = capture(
    '<form><label>Preferred arrangement<select required><option value="a">A</option><option value="b">B</option></select></label><label>Explain<textarea required></textarea></label></form>',
  );
  const result = await replayCorpusFlow({
    page,
    profile,
    bound,
    generate: async (request) => {
      assert.equal(request.fields.length, 2);
      assert.equal(
        request.formContext.find(
          (row) => row.question === "Preferred arrangement",
        ).answer,
        "",
      );
      return {
        answers: request.fields.map((field) => ({
          ...answer(
            { ...request, fields: [field] },
            field.options?.[0]?.value || "Fixture explanation",
          ).answers[0],
        })),
      };
    },
  });
  assert.equal(result.fields[0].readback, "A");
  assert.equal(result.fields[0].written, true);
});

test("fast scanner report also excludes redaction damage and labels its narrower scope", async () => {
  const { corpusReport } = await import("../scripts/corpus-runner.mjs");
  const page = capture("<form><label>First name<input></label></form>");
  page.fields[0].question = "[private]";
  const report = corpusReport({ pages: [{ id: "damaged", page }] });
  assert.equal(report.summary.pages, 0);
  assert.equal(report.summary.excludedPages, 1);
  assert.equal(report.summary.unanswered, 0);
  assert.equal(report.evaluationScope, "scanner_and_rule_projection");
});
