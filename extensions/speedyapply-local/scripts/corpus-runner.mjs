import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { readerSource } from "./repro-runner.mjs";
import { mountCorpus, captureCorpus } from "../src/custom/corpus-case.js";

export const syntheticProfiles = [
  {
    id: "citizen",
    educationData: [{ endDate: "2027-05" }],
    employmentData: {
      eligibilityUS: true,
      sponsorship: false,
      citizenships: ["United States"],
    },
    applicationData: {
      visaStatus: "US citizen",
      sponsorshipNow: false,
      sponsorshipFuture: false,
    },
  },
  {
    id: "opt",
    educationData: [{ endDate: "2027-05", graduationDate: "2027-05-21" }],
    employmentData: {
      eligibilityUS: true,
      sponsorship: true,
      citizenships: ["Canada"],
    },
    applicationData: {
      visaStatus: "F-1 OPT",
      sponsorshipNow: false,
      sponsorshipFuture: true,
    },
  },
  {
    id: "resident",
    educationData: [{ endDate: "2027-12" }],
    employmentData: { eligibilityUS: true, sponsorship: false },
    applicationData: {
      visaStatus: "Green card",
      sponsorshipNow: false,
      sponsorshipFuture: false,
    },
  },
  { id: "unknown", employmentData: {}, applicationData: {} },
];
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

export function seedBindings(pages) {
  const mappings = new Map();
  for (const { page } of pages)
    for (const field of page.fields) {
      const predicate = field.question.startsWith("Are you legally authorized")
        ? "us_work_eligible"
        : /sponsorship/.test(field.question)
          ? "sponsorship_future"
          : null;
      if (!predicate) continue;
      mappings.set(corpusQuestionKey(field), {
        questionId: corpusQuestionKey(field),
        country: "US",
        model: "synthetic-fixture",
        binding: {
          predicate,
          options: /without/.test(field.question)
            ? ["false", "true"]
            : ["true", "false"],
        },
        meaning: {
          topic:
            predicate === "us_work_eligible"
              ? "work_eligibility"
              : "sponsorship",
          country: "US",
          company: "",
          timeframe: predicate === "sponsorship_future" ? "future" : "current",
        },
      });
    }
  return [...mappings.values()];
}

