export function listDate(value: string | number | null | undefined) {
  if (!value) return "—";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(+date)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear()
      ? { year: "numeric" as const }
      : {}),
  }).format(date);
}
