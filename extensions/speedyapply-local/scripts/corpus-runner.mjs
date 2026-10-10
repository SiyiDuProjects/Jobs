import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readerSource } from "./repro-runner.mjs";
import { mountCorpus, captureCorpus } from "../src/custom/corpus-case.js";

export const syntheticProfiles = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/jobs-radar/jobs_radar/corpus-identities.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
export const corpusQuestionKey = (field) =>
  hash({
    question: field.question,
    description: field.description || "",
    type: field.type,
    required: field.required,
    options: field.options.map((option) => option.label),
  });
export function replaySearch(observations, query, choose) {
  const recording = observations.find((item) => item.query === query);
  if (!recording) return { status: "unrecorded", answer: null };
  const answer = choose(recording.options);
  if (answer != null && !recording.options.includes(answer))
    return { status: "invalid-option", answer: null };
  return {
    status: answer == null ? "no-match" : "recorded",
    answer: answer ?? null,
  };
}
export function readerWindow(html = "", url = "https://fixture.invalid") {
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.CSS = {
    escape: (value) =>
      String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c),
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = () => {
    throw Error("Network is disabled during corpus replay");
  };
  w.eval(readerSource);
  return dom;
}

export function seedCorpus() {
  const questions = [
    "Are you legally authorized to work in the United States?",
    "Will you require sponsorship in the future?",
    "Will you be able to work without future sponsorship?",
    "Are you at least 18 years old?",
    "Gender",
    "Graduation Date",
  ];
  return ["greenhouse", "workday", "ashby"].map((platform) => {
    const hostname = {
      greenhouse: "job-boards.greenhouse.io",
      workday: "example.myworkdayjobs.com",
      ashby: "jobs.ashbyhq.com",
    }[platform];
    const html =
      "<form>" +
      questions
        .map(
          (question, i) =>
            `<div class="field" data-automation-id="formField"><label for="q${i}">${question}</label>${question === "Graduation Date" ? `<input id="q${i}" type="date">` : `<select id="q${i}" required><option value="">Select one</option>${(question === "Gender" ? ["Male", "Female", "Prefer not to disclose"] : ["Yes", "No"]).map((label, index) => `<option value="${index}">${label}</option>`).join("")}</select>`}</div>`,
        )
        .join("") +
      "</form>";
    const dom = readerWindow(html, `https://${hostname}/example`);
    try {
      const w = dom.window;
      const page = captureCorpus({
        root: w.document.querySelector("form"),
        rows: w.JobsControlFields.create(w.document).scan(),
        profile: {},
        platform,
        build: "synthetic",
        company: "Example",
        step: "questions",
      });
      return { id: hash(page), page };
    } finally {
      dom.window.close();
    }
  });
}

// Private replay data contains synthetic identities only. Revisions and page scope
// must match; generated answers never act as independent gold labels.
export function cachedCorpusAnswers(corpus) {
  const revision = corpus.aiRevision;
  const answers = new Map();
  if (!revision?.promptHash || !revision?.model) return answers;
  for (const row of corpus.aiAnswers || []) {
    const profile = syntheticProfiles.find((p) => p.id === row.identity);
    if (
      !profile ||
      row.profileHash !== hash(profile) ||
      row.promptHash !== revision.promptHash ||
      row.model !== revision.model
    )
      continue;
    answers.set([row.pageId, row.questionId, row.identity].join(":"), row);
  }
  return answers;
}

export function replayCorpusPage(page, profiles = syntheticProfiles) {
  const url =
    page.platform === "workday"
      ? "https://example.myworkdayjobs.com/example"
      : page.platform === "greenhouse"
        ? "https://job-boards.greenhouse.io/example"
        : "https://fixture.invalid";
  const dom = readerWindow("", url);
  try {
    const w = dom.window;
    mountCorpus(w.document, page);
    const reader = w.JobsControlFields.create(w.document),
      rows = reader.scan();
    const targets = [];
    function visit(root) {
      targets.push(...root.querySelectorAll("[data-jobs-corpus-field]"));
      for (const node of root.querySelectorAll("*"))
        if (node.shadowRoot) visit(node.shadowRoot);
    }
    visit(w.document);
    const fields = page.fields.map((field) => {
      const target = targets.find(
        (node) => node.getAttribute("data-jobs-corpus-field") === field.id,
      );
      const matches = rows.filter(
        (row) =>
          row.node === target ||
          row.group?.includes(target) ||
          row.node.contains(target),
      );
      const row = matches.length === 1 ? matches[0] : null;
      const actual = row
        ? {
            question: row.public.question,
            description: row.description || "",
            type: row.public.type,
            required: row.public.required,
            options: row.public.options?.length
              ? row.public.options
                  .filter((option) => option.value && option.label)
                  .map((option) => option.label)
              : field.observations.findLast((item) => !item.query)?.options ||
                [],
          }
        : null;
      const answers = profiles.map((profile) => {
        if (!row)
          return { identity: profile.id, answer: null, route: "unrecognized" };
        const context = {
          ...row.public,
          description: row.description,
          options: actual.options,
        };
        const result = w.JobsProfileAnswers.resolve(
          row.public.question,
          profile,
          context,
        );
        if (
          (row.public.type === "search-choice" ||
            (row.public.type === "combobox" && !actual.options.length)) &&
          result?.answer
        ) {
          const replay = replaySearch(
            field.observations,
            result.optionSpec?.query || result.answer,
            (labels) => w.JobsProfileAnswers.select(result, labels),
          );
          return {
            identity: profile.id,
            answer: replay.answer,
            route: result.field || "search",
            search: replay.status,
          };
        }
        const answer = actual.options.length
          ? w.JobsProfileAnswers.select(result, context.options)
          : (result?.answer ?? null);
        return {
          identity: profile.id,
          answer: answer ?? null,
          route: result?.field || "unknown",
        };
      });
      return {
        key: corpusQuestionKey(field),
        captured: { question: field.question, type: field.type },
        actual,
        meaningMatches:
          !!actual &&
          corpusQuestionKey({
            ...actual,
            options: actual.options.map((label) => ({ label })),
          }) === corpusQuestionKey(field),
        answers,
        searches: field.observations.map((observation) => ({
          query: observation.query,
          options: observation.options,
        })),
      };
    });
    return {
      fields,
      missedControls: reader.unrecognized(rows).length,
      truncated: !!page.coverage?.truncated,
    };
  } finally {
    dom.window.close();
  }
}

