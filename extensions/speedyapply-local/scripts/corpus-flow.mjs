import { adapterPage } from "../tests/helpers/adapter-run.mjs";
import { bindAnswerEvidence } from "../src/custom/answer-proof.js";
import { mountCorpus, corpusInputIssues } from "../src/custom/corpus-case.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const labels = (field) =>
  field.options?.length
    ? field.options.map((option) => option.label)
    : field.observations?.findLast((item) => !item.query)?.options || [];

// Snapshots deliberately contain no application scripts or original answers.
// Replace ONLY the dynamic option transport/retention boundary, using recordings.
// Discovery, question descriptions, local decisions, option matching, request
// preparation, the writer ledger and formContext all run in JobsAutomatic.
function recordedControls(w, bindings, gaps) {
  const selected = new WeakMap(),
    visibleOptions = new WeakMap();
  const recorded = new Map(
    bindings
      .filter(({ row }) =>
        ["combobox", "search-choice", "select-multiple"].includes(
          row.public.type,
        ),
      )
      .filter(({ row }) => w.JobsControlFields.component(row.node))
      .map((item) => [item.row.node, item]),
  );
  const optionsFor = (node, query = "") => {
    const { raw, row } = recorded.get(node);
    const searching =
      row.public.type === "search-choice" ||
      (row.public.type === "combobox" && !labels(raw).length);
    if (!searching) return labels(raw);
    const observation = raw.observations?.find((item) => item.query === query);
    if (!observation) {
      gaps.push({ fieldId: raw.id, reason: "unrecorded_search", query });
      return [];
    }
    return observation.options;
  };
  const options = (found) =>
    found.map((label, i) => ({ value: `recorded-${i}`, label }));
  const valueFor = (node) => {
    const { row } = recorded.get(node);
    const value = selected.get(node);
    return ["search-choice", "select-multiple"].includes(row.public.type)
      ? value || []
      : value?.[0] || "";
  };
  const owners = new Set(
    [...recorded.keys()].map((node) => w.JobsControlFields.component(node).api),
  );
  for (const name of Object.keys(w).filter((key) =>
    /^Jobs.*Controls$/.test(key),
  )) {
    const api = w[name];
    if (!owners.has(api)) continue;
    w[name] = {
      ...api,
      value: (node) =>
        recorded.has(node) ? valueFor(node) : api.value?.(node),
      describe(node, ...args) {
        const original = api.describe?.(node, ...args);
        return original && recorded.has(node)
          ? {
              ...original,
              value: valueFor(node),
              options: visibleOptions.get(node) ?? original.options,
            }
          : original;
      },
      facts(node, ...args) {
        const original = api.facts?.(node, ...args);
        return original && recorded.has(node)
          ? {
              ...original,
              value: valueFor(node),
              options: visibleOptions.get(node) ?? original.options,
            }
          : original;
      },
      async readOptions(node, current, context = {}) {
        if (!recorded.has(node))
          return api.readOptions?.(node, current, context);
        if (!current()) return [];
        const found = options(optionsFor(node, context.answer || ""));
        visibleOptions.set(node, found);
        return found;
      },
      async chooseFrom(node, choose, context = {}) {
        if (!recorded.has(node)) return api.chooseFrom?.(node, choose, context);
        if (context.canProceed?.() === false) return null;
        const offered = optionsFor(node, context.query || "");
        visibleOptions.set(node, options(offered));
        const result = choose(offered);
        const values = Array.isArray(result) ? result : [result];
        if (!values.length || values.some((value) => !offered.includes(value)))
          return null;
        selected.set(node, values);
        // Invalidate the scanner's cached component state without introducing
        // generated option labels or pretending the live ATS acknowledged it.
        node.setAttribute("aria-expanded", "false");
        node.dispatchEvent(new w.Event("change", { bubbles: true }));
        return node;
      },
    };
  }
  return recorded;
}

function targetNodes(root) {
  const nodes = [...root.querySelectorAll("[data-jobs-corpus-field]")];
  for (const node of root.querySelectorAll("*"))
    if (node.shadowRoot) nodes.push(...targetNodes(node.shadowRoot));
  return nodes;
}

