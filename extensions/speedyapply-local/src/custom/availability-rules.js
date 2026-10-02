export var JobsAvailabilityRules;
let initialized = false;
export function initializeAvailabilityRules() {
  if (initialized) return;
  initialized = true;
  (() => {
    const messages = {
      page_missing:
        /^the page you are looking for (?:doesn't|does not) exist[.!]?$/i,
      job_missing:
        /^(?:this|the) (?:job|position|job posting|job requisition) (?:is no longer available|has been closed|has been filled|does not exist|was not found)[.!]?$/i,
      applications_closed:
        /^(?:this|the) (?:job|position|job posting) is no longer accepting applications[.!]?$/i,
    };
    const normalize = (value) =>
      String(value || "")
        .replaceAll("’", "'")
        .replace(/\s+/g, " ")
        .trim();
    const code = (quote) =>
      Object.keys(messages).find((key) => messages[key].test(normalize(quote)));
    JobsAvailabilityRules = Object.freeze({ code, normalize });
  })();
}
