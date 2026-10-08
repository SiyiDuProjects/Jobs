// A text signature identifies the applicant; a declaration checkbox remains a
// separate answer. The calendar date is supplied by the extension, not the site.
export function signatureAnswer(question, profile, context, date) {
  const label = question.replace(/[?:.]+$/g, "").trim();
  const kind = context.inputType || context.type || "text";
  if (
    !["text", "textarea"].includes(kind) ||
    !(
      label.endsWith("signature and date") || label.endsWith("signature & date")
    )
  )
    return null;
  const name = [
    profile?.nameData?.firstName,
    profile?.nameData?.middleName,
    profile?.nameData?.lastName,
  ]
    .filter(Boolean)
    .join(" ");
  const value = name ? name + " — " + date : null;
  return {
    topic: "signature",
    field: "nameData.fullName",
    kind: "text",
    source: "profile",
    profileOnly: true,
    answer: value,
    aliases: value ? [value] : [],
    reason: value ? "profile" : "missing_profile_field",
  };
}