export function corpusReport(corpus, previous = null) {
  const pages = corpus.pages.map(({ id, page }) => ({
    id,
    ...replayCorpusPage(page),
  }));
  const results = pages.flatMap((page) => page.fields);
  const cached = cachedCorpusAnswers(corpus);
  const captured = new Map(
    corpus.pages
      .flatMap(({ page }) => page.fields)
      .map((field) => [corpusQuestionKey(field), field]),
  );
  let missingAI = 0;
  for (const page of pages)
    for (const field of page.fields) {
      if (!field.meaningMatches) continue;
      field.answers = field.answers.map((local) => {
        if (local.answer != null) return local;
        const stored = cached.get(
          [page.id, field.key, local.identity].join(":"),
        );
        if (!stored) {
          missingAI++;
          return { ...local, route: "uncached_ai" };
        }
        return {
          ...local,
          answer:
            stored.answer?.kind === "unknown"
              ? null
              : (stored.answer?.value ?? null),
          route: "cached_ai",
        };
      });
    }
  const violations = [];
  const identityChecks = [];
  for (const field of results) {
    const definition = captured.get(field.key);
    const offered = definition.options.length
      ? definition.options.map((o) => o.label)
      : definition.observations.findLast((o) => !o.query)?.options || [];
    for (const answer of field.answers) {
      const values = Array.isArray(answer.answer)
        ? answer.answer
        : [answer.answer];
      if (
        answer.answer != null &&
        offered.length &&
        values.some((value) => !offered.includes(value))
      )
        violations.push({
          key: field.key,
          identity: answer.identity,
          rule: "option_not_offered",
        });
      const profile = syntheticProfiles.find((p) => p.id === answer.identity);
      const dates = JSON.stringify(profile).match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (
        answer.answer != null &&
        definition.type === "date" &&
        !dates.includes(answer.answer)
      )
        violations.push({
          key: field.key,
          identity: answer.identity,
          rule: "invented_date",
        });
    }
    // Compare all identities without inventing a semantic oracle from the model.
    // Reviewed per-identity gold below decides whether a difference is correct.
    identityChecks.push({
      key: field.key,
      answers: field.answers.map(({ identity, answer }) => ({
        identity,
        answer,
      })),
      distinctAnswers: new Set(field.answers.map((row) => hash(row.answer)))
        .size,
    });
  }
  const old = new Map(
    (previous?.pages || [])
      .flatMap((page) => page.fields)
      .map((field) => [field.key, field]),
  );
  const changes = results
    .filter(
      (field) =>
        old.has(field.key) &&
        hash([old.get(field.key).actual, old.get(field.key).answers]) !==
          hash([field.actual, field.answers]),
    )
    .map((field) => field.key);
  const goldChecks = (corpus.goldAnswers || []).flatMap((gold) => {
    if (!gold.confirmed || gold.origin !== "person") return [];
    const field = pages
      .find((page) => page.id === gold.pageId)
      ?.fields.find((field) => field.key === gold.questionId);
    const profile = syntheticProfiles.find((p) => p.id === gold.identity);
    if (!field || !profile || gold.profileHash !== hash(profile)) return [];
    const answer = field.answers.find(
      (answer) => answer.identity === gold.identity,
    );
    return [
      {
        key: gold.questionId,
        identity: gold.identity,
        matched: hash(answer?.answer) === hash(gold.value),
      },
    ];
  });
  return {
    version: 1,
    fixtureSource: corpus.source || "private-corpus",
    createdAt: new Date().toISOString(),
    summary: {
      pages: pages.length,
      questions: new Set(results.map((field) => field.key)).size,
      unanswered: results
        .flatMap((field) => field.answers)
        .filter((answer) => answer.answer == null).length,
      missedControls: pages.reduce((n, page) => n + page.missedControls, 0),
      truncatedPages: pages.filter((page) => page.truncated).length,
      unrecognizedQuestions: results.filter((field) => !field.actual).length,
      captureMismatches: results.filter(
        (field) => field.actual && !field.meaningMatches,
      ).length,
      missingAI,
      unrecordedSearches: results
        .flatMap((field) => field.answers)
        .filter((answer) => answer.search === "unrecorded").length,
      violations: violations.length,
      changedQuestions: new Set(changes).size,
      identityChecks: identityChecks.length,
      labelledQuestions: goldChecks.length,
      answerAccuracy: goldChecks.length
        ? goldChecks.filter((check) => check.matched).length / goldChecks.length
        : null,
    },
    violations,
    changes: [...new Set(changes)],
    goldChecks,
    identityChecks,
    pages,
    limitations: [
      "Cached model answers are replay inputs, never gold labels.",
      "DOM replay does not verify site writes, network behavior or submission.",
    ],
  };
}
