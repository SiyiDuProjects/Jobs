// Object key order is irrelevant; array order remains meaningful.
export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  return value;
}
export const stableStringify = (value) => JSON.stringify(stableValue(value));
export const sameValue = (a, b) => stableStringify(a) === stableStringify(b);
