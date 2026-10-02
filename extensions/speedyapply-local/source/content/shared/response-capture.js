import { JobsJobMatch } from "../../../src/custom/job-match.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "./runtime-messages.js";
import { jobsFindXPath } from "./dom-controls.js";
function jobsTrackApplicationOnUnload(
  selector,
  jobTitle,
  jobLink,
  companyLink,
  companyName = ``,
  useXPath = !1,
  timeout = 5e3,
  onRecorded,
  record = true,
) {
  if (JobsJobMatch?.same(jobLink, location.href))
    void jobsReportJobTitle(jobTitle);
  if (!record) return;
  const button = useXPath
    ? jobsFindXPath(selector)
    : document.querySelector(selector);
  if (!button) return;
  let recording = false;
  // Product policy: Applied records submission attempts. Send while the page
  // is still alive; unload handlers can be skipped when a tab closes quickly.
  button.addEventListener(
    "click",
    () => {
      if (
        recording ||
        button.disabled ||
        button.getAttribute("aria-disabled") === "true"
      )
        return;
      recording = true;
      void jobsSaveApplicationRecord({
        jobTitle,
        jobLink,
        companyLink,
        companyName,
        jobsSyncProof: "submit_attempt",
      }).then(
        () => onRecorded?.(),
        (error) => {
          recording = false;
          JobsDiagnostics?.note(
            "application_record_failed",
            button,
            String(error?.message || error),
          );
        },
      );
    },
    true,
  );
}

export { jobsTrackApplicationOnUnload };
