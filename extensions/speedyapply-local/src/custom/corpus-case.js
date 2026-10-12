// Inert DOM trees, never HTML or executable site scripts.
import { corpusOptions } from "./corpus-observations.js";

const tags = new Set(
  "form div span p section fieldset legend label input textarea select option optgroup button a ul ol li table tbody tr td th h1 h2 h3 h4 article main output".split(
    " ",
  ),
);
const attributes = new Set(
  "id for name role type required disabled multiple hidden inert readonly aria-labelledby aria-describedby aria-controls aria-owns aria-required aria-disabled aria-hidden aria-haspopup aria-multiselectable aria-label placeholder title data-automation-id data-uxi-widget-type data-uxi-multiselect-id data-uxi-popup-anchor data-associated-widget data-option icimsdropdown-enabled icimsdropdown-search i_required".split(
    " ",
  ),
);
const references = new Set(
  "id for name aria-labelledby aria-describedby aria-controls aria-owns data-uxi-multiselect-id data-uxi-popup-anchor data-associated-widget data-option".split(
    " ",
  ),
);
const sensitive =
  /password|passcode|one.?time|verification.?code|social.?security|\bssn\b|credit.?card|验证码|密码/i;
const normalize = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
export const CORPUS_LIMITS = {
  nodes: 12000,
  fields: 300,
  bytes: 2000000,
  depth: 40,
};

export function corpusRedactor(profile = {}, rows = []) {
  const values = new Set();
  function add(value) {
    if (typeof value === "string" && normalize(value).length >= 2)
      values.add(normalize(value));
  }
  for (const value of Object.values(profile.nameData || {})) add(value);
  for (const key of ["email", "phoneNumber"]) add(profile.contactData?.[key]);
  // Coarse locations and employment/education values are public vocabulary,
  // not identifying strings to erase from every question and option.
  for (const key of ["line1", "line2", "postalCode"])
    add(profile.addressData?.[key]);
  for (const key of ["fileName", "filename", "name", "resumeName"])
    add(profile.resumeData?.[key]);
  for (const row of rows) {
    for (const file of row.node?.files || []) add(file.name);
  }
  const terms = [...values].sort((a, b) => b.length - a.length);
  const phone = String(profile.contactData?.phoneNumber || "").replace(
    /\D/g,
    "",
  );
  const phonePattern =
    phone.length >= 7
      ? new RegExp(`(?<!\\d)${[...phone].join("[\\s().-]*")}(?!\\d)`, "g")
      : null;
  return (raw) => {
    let value = normalize(raw);
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"),
        "[private]",
      );
    }
    if (phonePattern) value = value.replace(phonePattern, "[private]");
    return value
      .replace(/[^\s<>"/\\]+\.(?:pdf|docx?|rtf)\b/gi, "[attachment]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
      .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[token]");
  };
}

