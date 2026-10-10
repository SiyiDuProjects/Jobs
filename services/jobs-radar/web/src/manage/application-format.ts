export const dateLabel = (value: string) => {
  const d = new Date(value);
  return isNaN(+d)
    ? "—"
    : d.toLocaleDateString("zh-CN", {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      });
};
