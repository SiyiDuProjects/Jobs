// Native selection provenance. A default option alone does not prove that the
// person chose it. Keep interaction history outside the page's attributes.
// Both document_start and the main bundle run in the same isolated world.
const documents = (globalThis.__jobsSelectStates ??= new WeakMap());
function observe(doc, { fromStart = false } = {}) {
  if (documents.has(doc)) return documents.get(doc);
  const nodes = new WeakSet(),
    keys = new Set();
  const key = (node) =>
    node.id || (node.name && `${node.form?.id || ""}:${node.name}`);
  const changed = (event) => {
    const node = (event.composedPath?.()[0] || event.target)?.closest?.(
      "select",
    );
    if (
      !node ||
      (!event.isTrusted && !["input", "change"].includes(event.type))
    )
      return;
    nodes.add(node);
    if (key(node)) keys.add(key(node));
  };
  // Scripted change events also protect a value supplied by the site, another
  // autofiller, or our own writer. Hardware interaction protects an unchanged
  // selection too, including choosing the default again before a later run.
  for (const type of ["pointerdown", "keydown", "input", "change"])
    doc.addEventListener(type, changed, true);
  const state = {
    touched: (node) => nodes.has(node) || (key(node) && keys.has(key(node))),
    protect(node) {
      nodes.add(node);
      if (key(node)) keys.add(key(node));
    },
  };
  // After reload/reconnection we cannot reconstruct earlier user choices.
  // Protect all existing controls; newly rendered controls remain observable.
  if (!fromStart || doc.readyState !== "loading")
    for (const node of doc.querySelectorAll("select")) state.protect(node);
  documents.set(doc, state);
  return state;
}
function initial(node) {
  if (
    !node.matches?.("select:not([multiple])") ||
    observe(node.ownerDocument).touched(node)
  )
    return false;
  // Browser-restored non-default answers and explicitly selected later options
  // are retained. Browser user/autofill state supplies additional protection.
  if (node.matches(":user-valid,:user-invalid,:autofill")) return false;
  const first = node.options[0];
  return (
    node.selectedIndex === 0 &&
    !first?.disabled &&
    (first?.defaultSelected ||
      ![...node.options].some((option) => option.defaultSelected))
  );
}
export const JobsSelectState = Object.freeze({
  observe,
  initial,
  protect(node) {
    if (node.matches?.("select")) observe(node.ownerDocument).protect(node);
  },
});
