import { JobsFieldOutcomeVocabulary as vocabulary } from "./field-outcome-vocabulary.js";
// Why a field holds what it holds, in one closed vocabulary shared with the
// service (jobs_radar/field_outcome.json). The run's field ledger stores these
// codes; the live page snapshot, the inspector and the corpus page outcome only
// read them. Free text never leaves the ledger.
const reasons = new Set(vocabulary.reasons);
// Writer failures arrive as the pipeline's own messages; map them once here.
/** @type {Array<[RegExp, string]>} */
const messages = [
  [/^value not kept$/i, "value_lost"],
  [/^not committed$/i, "not_committed"],
  [/^Page definition update is not confirmed$/i, "page_unconfirmed"],
  [/^Field changed before writing$/i, "field_changed"],
  [/^Field is outside the active form$/i, "out_of_scope"],
  [/^A field already has a decider/i, "taken"],
  [/^Form readiness timed out/i, "readiness_timeout"],
  [/context_changed$/i, "context_changed"],
  [/^unsupported_optional$/i, "optional_skipped"],
];
export function outcomeReason(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (reasons.has(text)) return text;
  const nested = /^AI answer not kept: (.*)$/i.exec(text);
  if (nested) return outcomeReason(nested[1]) || "write_error";
  for (const [pattern, code] of messages) if (pattern.test(text)) return code;
  return "other";
}
export function outcomeDecider(value) {
  const text = String(value ?? "");
  if (!text) return null;
  if (text.startsWith("binding:")) return "binding";
  return vocabulary.deciders.includes(text) ? text : "other";
}
// The ledger decider for a field the page's operator wrote themselves. Only
// the operator state names the actor; a trusted event alone does not.
export const operatorDecider = (mode) =>
  mode === "person"
    ? "user"
    : vocabulary.operators.includes(mode)
      ? mode
      : "unknown";
export const takenBy = (decider) => vocabulary.operators.includes(decider);
export function fieldOutcome(record) {
  if (!record) return { state: "open" };
  const by = outcomeDecider(record.decider),
    from = outcomeDecider(record.from);
  return {
    state: record.state,
    ...(by ? { by } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(from ? { from } : {}),
    ...(record.card ? { review: true } : {}),
    ...(record.taken ? { taken: true } : {}),
  };
}
// The plugin did not complete this field itself: an operator wrote it, or a
// layer left it with a reason or on the review card.
export const handedOver = (outcome) =>
  !!outcome &&
  (outcome.taken === true ||
    takenBy(outcome.by) ||
    ["abstained", "omitted", "unrecognized"].includes(outcome.state) ||
    !!outcome.reason ||
    outcome.review === true);
