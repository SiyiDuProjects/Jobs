// Only bounded measurements and visibility enums can leave the event detail.
// Questions, answers, URLs and arbitrary diagnostic text are never metrics.
export function historyEventMetrics(type, detail) {
  if (type === "visibility_changed")
    return ["hidden", "visible"].includes(detail) ? { visibility: detail } : {};
  if (
    !["auto_run_timing", "auto_write_timing", "auto_answer_batch"].includes(
      type,
    )
  )
    return {};
  let value;
  try {
    value = typeof detail === "string" ? JSON.parse(detail) : detail;
  } catch {
    value = null;
  }
  if (type === "auto_answer_batch") {
    const keys = ["fieldCount", "cacheHits", "modelFields", "modelCalls"];
    if (
      value &&
      value.unavailable !== true &&
      keys.every(
        (key) =>
          Number.isInteger(value[key]) &&
          value[key] >= 0 &&
          value[key] <= (key === "modelCalls" ? 2 : 30),
      ) &&
      value.fieldCount > 0 &&
      value.cacheHits + value.modelFields <= value.fieldCount &&
      (value.modelCalls === 0) === (value.modelFields === 0)
    )
      return {
        answerUsage: Object.fromEntries(keys.map((key) => [key, value[key]])),
      };
    return { answerUsage: { unavailable: true } };
  }
  const numbers = (input, keys) => {
    const result = {};
    if (!input || typeof input !== "object" || Array.isArray(input))
      return result;
    for (const key of keys) {
      const n = input[key],
        max = key === "ms" || key === "heldMs" ? 86400000 : 1000000;
      if (Number.isInteger(n) && n >= 0 && n <= max) result[key] = n;
    }
    return result;
  };
  const timing = numbers(
    value,
    type === "auto_write_timing"
      ? ["ms", "heldMs", "scans"]
      : ["ms", "scans", "structuralScans"],
  );
  if (type === "auto_run_timing") {
    for (const [key, fields] of Object.entries({
      writes: ["writes", "ms", "heldMs", "scans"],
      profileChecks: ["count", "fresh", "ms", "reused"],
    })) {
      const nested = numbers(value?.[key], fields);
      if (Object.keys(nested).length) timing[key] = nested;
    }
  }
  return Object.keys(timing).length ? { timing } : {};
}