export function replayMappings(corpus) {
  const latest = new Map();
  for (const item of corpus.bindings || [])
    latest.set(item.questionId + ":" + item.country, item);
  const grouped = new Map();
  for (const item of latest.values()) {
    const items = grouped.get(item.questionId) || [];
    items.push(item);
    grouped.set(item.questionId, items);
  }
  // Capture has no job-country authority. Reuse only a mapping whose stored
  // country contexts agree; expose conflicting contexts for explicit review.
  return new Map(
    [...grouped].map(([key, items]) => [
      key,
      new Set(items.map((item) => hash([item.binding, item.meaning]))).size ===
      1
        ? items.at(-1)
        : null,
    ]),
  );
}
function evaluateBindings(corpus, mappings) {
  const fields = new Map(
    corpus.pages
      .flatMap(({ page }) => page.fields)
      .map((field) => [corpusQuestionKey(field), field]),
  );
  const cases = [...mappings.values()]
    .filter((binding) => binding && fields.has(binding.questionId))
    .map((binding) => ({
      key: binding.questionId,
      binding: binding.binding,
      meaning: binding.meaning,
      field: {
        ...fields.get(binding.questionId),
        fieldId: fields.get(binding.questionId).id,
      },
    }));
  if (!cases.length) return new Map();
  const service = fileURLToPath(
    new URL("../../../services/jobs-radar/", import.meta.url),
  );
  const bundled =
    service +
    "/.venv/" +
    (process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python =
    process.env.JOBS_CORPUS_PYTHON ||
    (fs.existsSync(bundled) ? bundled : "python3");
  const result = spawnSync(python, ["-m", "jobs_radar.corpus_evaluate"], {
    cwd: service,
    input: JSON.stringify({ cases, profiles: syntheticProfiles }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw Error(
      "Production predicate replay failed; check the configured Python test environment",
    );
  return new Map(
    JSON.parse(result.stdout).map((item) => [item.key, item.answers]),
  );
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
  const mappings = replayMappings(corpus),
    bindings = evaluateBindings(corpus, mappings);
  const captured = new Map(
    corpus.pages
      .flatMap(({ page }) => page.fields)
      .map((field) => [corpusQuestionKey(field), field]),
  );
  for (const field of results) {
    const mapped = bindings.get(field.key),
      definition = captured.get(field.key);
    if (!field.meaningMatches || !mapped) continue;
    field.answers = field.answers.map((local) => {
      if (local.answer != null) return local;
      const answer = mapped.find((item) => item.identity === local.identity);
      return answer
        ? {
            identity: local.identity,
            answer:
              definition.options.find((option) => option.value === answer.value)
                ?.label ?? null,
            route: answer.route,
            concept: answer.concept,
          }
        : local;
    });
  }
  const violations = [];
  const identityChecks = [];
  for (const field of results) {
    const definition = captured.get(field.key);
    for (const answer of field.answers)
      if (
        answer.answer != null &&
        definition.options.length &&
        !definition.options.some((option) => option.label === answer.answer)
      )
        violations.push({ key: field.key, rule: "option_not_offered" });
    const unknown = field.answers.find(
      (answer) => answer.identity === "unknown",
    );
    // Unknown is a fixture without facts or enabled defaults. Only this
    // independently defined input can establish a missing-fact invariant.
    if (unknown?.answer != null)
      violations.push({ key: field.key, rule: "unknown_answered" });
    for (const answer of field.answers) {
      const profile = syntheticProfiles.find(
        (profile) => profile.id === answer.identity,
      );
      if (
        answer.answer != null &&
        /graduation/i.test(field.captured.question) &&
        definition.type === "date" &&
        !profile.educationData?.some((row) => row.graduationDate)
      )
        violations.push({
          key: field.key,
          identity: answer.identity,
          rule: "invented_graduation_day",
        });
      const expected = {
        us_work_eligible: {
          citizen: "true",
          opt: "true",
          resident: "true",
          unknown: null,
        },
        sponsorship_future: {
          citizen: "false",
          opt: "true",
          resident: "false",
          unknown: null,
        },
      }[answer.route];
      if (expected) {
        const matched = answer.concept === expected[answer.identity];
        identityChecks.push({
          key: field.key,
          identity: answer.identity,
          matched,
        });
        if (!matched)
          violations.push({
            key: field.key,
            identity: answer.identity,
            rule: "identity_fact_mismatch",
          });
      }
    }
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
        JSON.stringify([
          old.get(field.key).actual,
          old.get(field.key).answers,
        ]) !== JSON.stringify([field.actual, field.answers]),
    )
    .map((field) => field.key);
  const gold = Object.entries(corpus.labels || {}).filter(([key]) =>
    captured.has(key),
  );
  const goldChecks = gold.map(([key, label]) => ({
    key,
    matched:
      !!mappings.get(key) &&
      hash([mappings.get(key).binding, mappings.get(key).meaning]) ===
        hash([label.binding, label.meaning]),
  }));
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
      ambiguousMappings: [...mappings.values()].filter((item) => !item).length,
      unrecordedSearches: results
        .flatMap((field) => field.answers)
        .filter((answer) => answer.search === "unrecorded").length,
      violations: violations.length,
      changedQuestions: new Set(changes).size,
      identityChecks: identityChecks.length,
      labelledQuestions: goldChecks.length,
      mappingAccuracy: goldChecks.length
        ? goldChecks.filter((check) => check.matched).length / goldChecks.length
        : null,
    },
    violations,
    changes: [...new Set(changes)],
    goldChecks,
    identityChecks,
    pages,
    limitations: [
      "Recorded model mappings are inputs, not independent gold labels.",
      "DOM replay does not verify site writes, network behavior or submission.",
    ],
  };
}
