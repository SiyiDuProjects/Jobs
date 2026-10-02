export const dateLabel = (value: string) => {
  const d = new Date(value);
  return isNaN(+d)
    ? "—"
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
};
