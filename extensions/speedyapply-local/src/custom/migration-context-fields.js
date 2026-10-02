// Source-proven legacy fields inside otherwise operational settings. Only the
// explicit migrator reads their values; readiness reports selectors, not text.
export function contextPointers(key, value) {
  const rows =
    key === "configList" && Array.isArray(value)
      ? value.map((item, index) => [
          "/" + index + "/premiumSettings/responseContext",
          item,
        ])
      : key === "settings"
        ? [["/premiumSettings/responseContext", value]]
        : [];
  return rows
    .filter(
      ([, item]) =>
        item &&
        typeof item === "object" &&
        item.premiumSettings &&
        typeof item.premiumSettings === "object" &&
        Object.hasOwn(item.premiumSettings, "responseContext") &&
        item.premiumSettings.responseContext !== "" &&
        item.premiumSettings.responseContext != null,
    )
    .map(([pointer]) => String(pointer));
}
