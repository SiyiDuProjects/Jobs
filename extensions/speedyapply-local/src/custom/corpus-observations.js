// Transient observations only. Personal search terms never enter diagnostics or
// browser storage; they accompany the private corpus upload for this page.
let observations = new WeakMap();
export function recordCorpusOptions(node, labels, query = "") {
  if (!node || !Array.isArray(labels)) return;
  const entry = observations.get(node) || [];
  const record = {
    query: String(query || "").slice(0, 500),
    options: labels.slice(0, 1000).map((label) => String(label).slice(0, 500)),
  };
  if (!entry.some((old) => JSON.stringify(old) === JSON.stringify(record)))
    entry.push(record);
  observations.set(node, entry.slice(-20));
}
export const corpusOptions = (node) => observations.get(node) || [];
export function resetCorpusOptions() {
  observations = new WeakMap();
}
