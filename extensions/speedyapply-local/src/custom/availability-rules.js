export var JobsAvailabilityRules;
let initialized = false;
export function initializeAvailabilityRules() {
  if (initialized) return;
  initialized = true;
  (() => {
    // Whole terminal statements, allowing a courtesy prefix and a reference to
    // the posting being viewed. Never match a closed/filled keyword in prose.
    const apology = "(?:(?:we(?:'re| are) )?sorry[.!…,: -]*\\s*)?";
    const subject =
      "(?:this|the) (?:job(?: posting| requisition)?|position)(?: (?:that |which )?you(?: are|'re) (?:trying to apply for|applying for|looking for|interested in))?";
    const messages = {
      page_missing:
        /^the page you are looking for (?:doesn't|does not) exist[.!]?$/i,
      job_missing: new RegExp(
        "^" +
          apology +
          subject +
          " (?:is no longer available|has been closed|has been filled|does not exist|was not found)[.!]?$",
        "i",
      ),
      applications_closed: new RegExp(
        "^" + apology + subject + " is no longer accepting applications[.!]?$",
        "i",
      ),
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
