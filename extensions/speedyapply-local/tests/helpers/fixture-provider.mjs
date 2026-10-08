import { typedAnswer } from "./typed-answer.mjs";
import { confirmedAnswer } from "./verified-answer.mjs";
// Synthetic provider boundary for DOM tests. The explicit frozen types exercise
// the retained answer functions; semantic-verifier behavior has service tests.
// Unknown questions remain unknown and no keyword matching is performed.
export function fixtureAnswers(api, fields, profile, context = []) {
  return fields.map((field) => {
    const labels = (field.options || []).map((option) => option.label);
    const typed = typedAnswer(api, field.question, profile, {
      ...field,
      inputType: field.type,
      options: labels,
      country: api.scope([...fields, ...context]),
    });
    const answer = api.select(typed, labels);
    if (answer === null || answer === undefined || answer === "")
      return {
        fieldId: field.fieldId,
        state: "needs_input",
        value: null,
        source: "unknown",
        needsConfirmation: true,
        reason: "Synthetic missing fact",
      };
    let value =
      field.type === "month"
        ? typed.aliases?.find((value) => /^\d{4}-\d{2}$/.test(value)) || answer
        : field.type.includes("checkbox")
          ? answer.toLowerCase() === "yes"
          : labels.length
            ? field.options.find((option) => option.label === answer)?.value
            : answer;
    if (field.type === "select-multiple") value = [value];
    return confirmedAnswer(
      field,
      {
        fieldId: field.fieldId,
        state: "answer",
        value,
        source: "profile",
        needsConfirmation: false,
        reason: "Synthetic verified evidence",
      },
      typed.field
        ? [typed.field.replace(/^educationData\.(?!\d)/, "educationData.0.")]
        : [],
    );
  });
}

// Explicit replies supplied by a control fixture. Values here are already the
// field's wire values; this is a provider stub, never saved-answer matching.
export function fixtureReply(api, field, profile, { text, values = {} } = {}) {
  const question = field.question.trim().replace(/[?*\s]+$/, "");
  const value = values[question];
  if (
    value !== undefined ||
    (field.required && field.type === "textarea" && text)
  )
    return confirmedAnswer(field, {
      fieldId: field.fieldId,
      state: "answer",
      value:
        field.options?.find((option) => option.label === value)?.value ??
        value ??
        text,
      source: "profile",
      needsConfirmation: false,
      reason: "Explicit synthetic provider reply",
    });
  return fixtureAnswers(api, [field], profile)[0];
}

// Explicit synthetic verifier replies. This helper does not test Saved Response
// selection or authorize real facts; those boundaries have service tests.
export function explicitReply(api, field, profile, replies, context = []) {
  const key = (value) => value.trim().replace(/[?*✱\s]+$/, "");
  const row = replies.find(
    (row) => row.question && key(row.question) === key(field.question),
  );
  if (!row) return fixtureAnswers(api, [field], profile, context)[0];
  const value = field.options?.length
    ? field.options.find((o) => o.label === row.response)?.value
    : field.type.includes("checkbox")
      ? row.response === "Yes"
      : row.response;
  if (value === undefined)
    return {
      fieldId: field.fieldId,
      state: "needs_input",
      value: null,
      source: "unknown",
      reason: "No exact fixture option",
    };
  return confirmedAnswer(field, {
    fieldId: field.fieldId,
    state: "answer",
    value: field.type === "select-multiple" ? [value] : value,
    source: "profile",
    needsConfirmation: false,
  });
}