export async function replayCorpusFlow({
  page,
  profile,
  bound,
  job = {},
  generate,
}) {
  const quality = corpusInputIssues(page);
  if (page.coverage?.truncated) quality.push("snapshot_truncated");
  if (quality.length)
    return {
      excluded: true,
      reasons: quality,
      fields: [],
      requests: [],
      gaps: [],
    };
  const h = await adapterPage(null, {
    html: "",
    url:
      page.jobIdentity ||
      {
        workday: "https://example.myworkdayjobs.com/example",
        greenhouse: "https://job-boards.greenhouse.io/example",
        ashby: "https://jobs.ashbyhq.com/example",
      }[page.platform] ||
      "https://fixture.invalid/example",
  });
  const { w, doc } = h;
  const gaps = [],
    requests = [],
    answers = new Map();
  try {
    w.fetch = () => {
      throw Error("Snapshot network is disabled");
    };
    w.XMLHttpRequest = class {
      constructor() {
        throw Error("Snapshot network is disabled");
      }
    };
    w.CSS = {
      escape: (value) =>
        String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c),
    };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    mountCorpus(doc, page);
    function clearDefaultSelections(root) {
      for (const select of root.querySelectorAll("select"))
        select.selectedIndex = -1;
      for (const node of root.querySelectorAll("*"))
        if (node.shadowRoot) clearDefaultSelections(node.shadowRoot);
    }
    clearDefaultSelections(doc);
    const reader = w.JobsControlFields.create(doc),
      rows = reader.scan();
    const targets = targetNodes(doc);
    const bindings = [];
    for (const raw of page.fields) {
      const target = targets.find(
        (node) => node.getAttribute("data-jobs-corpus-field") === raw.id,
      );
      const matching = target
        ? rows.filter(
            (row) =>
              row.node === target ||
              row.group?.includes(target) ||
              row.node.contains(target),
          )
        : [];
      if (matching.length !== 1) {
        gaps.push({ fieldId: raw.id, reason: "unrecognized_control" });
        continue;
      }
      bindings.push({ raw, row: matching[0] });
    }
    // A redaction/capture change to a question is not a new question for AI.
    // Keep it out of the comparison; never repair archived labels heuristically.
    for (const { raw, row } of bindings)
      if (
        row.public.question !== raw.question ||
        row.public.type !== raw.type ||
        row.public.required !== raw.required ||
        (row.description || "") !== raw.description
      )
        gaps.push({ fieldId: raw.id, reason: "snapshot_semantics_changed" });
    if (gaps.some((gap) => gap.reason === "snapshot_semantics_changed"))
      return {
        excluded: true,
        reasons: ["snapshot_semantics_changed"],
        fields: [],
        requests,
        gaps,
      };
    const recorded = recordedControls(w, bindings, gaps);
    w.chrome.runtime.sendMessage = async (message) => {
      if (message.type === "jobs:tab-profile")
        return { data: { ...bound, profile } };
      if (message.type === "jobs:autofill-preferences") return { data: {} };
      if (message.type === "jobs:corpus-page") return { data: {} };
      if (message.type !== "jobs:auto-answers") return {};
      // These fields and context originate from the same prepare/read path as
      // production. The worker boundary adds only the readonly posting lookup.
      const request = {
        answerProtocol: 3,
        profileId: bound.id,
        profileVersion: bound.lastSync,
        fields: copy(message.fields),
        formContext: copy(message.formContext),
        jobUrl: page.jobIdentity || "",
        jobCountry:
          w.JobsProfileAnswers.scope([
            ...message.fields,
            ...message.formContext,
          ]) || "",
        jobTitle: job.title || "",
        jobDescription: job.description || "",
        additionalContext: JSON.stringify({
          currentLocalDate: w.JobsProfileAnswers.today(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          dateAnswerFormat: "YYYY-MM-DD",
          jobLocations: job.locations || [],
        }),
      };
      const response = await generate(request);
      requests.push({ request, response: copy(response) });
      for (const answer of response.answers || [])
        answers.set(answer.fieldId, answer);
      return {
        data: {
          ...response,
          answers: response.answers.map((answer) =>
            bindAnswerEvidence(
              answer,
              message.fields.find((field) => field.fieldId === answer.fieldId),
              bound,
            ),
          ),
        },
      };
    };
    const roots = [...doc.querySelectorAll('form,[role="form"]')].filter(
      (node) => !node.parentElement?.closest('form,[role="form"]'),
    );
    for (const root of roots.length ? roots : [doc.body])
      await w.JobsAutomatic.advance({
        root,
        profile,
        action: "fill",
        autoConfirm: true,
        resolveAnswers: w.JobsAnswerResolver.resolve,
      });
    const after = reader.scan();
    const fields = bindings.map(({ raw, row: before }) => {
      const row = after.find((item) => item.node === before.node);
      const request = requests
        .flatMap((item) => item.request.fields)
        .find((item) => item.fieldId === before.public.id);
      const answer = answers.get(before.public.id);
      const readback = row && reader.response(row)?.response;
      const absent = !row
        ? "control_disappeared"
        : ["file", "contenteditable"].includes(row.public.type)
          ? "adapter_only_control"
          : !row.public.supported
            ? "unsupported_control"
            : row.public.dependencyBlocked
              ? "dependency_blocked"
              : row.public.conditional && row.public.conditional.active !== true
                ? "conditional_unresolved"
                : row.descriptionIncomplete
                  ? "description_incomplete"
                  : null;
      if (absent) gaps.push({ fieldId: raw.id, reason: absent });
      const local = h.notes.some(
        (event) =>
          event.type === "auto_known_answer_applied" &&
          event.node === before.node,
      );
      return {
        capturedId: raw.id,
        comparisonEligible: !absent,
        field: request || {
          ...copy(before.public),
          fieldId: before.public.id,
          description: before.description || "",
        },
        stage: local ? "local" : answer ? "server" : "unresolved",
        answer: answer ? copy(answer) : null,
        readback: readback ?? null,
        retainedValue:
          row?.public.type === "select-multiple" && Array.isArray(row.raw)
            ? row.raw.map(
                (value) =>
                  row.public.options?.find((option) => option.value === value)
                    ?.label || value,
              )
            : (readback ?? null),
        filled: !!row?.public.filled,
        written: h.notes.some(
          (event) =>
            ["auto_known_answer_applied", "auto_field_applied"].includes(
              event.type,
            ) && event.node === before.node,
        ),
        transport: recorded.has(before.node)
          ? "recorded_control"
          : "native_snapshot",
      };
    });
    return {
      evaluationScope: "snapshot_pipeline",
      localRulesIncluded: true,
      originalUserAnswersRestored: false,
      liveATSVerified: false,
      adapterBindingsIncluded: false,
      requests,
      fields,
      gaps: [
        ...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values(),
      ],
      missedControls: reader.unrecognized(after).length,
      blocked: h.notes
        .filter((item) => item.type === "auto_blocked")
        .map((item) => item.detail),
    };
  } finally {
    w.close();
  }
}