export function captureCorpus({
  root,
  rows,
  profile,
  review = false,
  platform = "unknown",
  build = "unbuilt",
  company = "",
  step = "",
}) {
  if (review || !root?.isConnected || rows.length > CORPUS_LIMITS.fields)
    return null;
  const doc = root.ownerDocument || root;
  const clean = corpusRedactor(profile, rows),
    symbols = new Map(),
    markers = new Map();
  const symbol = (value) => {
    if (!symbols.has(value))
      symbols.set(value, "corpus-id-" + (symbols.size + 1));
    return symbols.get(value);
  };
  rows.forEach((row, i) => markers.set(row.node, "field-" + (i + 1)));
  let nodes = 0,
    truncated = false;
  function tree(node, depth = 0) {
    if (++nodes > CORPUS_LIMITS.nodes || depth > CORPUS_LIMITS.depth) {
      truncated = true;
      return null;
    }
    if (node.nodeType === 3)
      return { text: clean(node.textContent).slice(0, 20000) };
    if (
      node.nodeType !== 1 ||
      (!tags.has(node.localName) &&
        !/^[a-z][a-z0-9]*-[a-z0-9-]{1,70}$/.test(node.localName))
    )
      return null;
    if (
      sensitive.test(
        [
          node.getAttribute("type"),
          node.getAttribute("name"),
          node.getAttribute("autocomplete"),
          node.getAttribute("aria-label"),
        ].join(" "),
      )
    )
      return null;
    const item = { tag: node.localName, attrs: {}, children: [] };
    const field = rows.find((row) => row.node === node);
    const choice =
      field && ["combobox", "search-choice"].includes(field.public.type)
        ? field
        : null;
    const answerSurface =
      !!choice ||
      node.matches(
        'input:not([type="radio"]):not([type="checkbox"]),textarea,output,[contenteditable],[role="textbox"],.select__single-value,.select__multi-value,[data-automation-id="selectedItem"],[data-automation-id="fileName"]',
      );
    if (markers.has(node))
      item.attrs["data-jobs-corpus-field"] = markers.get(node);
    for (const name of attributes) {
      if (!node.hasAttribute(name)) continue;
      if (
        answerSurface &&
        ["aria-label", "title", "placeholder"].includes(name)
      )
        continue;
      const raw = node.getAttribute(name);
      item.attrs[name] = references.has(name)
        ? raw.split(/\s+/).map(symbol).join(" ")
        : clean(raw).slice(0, 1200);
    }
    if (answerSurface && field) {
      item.attrs["aria-label"] = clean(field.public.question).slice(0, 1200);
      if (field.public.required) item.attrs["aria-required"] = "true";
    }
    // Only stable component classes matter; CSS and dynamic identifiers are not archived.
    const classes = [...node.classList].filter(
      (value) =>
        /^[a-zA-Z_][a-zA-Z0-9_:-]{0,60}$/.test(value) &&
        clean(value) === value &&
        !/\d{6,}|selected|checked/i.test(value),
    );
    if (classes.length) item.attrs.class = classes.slice(0, 12).join(" ");
    if (node.localName === "option") {
      const select = node.closest("select"),
        row = rows.find((row) => row.node === select);
      item.attrs.value =
        node.value &&
        (!row ||
          row.public.options?.some((option) => option.value === node.value))
          ? "option-" +
            [
              ...(node.closest("select")?.querySelectorAll("option") || []),
            ].indexOf(node)
          : "";
    }
    const style = doc.defaultView.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden")
      item.hidden = true;
    // Textarea/contenteditable/custom selected-value text is an answer, not a prompt.
    if (
      node.localName !== "textarea" &&
      !node.isContentEditable &&
      !answerSurface
    )
      item.children = [...node.childNodes]
        .map((child) => tree(child, depth + 1))
        .filter(Boolean);
    if (node.shadowRoot && !answerSurface)
      item.shadow = [...node.shadowRoot.childNodes]
        .map((child) => tree(child, depth + 1))
        .filter(Boolean);
    return item;
  }
  const roots =
    root.nodeType === 9 || ["body", "html"].includes(root.localName)
      ? [...root.querySelectorAll('form,[role="form"]')].filter(
          (node) => !node.parentElement?.closest('form,[role="form"]'),
        )
      : [root];
  if (!roots.length) return null;
  const trees = roots.map((node) => tree(node)).filter(Boolean);
  const fields = rows
    .filter((row) => !sensitive.test(row.public.question))
    .map((row) => ({
      id: markers.get(row.node),
      question: clean(row.public.question).slice(0, 2000),
      description: clean(row.description).slice(0, 20000),
      type: row.public.type,
      required: !!row.public.required,
      options: (row.public.options?.length
        ? row.public.options
        : (
            corpusOptions(row.node).findLast((item) => !item.query)?.options ||
            []
          ).map((label, i) => ({ value: "recorded-" + i, label }))
      )
        .filter((option) => option.value && option.label)
        .map((option, i) => ({
          value: "option-" + i,
          label: clean(option.label).slice(0, 500),
        })),
      observations: corpusOptions(row.node).map((observation) => ({
        query: clean(observation.query),
        options: observation.options.map(clean),
      })),
    }));
  const value = {
    version: 1,
    redactionVersion: 2,
    platform,
    build,
    company: clean(company).slice(0, 200),
    step: clean(step).slice(0, 200),
    trees,
    fields,
    coverage: { nodes, truncated },
  };
  const reasons = corpusInputIssues(value);
  value.quality = { excluded: reasons.length > 0, reasons };
  validateCorpus(value);
  return value;
}

