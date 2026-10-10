// Canonical new Profile facts shared by all ATS adapters. Defaults remain after
// same-question person answers in the server evaluator, never ahead of them.
export function extraProfileAnswer(question, profile, context = {}) {
  if (context.description?.trim()) return null;
  const label = String(question || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[?*:。？]+$/g, "")
    .trim();
  const app = profile?.applicationData || {},
    emp = profile?.employmentData || {};
  const facts = {
    "visa status": ["applicationData.visaStatus", app.visaStatus],
    "immigration status": ["applicationData.visaStatus", app.visaStatus],
    "available until": ["applicationData.availableUntil", app.availableUntil],
    "internship end date": [
      "applicationData.availableUntil",
      app.availableUntil,
    ],
    "how did you hear about this position": [
      "applicationData.defaultSource",
      app.defaultSource,
    ],
    "how did you hear about us": [
      "applicationData.defaultSource",
      app.defaultSource,
    ],
    citizenship: [
      "employmentData.citizenships",
      emp.citizenships?.length === 1 ? emp.citizenships[0] : null,
    ],
    nationality: [
      "employmentData.citizenships",
      emp.citizenships?.length === 1 ? emp.citizenships[0] : null,
    ],
  };
  let [field, value] = facts[label] || [];
  let kind = "literal",
    aliases = [];
  const boolean = (path, value) => {
    field = path;
    kind = "boolean";
    return typeof value === "boolean" ? (value ? "Yes" : "No") : null;
  };
  if (
    /^are you (?:a (?:u\.?s\.?|united states)|an american) citizen$/.test(label)
  ) {
    const countries = (emp.citizenships || []).map((v) => v.toLowerCase());
    value = boolean(
      "employmentData.citizenships",
      countries.length
        ? countries.some((v) =>
            ["united states", "united states of america", "us", "usa"].includes(
              v,
            ),
          )
        : app.visaStatus === "US citizen"
          ? true
          : undefined,
    );
  }
  if (
    [
      "gender identity",
      "sexual orientation",
      "are you transgender",
      "are you lgbtq+",
      "do you identify as lgbtq+",
    ].includes(label)
  ) {
    field = "employmentData.identityDefaults";
    if (emp.identityDefaults === "undisclosed") {
      value = "Prefer not to disclose";
      aliases = [value, "Prefer not to answer", "I choose not to disclose"];
    } else if (emp.identityDefaults === "cis_heterosexual") {
      value =
        label === "gender identity"
          ? emp.gender
          : label === "sexual orientation"
            ? "Heterosexual"
            : boolean(field, false);
      if (label === "sexual orientation")
        aliases = [value, "Straight", "Heterosexual or straight"];
    }
  }
  const employer = label.match(
    /^have you (?:ever|previously) (?:worked (?:at|for)|been employed by) (.+)$/,
  );
  if (employer && Array.isArray(profile?.jobData)) {
    const name = employer[1].trim();
    if (
      !["us", "this company", "our company"].includes(name) &&
      !/\b(and|or|within|since|during|affiliates?|subsidiaries)\b/.test(name)
    )
      value = boolean(
        "jobData",
        profile.jobData.some((j) => j.company?.trim().toLowerCase() === name),
      );
  }
  if (!field) return null;
  if (value === undefined || value === null || value === "") return null;
  if (field === "applicationData.availableUntil") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      return {
        field,
        answer: null,
        aliases: [],
        reason: "missing_day_precision",
      };
    kind = "exact-date";
  }
  return {
    field,
    topic: field,
    answer: String(value),
    aliases: aliases.length ? aliases : [String(value)],
    kind,
    profileOnly: true,
    source: "profile",
    reason: "profile",
  };
}
