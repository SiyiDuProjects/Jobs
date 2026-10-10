import { format, parse } from "date-fns";
export function jobsFormatProfileMonth(value, pattern) {
  return format(parse(value, "yyyy-MM", new Date()), pattern);
}
export function jobsFormatProfileDate(value, pattern = "MM/dd/yyyy") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return undefined;
  const parsed = parse(value, "yyyy-MM-dd", new Date());
  if (Number.isNaN(parsed.getTime()) || format(parsed, "yyyy-MM-dd") !== value)
    return undefined;
  return format(parsed, pattern);
}
export function jobsFormatToday(pattern = "MM/dd/yyyy") {
  return format(new Date(), pattern);
}
export function jobsIsProfileMonthInPast(value) {
  const [year, month] = value.split("-");
  return new Date(Number(year), Number(month) - 1) < new Date();
}
export function jobsProfileWebsiteEntries(websites) {
  return [
    { name: "LinkedIn", url: websites.linkedin },
    { name: "GitHub", url: websites.github },
    { name: "X aka Twitter", url: websites.twitter },
    { name: "Personal", url: websites.personal },
    ...(websites.websites || []).map((url, index) => ({
      name: "Website " + (index + 1),
      url,
    })),
  ].filter((row) => typeof row.url === "string" && row.url.trim());
}
export function jobsFormatFullName(name) {
  return name.firstName + " " + name.lastName;
}
export function jobsFormatStreetAddress(address) {
  return address.line2 ? address.line1 + ", " + address.line2 : address.line1;
}
