import { readModule } from "./helpers/module-source.mjs";
import { installAnswerResolver } from "./helpers/answer-resolver.mjs";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { menuFixture } from "./helpers/menu-fixtures.mjs";
import { legacySelectFixture } from "./helpers/legacy-select-fixtures.mjs";
import {
  fixture as choiceFixture,
  kinds as choiceKinds,
} from "./helpers/ats-choice-fixtures.mjs";
import { tagFixture } from "./helpers/tag-fixtures.mjs";
import { icimsFixture } from "./helpers/icims-fixture.mjs";
import { successfactorsFixture } from "./helpers/successfactors-fixture.mjs";

const names = [
  "ashby-controls",
  "greenhouse-controls",
  "workday-controls",
  "icims-controls",
  "successfactors-controls",
  "menu-controls",
  "legacy-select-controls",
  "ats-choice-controls",
  "shadow-controls",
  "tag-controls",
  "disclosure-controls",
];
const modules = await Promise.all(
  names.map((name) =>
    readModule(
      new URL("../src/custom/" + name + ".js", import.meta.url),
      "utf8",
    ),
  ),
);
const shape = (reader) =>
  reader
    .scan()
    .map((row) => [
      row.node,
      row.public.question,
      row.public.type,
      row.public.component,
    ]);
const all = (window) => {
  for (const source of modules) window.eval(source);
};

test("all component modules loaded together preserve each menu and search family identity and writer", async () => {
  const cases = [
    ...["adp", "bamboohr", "dayforce"].map((kind) => () => {
      const h = menuFixture(kind);
      return {
        ...h,
        window: h.w,
        reader: h.w.JobsControlFields.create(
          h.doc,
          () => h.doc.querySelector("form"),
          { write: true },
        ),
        canonical: h.node,
        answer: "Beta",
      };
    }),
    ...[
      "pinpoint",
      "rippling",
      "rippling-legacy",
      "greenhouse",
      "rippling-location",
      "ashby",
      "lever",
      "seek",
    ].map((kind) => () => ({
      ...legacySelectFixture(kind),
      answer: "California",
    })),
    ...choiceKinds.map((kind) => async () => {
      const h = await choiceFixture(kind);
      return {
        ...h,
        window: h.w,
        canonical: h.control,
        answer: kind === "tiktok-month" ? "2027-05" : "Daytime",
      };
    }),
  ];
  for (const create of cases) {
    const h = await create();
    try {
      const before = shape(h.reader);
      all(h.window);
      assert.deepEqual(
        shape(h.reader),
        before,
        "Unrelated modules must not claim or hide " + before[0]?.[3],
      );
      const row = h.reader.scan().find((row) => row.node === h.canonical);
      assert(row);
      await h.reader.apply(row, h.answer);
      assert.equal(
        h.reader.scan().find((row) => row.node === h.canonical).public.filled,
        true,
        row.public.component,
      );
    } finally {
      h.close();
    }
  }
});

test("all modules preserve iCIMS/SF canonical fields and suppress tag editor search duplicates", async () => {
  for (const kind of ["icims", "successfactors", "seek", "ultipro"]) {
    const h =
      kind === "icims"
        ? icimsFixture()
        : kind === "successfactors"
          ? successfactorsFixture()
          : tagFixture(kind);
    const window = h.window || h.w,
      doc = h.doc;
    try {
      if (["seek", "ultipro"].includes(kind)) h.open();
      const reader = window.JobsControlFields.create(
        doc,
        () => doc.querySelector("form"),
        { write: true },
      );
      const before = shape(reader);
      all(window);
      assert.deepEqual(shape(reader), before, kind);
      const node =
        kind === "icims"
          ? h.trigger
          : kind === "successfactors"
            ? reader.scan()[0].node
            : h.editor;
      const row = reader.scan().find((row) => row.node === node);
      assert(row, kind);
      await reader.apply(
        row,
        ["seek", "ultipro"].includes(kind)
          ? ["Physics", "Python"]
          : "California",
      );
      assert.equal(
        reader.scan().find((row) => row.node === node).public.filled,
        true,
        kind,
      );
    } finally {
      h.close();
    }
  }
});

test("a custom month picker uses the Profile month without a model request or fabricated day", async () => {
  const h = await choiceFixture("tiktok-month");
  const profile = {
    profileName: "Fixture",
    educationData: [{ school: "Example University", endDate: "2027-05" }],
  };
  let calls = 0;
  h.doc.getElementById("month-end").remove();
  h.control.setAttribute(
    "aria-label",
    "What is your expected graduation month and year?*",
  );
  h.w.chrome = {
    runtime: {
      id: "fixture",
      sendMessage: async (message) => {
        if (message.type === "jobs:tab-profile")
          return { data: { id: "fixture", profile } };
        if (message.type === "jobs:auto-answers") {
          calls++;
          throw Error("Known Profile month must not reach AI");
        }
        return {};
      },
    },
  };
  try {
    all(h.w);
    for (const name of [
      "option-match",
      "profile-answers",
      "form-pipeline",
      "review-presenter",
      "ai-review",
      "operation-context",
      "automatic-fill",
    ])
      h.w.eval(
        await readModule(
          new URL("../src/custom/" + name + ".js", import.meta.url),
          "utf8",
        ),
      );
    installAnswerResolver(h.w);
    assert.equal(
      await h.w.JobsAutomatic.advance({
        root: h.root,
        profile,
        action: "fill",
      }),
      true,
    );
    assert.equal(h.reader.scan()[0].raw, "2027-05");
    assert.equal(calls, 0);
  } finally {
    h.close();
  }
});
