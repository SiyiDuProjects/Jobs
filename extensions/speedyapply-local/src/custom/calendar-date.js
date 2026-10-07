export function calendarDate(value) {
  if (typeof value !== "string") return null;
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!iso && !us) return null;
  const [year, month, day] = iso
    ? [+iso[1], +iso[2], +iso[3]]
    : [+us[3], +us[1], +us[2]];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
    return null;
  return {
    year,
    month,
    day,
    iso: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}
