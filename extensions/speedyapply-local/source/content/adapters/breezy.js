import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsUploadResume,
  jobsWaitForCssNodes,
} from "../shared/dom-controls.js";
import { jobsFormatFullName } from "../shared/profile-format.js";
import { jobsTrackApplicationOnUnload } from "../shared/response-capture.js";
// Each Breezy section runs as one page pipeline: the first declares Profile
// facts, history and disclosures; every section then gets the rules (veteran
// status and the questionnaire), AI for remaining required answers, review
// and navigation to the next section.
async function breezyRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  return jobsWaitForCssNodes(JobsPlatformConfig.structure.breezy.root).then(
    async ([root]) => {
      const profile = await getProfile();
      setMessage(`uploading-resume`);
      if (!(await breezyUploadResume(profile.resumeData, setMessage, context)))
        return;
      await jobsMountManualAnswerControls(context, [
        [
          `//textarea[@name='cSummary' or @name='cCoverLetter']`,
          `preceding-sibling::div[contains(@class, 'section-header')][1]`,
        ],
        [`//div[contains(@class, 'questionnaire-section')]//textarea`, `..`],
      ]);
      await breezyTrackApplication(Boolean(autofillSettings.saveApplications));
      const reader = JobsControlFields.create(document, () => root);
      const shape = () =>
        reader
          .scan()
          .map((row) => row.public.id + ":" + row.public.question)
          .join("|");
      let fill = (current) => breezyFillApplication(profile, current);
      while (root.isConnected && !context?.isInvalid) {
        const before = shape();
        const next = [
          ...root.querySelectorAll(JobsPlatformConfig.structure.breezy.next),
        ].filter(reader.visible);
        const submit = [
          ...root.querySelectorAll(JobsPlatformConfig.structure.breezy.submit),
        ].filter(reader.visible);
        const action =
          next.length === 1
            ? autofillSettings.autoClickNextPage
              ? "next"
              : "fill"
            : submit.length === 1 && autofillSettings.autoSubmit
              ? "submit"
              : "fill";
        const target =
          action === "next"
            ? next[0]
            : action === "submit"
              ? submit[0]
              : undefined;
        const done = await JobsAutomatic.advance({
          root,
          profile,
          action,
          target,
          setMessage,
          canProceed: () => !context?.isInvalid,
          fill,
        });
        fill = undefined;
        if (!done || action !== "next") return;
        const changed = await JobsDOMWait.until(
          () => !root.isConnected || context?.isInvalid || shape() !== before,
          { root, timeout: 5000 },
        );
        if (!changed) {
          setMessage("complete-manually");
          return;
        }
      }
    },
  );
}
async function breezyFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  // A required summary takes the Profile's work history.
  const summary = () =>
    /** @type {HTMLTextAreaElement} */ (
      document.querySelector(`textarea[name='cSummary']`)
    )?.required
      ? document.querySelector(`textarea[name='cSummary']`)
      : null;
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "name",
        find: `input[name='cName']`,
        answer: jobsFormatFullName(profile.nameData),
      },
      {
        name: "email",
        find: `input[name='cEmail']`,
        answer: profile.contactData.email,
      },
      {
        name: "phone",
        find: `input[name='cPhoneNumber']`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "address",
        find: `input[name='cAddress']`,
        answer: breezyFormatAddress(profile.addressData),
      },
      {
        name: "summary",
        find: summary,
        answer: (profile.jobData || [])
          .map(
            (job) =>
              [job.jobTitle, job.company].filter(Boolean).join(" at ") +
              (job.description ? "\n" + job.description : ""),
          )
          .filter(Boolean)
          .join("\n\n"),
      },
    ]),
  );
  await section(`employment`, () =>
    breezyFillEmploymentHistory(profile.jobData),
  );
  await section(`education`, () =>
    breezyFillEducationHistory(profile.educationData),
  );
  await section(`disclosures`, () =>
    breezyFillDisclosures(profile.employmentData),
  );
  await JobsFormPipeline.bind([
    {
      name: "gdpr-agreement",
      find: `input[name='gdprAgreement']`,
      topic: "consent",
    },
  ]);
}
async function breezyUploadResume(
  resume,
  setMessage,
  context,
  timeout = 45000,
) {
  const root = document.querySelector(JobsPlatformConfig.structure.breezy.root);
  const reader = JobsControlFields.create(document);
  const visible = (node) => reader.visible(node) && !node.closest(`.ng-hide`);
  const read = () => {
    if (!root?.isConnected || context?.isInvalid) return `stopped`;
    const input = root.querySelector(`input[name='cResume']`);
    const area = input?.closest(`.file-input-container`);
    if (!area) return null;
    if (
      Array.from(area.querySelectorAll(`.error-container`)).some(
        (node) => visible(node) && node.textContent.trim(),
      )
    )
      return `failed`;
    if (
      Array.from(
        root.querySelectorAll(`.resume [ng-if='uploadingResume']`),
      ).some(visible)
    )
      return null;
    // Breezy renders this link only after accepting the attachment. Its
    // structure survives localization, including a skipped "uploading" frame.
    const attached = area.querySelector(
      `a[ng-if='candidate.resume.file_name']`,
    );
    const ready = Array.from(root.querySelectorAll(`.resume [ng-if]`)).find(
      (node) =>
        node.getAttribute(`ng-if`).replace(/\s+/g, ``) ===
          `!uploadingResume&&candidate.resume.file_name` && visible(node),
    );
    return attached &&
      visible(attached) &&
      attached.textContent.trim() &&
      ready &&
      visible(ready)
      ? `attached`
      : null;
  };
  try {
    const initial = read();
    if (initial === `attached`) return true;
    if (initial === `stopped`) return false;
    const uploading = Array.from(
      root.querySelectorAll(`.resume [ng-if='uploadingResume']`),
    ).some(visible);
    if (!uploading) await jobsUploadResume(resume, `input[name='cResume']`);
    const result = await JobsDOMWait.until(read, { root: document, timeout });
    if (result === `attached`) return true;
    if (result !== `stopped`)
      setMessage(
        result === `failed` ? `resume-upload-failed` : `resume-upload-timeout`,
      );
  } catch {
    if (!context?.isInvalid) setMessage(`resume-upload-failed`);
  }
  return false;
}
function breezyFormatAddress(address) {
  let t = address.line1;
  return (
    address.line2 && (t += `, ${address.line2}`),
    (t += `, ${address.city}`),
    address.state && (t += `, ${address.state}`),
    (t += `, ${address.postalCode}, ${address.country}`),
    t
  );
}
async function breezyFillEmploymentHistory(employmentEntries) {
  await breezyFillHistory(
    employmentEntries,
    "candidatePosition in candidate.work_history",
    "addPosition()",
    "candidatePosition",
    [
      ["company_name", "company"],
      ["title", "jobTitle"],
      ["summary", "description"],
    ],
  );
}
async function breezyFillEducationHistory(educationEntries) {
  await breezyFillHistory(
    educationEntries,
    "candidateSchool in candidate.education",
    "addEducation()",
    "candidateSchool",
    [
      ["school_name", "school"],
      ["field_of_study", "fieldOfStudy"],
    ],
  );
}
async function breezyFillHistory(entries, repeat, add, model, fields) {
  const reader = JobsControlFields.create(document);
  const button = [...document.querySelectorAll("a[ng-click]")].find(
    (node) =>
      node.getAttribute("ng-click").includes(add) && reader.visible(node),
  );
  if (!button) return;
  const rows = () => [
    ...document.querySelectorAll(`li[ng-repeat="${repeat}"]`),
  ];
  const selector = (key) => `[ng-model="${model}.${key}"]`;
  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase();
  for (const entry of entries || []) {
    // Resume-parsed/user entries are authoritative; never delete or rewrite them.
    const existing = rows();
    let row = existing.find(
      (node) =>
        normalize(
          /** @type {HTMLInputElement} */ (
            node.querySelector(selector(fields[0][0]))
          )?.value,
        ) === normalize(entry[fields[0][1]]),
    );
    if (!row)
      row = existing.find((node) =>
        fields.every(
          ([key]) =>
            !(
              /** @type {HTMLInputElement} */ (
                node.querySelector(selector(key))
              )?.value.trim()
            ),
        ),
      );
    if (!row) {
      if (!JobsPageActions.click(button)) return;
      row = await JobsDOMWait.until(
        () => rows().find((node) => !existing.includes(node)),
        { root: document, timeout: 2500 },
      );
    }
    if (!row) throw Error("Breezy history entry did not appear");
    await JobsFormPipeline.bind(
      fields.map(([key, field]) => ({
        name: `${model}.${key}`,
        find: () => row.querySelector(selector(key)),
        answer: entry[field],
      })),
    );
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function breezyFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "race",
      find: `input[id^='race_']`,
      answer: eeo(`race`, employment),
    },
    {
      name: "gender",
      find: `input[id^='gender_']`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "disability",
      find: `input[id^='disability_']`,
      answer: eeo(`disability`, employment),
    },
  ]);
}
async function breezyTrackApplication(record = true) {
  let e = document.querySelector(`#heroBackgroundColor h1`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href,
    r = n.match(/^(https:\/\/[^\s]+\.breezy\.hr\/p\/[a-z0-9]+-[^/]+)/),
    i = r ? r[1] : ``,
    a = n.match(/^(https:\/\/[^\s]+\.breezy\.hr)/),
    o = a ? a[1] : ``;
  jobsTrackApplicationOnUnload(
    `//button[@ng-click='apply()']`,
    t,
    i,
    o,
    ``,
    !0,
    undefined,
    undefined,
    record,
  );
}

export {
  breezyRunApplication,
  breezyFillApplication,
  breezyUploadResume,
  breezyFormatAddress,
  breezyFillEmploymentHistory,
  breezyFillEducationHistory,
  breezyFillHistory,
  breezyFillDisclosures,
  breezyTrackApplication,
};
