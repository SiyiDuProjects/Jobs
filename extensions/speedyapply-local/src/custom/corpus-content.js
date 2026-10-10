import { captureCorpus } from "./corpus-case.js";
import { JobsBuildInfo } from "./build-info.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsProfileAnswers } from "./profile-answers.js";
let context;
let listening = false;
function profileStamp(profile) {
  const { resumeBase64, ...resumeData } = profile?.resumeData || {};
  return JobsProfileAnswers.signature({ ...profile, resumeData });
}
export function bindCorpusPage(root, profile, reader, isReview) {
  const doc = root.ownerDocument || root;
  context = { root, profile, reader, isReview, url: doc.location.href };
  if (!listening) {
    listening = true;
    doc.addEventListener(
      "click",
      (event) => {
        if (
          event.isTrusted &&
          JobsControlFields.continuation(
            event.composedPath?.()[0] || event.target,
          )
        )
          captureCorpusPage();
      },
      true,
    );
    doc.defaultView.addEventListener("pagehide", () => {
      context = null;
    });
    // Manual edits may cancel the fill operation but still need a snapshot.
    // A Profile switch must retire the old redaction context independently.
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (
        area === "session" &&
        context &&
        Object.entries(changes).some(([key, change]) => {
          const record = /** @type {{profile?:object}|undefined} */ (
            change.newValue
          );
          return (
            key.startsWith("profile_") &&
            profileStamp(record?.profile) !== profileStamp(context.profile)
          );
        })
      )
        context = null;
    });
  }
}
export function captureCorpusPage(correctionNode = null) {
  if (!context?.root?.isConnected || context.isReview()) return;
  try {
    const { root, profile, reader } = context;
    const doc = root.ownerDocument || root;
    if (doc.location.href !== context.url) return;
    if (
      doc.querySelector(
        '[data-automation-id="reviewJobApplicationPage"],[data-automation-id="applyFlowReviewPage"]',
      )
    )
      return;
    const rows = reader.scan();
    const value = captureCorpus({
      root,
      rows,
      profile,
      review: context.isReview(),
      platform: JobsPlatformConfig.detect(doc).id || "unknown",
      build: JobsBuildInfo.id,
      company: doc.location.hostname,
      step: doc.querySelector('[aria-current="step"]')?.textContent || "",
    });
    const correctionIndex = rows.findIndex(
      (row) => row.node === correctionNode,
    );
    if (value)
      void chrome.runtime
        .sendMessage({
          type: "jobs:corpus-page",
          value,
          ...(correctionIndex >= 0
            ? {
                correction: "field-" + (correctionIndex + 1),
                correctionId: crypto.randomUUID(),
              }
            : {}),
        })
        .then((response) => {
          if (response?.error) failed();
        }, failed);
  } catch {
    failed();
  }
}
// Never log page text, search terms, server payloads or Profile values.
function failed() {
  JobsDiagnostics?.note(
    "corpus_capture_failed",
    null,
    "Private corpus sync unavailable; page action unaffected",
  );
}
