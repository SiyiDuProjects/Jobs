// A text signature identifies the applicant; a declaration checkbox remains a
// separate answer. The calendar date is supplied by the extension, not the site.
export function signatureAnswer(question, profile, context, date) {
  const label = question.replace(/[?:.]+$/g, "").trim();
  const kind = context.inputType || context.type || "text";
  const combined =
    label.endsWith("signature and date") || label.endsWith("signature & date");
  const signature = label.endsWith("signature") || combined;
  const signingDate =
    ["date", "text"].includes(kind) &&
    (label === "date signed" ||
      label === "signature date" ||
      label === "today's date" ||
      (label.endsWith("date") &&
        (label.includes("certify") || label.includes("signature"))));
  if (
    !["text", "textarea", "date"].includes(kind) ||
    (!signature && !signingDate)
  )
    return null;
  const name = [
    profile?.nameData?.firstName,
    profile?.nameData?.middleName,
    profile?.nameData?.lastName,
  ]
    .filter(Boolean)
    .join(" ");
  const value =
    signingDate && !combined
      ? date
      : name
        ? name + (combined ? " — " + date : "")
        : null;
  return {
    topic: "signature",
    field: signingDate && !combined ? "calendar.today" : "nameData.fullName",
    kind: "text",
    source: "profile",
    profileOnly: true,
    answer: value,
    aliases: value ? [value] : [],
    reason: value ? "profile" : "missing_profile_field",
  };
}
