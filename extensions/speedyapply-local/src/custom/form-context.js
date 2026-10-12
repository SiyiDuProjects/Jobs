import { JobsPlatformConfig } from "./platform-config.js";
// Read-only, ordered form context. Field answers remain separate from page prose.
const OMIT =
  'script,style,template,noscript,iframe,nav,[role="navigation"],' +
  '[hidden],[inert],[aria-hidden="true"],button,[role="button"],' +
  '[role="alert"],[data-jobs-review],[data-jobs-diagnostics],[data-jobs-operator]';
const INPUT =
  'input,textarea,select,[contenteditable],[role="textbox"],' +
  '[role="combobox"],[role="listbox"]';
const PRIVATE =
  'input[type="password"],input[type="hidden"],input[type="file"],' +
  '[autocomplete="one-time-code"],[autocomplete="current-password"],' +
  '[autocomplete="new-password"]';
const BLOCK =
  /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DIV|FIELDSET|H[1-6]|HR|LI|P|SECTION|TABLE|TR)$/;

export function captureFormDocument(root, reader, submitted = []) {
  const scope = root.body || root;
  const doc = scope.ownerDocument;
  // Validation feedback changes as this batch writes. It is field state, not
  // a new instruction invalidating the remaining answers in the same batch.
  const omitted = [OMIT, JobsPlatformConfig?.detect(doc).errorSelector]
    .filter(Boolean)
    .join(",");
  const rows = reader.scan().filter((row) => !row.node.matches(PRIVATE));
  const pending = new Map(
    submitted.map((item) => [item.field.fieldId, item.field]),
  );
  const markers = new Map();
  const fields = [];
  let truncated = false,
    fieldSize = 0;
  function bounded(value, limit) {
    const text = String(value ?? "");
    if (text.length > limit) truncated = true;
    return text.slice(0, limit);
  }
  for (const row of rows) {
    const field = pending.get(row.public.id) || row.public;
    for (const member of [row.node, ...(row.group || [])])
      markers.set(member, row.public.id);
    const entry = {
      fieldId: row.public.id,
      question: bounded(field.question, 2000),
      type: field.type,
      required: !!field.required,
      description: bounded(row.description, 4000),
      options: (field.options || []).slice(0, 1000).map((option) => ({
        value: bounded(option.value, 2000),
        label: bounded(option.label, 500),
      })),
      answer: bounded(reader.response(row)?.response, 4000),
    };
    const size = JSON.stringify(entry).length;
    if (fields.length >= 150 || fieldSize + size > 100000) {
      truncated = true;
      continue;
    }
    fieldSize += size;
    fields.push(entry);
    if (row.descriptionIncomplete || field.options?.length > 1000)
      truncated = true;
  }
  const parts = [],
    seen = new Set();
  let length = 0;
  function append(text) {
    if (length + text.length > 60000) truncated = true;
    const part = text.slice(0, Math.max(0, 60000 - length));
    parts.push(part);
    length += part.length;
  }
  function visit(node) {
    if (node.nodeType === 11) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.nodeType === 3) {
      append(node.textContent.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1 || node.matches(omitted) || !reader.visible(node))
      return;
    const id = markers.get(node);
    if (id && !seen.has(id)) {
      append(`\n[field:${id}]\n`);
      seen.add(id);
    }
    // Values come only from the scanner, never hidden DOM or widget internals.
    if (node.matches(INPUT)) return;
    if (BLOCK.test(node.tagName)) append("\n");
    const assigned =
      node.tagName === "SLOT" ? node.assignedNodes({ flatten: true }) : [];
    const children = assigned.length
      ? assigned
      : node.shadowRoot?.childNodes || node.childNodes;
    for (const child of children) {
      if (length >= 60000) {
        truncated = true;
        break;
      }
      visit(child);
    }
    if (BLOCK.test(node.tagName)) append("\n");
  }
  visit(scope);
  return {
    version: 1,
    title: bounded(
      scope
        .querySelector('h1,h2,legend,[role="heading"]')
        ?.textContent?.trim() || doc.title,
      500,
    ),
    text: parts
      .join("")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    fields,
    truncated,
  };
}
