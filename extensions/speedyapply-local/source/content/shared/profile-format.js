import { format, parse } from "date-fns";
export function jobsFormatProfileMonth(value, pattern) {
  return format(parse(value, "yyyy-MM", new Date()), pattern);
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