// These markers mean the original public input is no longer recoverable. Do
// not infer the missing words or use model outputs to reconstruct a benchmark.
export function corpusInputIssues(page) {
  const marker = /\[(?:private|email|attachment|token)\]/i;
  const issues = new Set();
  for (const field of page.fields || []) {
    if (marker.test(field.question)) issues.add("redacted_question");
    if (marker.test(field.description)) issues.add("redacted_description");
    if ((field.options || []).some((option) => marker.test(option.label)))
      issues.add("redacted_options");
    if (
      (field.observations || []).some(
        (observation) =>
          marker.test(observation.query) ||
          observation.options.some((v) => marker.test(v)),
      )
    )
      issues.add("redacted_search_results");
  }
  return [...issues].sort();
}

export function validateCorpus(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.trees) ||
    !Array.isArray(value.fields) ||
    value.fields.length > CORPUS_LIMITS.fields ||
    new TextEncoder().encode(JSON.stringify(value)).length > CORPUS_LIMITS.bytes
  )
    throw Error("Invalid corpus page");
  let count = 0;
  function inspect(node, depth = 0) {
    if (
      !node ||
      ++count > CORPUS_LIMITS.nodes ||
      depth > CORPUS_LIMITS.depth + 1
    )
      throw Error("Invalid corpus tree size");
    if (Object.hasOwn(node, "text")) {
      if (
        typeof node.text !== "string" ||
        node.text.length > 20000 ||
        Object.keys(node).length !== 1
      )
        throw Error("Invalid corpus text");
      return;
    }
    if (
      (!tags.has(node.tag) &&
        !/^[a-z][a-z0-9]*-[a-z0-9-]{1,70}$/.test(node.tag || "")) ||
      !node.attrs ||
      !Array.isArray(node.children) ||
      Object.keys(node).some(
        (key) =>
          !["tag", "attrs", "children", "shadow", "hidden"].includes(key),
      )
    )
      throw Error("Unsafe corpus element");
    for (const [key, text] of Object.entries(node.attrs))
      if (
        (!attributes.has(key) &&
          !["class", "data-jobs-corpus-field", "value"].includes(key)) ||
        typeof text !== "string" ||
        text.length > 1200 ||
        (key === "value" &&
          (node.tag !== "option" ||
            (text !== "" && !/^option-\d+$/.test(text))))
      )
        throw Error("Unsafe corpus attribute");
    for (const child of [...node.children, ...(node.shadow || [])])
      inspect(child, depth + 1);
  }
  value.trees.forEach((node) => inspect(node));
  return value;
}

export function mountCorpus(doc, value) {
  validateCorpus(value);
  function mount(item) {
    if (Object.hasOwn(item, "text")) return doc.createTextNode(item.text);
    const node = doc.createElement(item.tag);
    for (const [key, value] of Object.entries(item.attrs))
      node.setAttribute(key, value);
    if (item.hidden) node.style.display = "none";
    for (const child of item.children) node.append(mount(child));
    if (item.shadow) {
      const shadow = node.attachShadow({ mode: "open" });
      for (const child of item.shadow) shadow.append(mount(child));
    }
    return node;
  }
  for (const item of value.trees) doc.body.append(mount(item));
}
