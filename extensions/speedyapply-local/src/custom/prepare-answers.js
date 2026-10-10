import { JobsControlFields } from "./control-fields.js";
import { shape } from "./automatic-field-policy.js";
import { recordCorpusOptions } from "./corpus-observations.js";
// Capture a bounded batch from current controls, after reading exact choices.
export async function prepareAnswerBatch(
  candidates,
  {
    book,
    reader,
    binding,
    operation,
    current,
    assertCurrent,
    isChoice,
    leave,
    note,
  },
) {
  let submitted = [];
  for (let row of candidates) {
    book.entry(row).aiTried = true;
    // A decided value that is gone again is the person's to check.
    if (book.peek(row.node).state === "decided") {
      leave(row, "Decided value missing");
      continue;
    }
    let options =
      row.public.options?.filter((option) => option.value && option.label) ||
      [];
    if (isChoice(row) && JobsControlFields.component(row.node)) {
      await binding();
      options = await operation.write(() =>
        reader.readOptions(row, current, book.peek(row.node)?.hint || {}),
      );
      row = reader.scan().find((item) => item.node === row.node);
      if (!row || row.public.filled) {
        note("auto_answer_obsolete", row?.node, "options_changed");
        continue;
      }
    }
    assertCurrent();
    recordCorpusOptions(
      row.node,
      options.map((option) => option.label),
    );
    if (row.descriptionIncomplete) {
      note(
        "auto_unhandled_control",
        row.node,
        "Field description exceeds limit",
      );
      leave(row, "题目说明过长，无法完整核验");
      continue;
    }
    // Empty search results need a verified query before a native option exists.
    const search =
      !options.length &&
      ["combobox", "search-choice"].includes(row.public.type);
    if (isChoice(row) && !options.length && !search) {
      note("auto_unhandled_control", row.node, "No exact options");
      leave(row, "No exact options");
      continue;
    }
    submitted.push({
      row,
      shape: shape(row),
      field: {
        fieldId: row.public.id,
        question: row.public.question,
        type: search
          ? "search-choice"
          : row.public.type === "search-choice"
            ? "combobox"
            : row.public.type,
        required: row.public.required,
        options,
        description: row.description || "",
      },
    });
  }
  const fresh = reader.scan();
  submitted = submitted.filter((item) => {
    const row = fresh.find((candidate) => candidate.node === item.row.node);
    if (row && !row.public.filled && shape(row) === item.shape) return true;
    if (row && !row.public.filled) book.entry(row).aiTried = false;
    note(
      "auto_answer_obsolete",
      row?.node,
      row?.public.filled ? "already_filled" : "control_changed",
    );
    return false;
  });
  for (const item of submitted.slice(30)) book.entry(item.row).aiTried = false;
  submitted = submitted.slice(0, 30);
  return submitted;
}
