import {
  getLocalTimeZone,
  parseDate,
  today,
  type CalendarDate,
} from "@internationalized/date";

export type DateWindow = { start: CalendarDate; end: CalendarDate };

export function readDateWindow(value: unknown): DateWindow | null {
  if (typeof value !== "string" || !value) return null;
  try {
    if (value === "today" || value === "last7") {
      const end = today(getLocalTimeZone());
      return {
        start: value === "last7" ? end.subtract({ days: 6 }) : end,
        end,
      };
    }
    const dates = value.split("/");
    if (dates.length > 2) return null;
    const start = parseDate(dates[0]),
      end = parseDate(dates[1] ?? dates[0]);
    return start.compare(end) <= 0 ? { start, end } : null;
  } catch {
    return null;
  }
}

export function normalizeDateWindow(value: unknown): string {
  if (value === "today" || value === "last7") return value;
  const range = readDateWindow(value);
  return range ? `${range.start}/${range.end}` : "";
}

export function dateWindowLabel(value: string): string {
  if (value === "today") return "今天";
  if (value === "last7") return "近 7 天";
  const range = readDateWindow(value);
  if (!range) return "全部时间";
  const currentYear = today(getLocalTimeZone()).year;
  const format = (date: CalendarDate) =>
    date
      .toString()
      .slice(
        range.start.year === currentYear && range.end.year === currentYear
          ? 5
          : 0,
      )
      .replaceAll("-", "/");
  return range.start.compare(range.end) === 0
    ? format(range.start)
    : `${format(range.start)} – ${format(range.end)}`;
}

export function addedRange(value: string): Record<string, string> {
  const range = readDateWindow(value);
  if (!range) return {};
  const zone = getLocalTimeZone();
  // The chosen end day is inclusive; use the next local midnight across DST changes.
  return {
    added_since: String(range.start.toDate(zone).getTime() / 1000),
    added_before: String(
      range.end.add({ days: 1 }).toDate(zone).getTime() / 1000,
    ),
  };
}
