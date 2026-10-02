import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsJobMatch } from "../../../src/custom/job-match.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsClick,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWatchXPathPresence,
} from "../shared/dom-controls.js";
import { jobsFormatProfileMonth } from "../shared/profile-format.js";
import { jobsTrackApplicationOnUnload } from "../shared/response-capture.js";
import { jobsSaveApplicationRecord } from "../shared/runtime-messages.js";

var greenhouseQuestionLabelXPath = `(//div[contains(@class, "application--questions")])[2]//label[contains(@id, "question_") and contains(@id, "-label")]`;
// Greenhouse job boards run as one page pipeline. This adapter declares where
// each Profile fact goes and adds history rows; JobsFormPipeline writes them
// through the common entrances. The sole resolver stage in
// JobsAutomatic continues with AI, review and navigation in the same run.
function greenhouseCombobox(labelXPath) {
  return jobsFindXPath(
    `${labelXPath}/following-sibling::div//input[@role="combobox"]`,
  );
}
// Structure: one history form per Profile entry, added with the page's
// button. A missing button or a form that never appears ends the additions.
async function greenhouseAddEntries(
  container,
  form,
  button,
  count,
  canProceed = () => true,
) {
  if (!document.querySelector(container)) return;
  for (
    let index = 0;
    index < count && JobsPageActions.live(canProceed);
    index++
  ) {
    if (jobsFindXPath(`(${form})[${index + 1}]`) !== null) continue;
    if (!document.querySelector(button)) break;
    jobsClick(button);
    if (
      !(await JobsDOMWait.until(
        () => jobsFindXPath(`(${form})[${index + 1}]`),
        { timeout: 5000 },
      ))
    ) {
      JobsDiagnostics?.note(`auto_repeat_section_failed`, null, form);
      break;
    }
  }
}
async function greenhouseFillContact(profile, canProceed = () => true) {
  const name = profile.nameData,
    preferred = !!(name.preferredName && name.preferredFirstName),
    answers = JobsProfileAnswers;
  return JobsFormPipeline.bind(
    [
      {
        name: "first-name",
        find: () => document.querySelector(`#first_name`),
        answer: name.firstName,
      },
      {
        name: "last-name",
        find: () => document.querySelector(`#last_name`),
        answer: name.lastName,
      },
      {
        name: "preferred-name",
        find: () =>
          document.querySelector(
            preferred
              ? `#preferred_name`
              : `#preferred_name[aria-required='true']`,
          ),
        answer: preferred ? name.preferredFirstName : name.firstName,
      },
      {
        name: "email",
        find: () => document.querySelector(`#email`),
        answer: profile.contactData.email,
      },
      {
        name: "phone",
        find: () => document.querySelector(`#phone`),
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "country",
        find: () => greenhouseCombobox(`//label[@id='country-label']`),
        answer: answers.countrySpec(profile.addressData.country),
      },
      {
        name: "location",
        find: () =>
          greenhouseCombobox(`//label[@id='candidate-location-label']`),
        answer: answers.locationSpec(profile.addressData),
      },
    ],
    { canProceed },
  );
}
async function greenhouseFillEducationHistory(
  educationEntries,
  canProceed = () => true,
) {
  const answers = JobsProfileAnswers;
  await greenhouseAddEntries(
    `.education--container`,
    `//div[@class='education--form']`,
    `.education--container .add-another-button`,
    educationEntries.length,
    canProceed,
  );
  for (let index = 0; index < educationEntries.length; index++) {
    const entry = educationEntries[index],
      label = (id) => `//label[@id='${id}--${index}-label']`;
    await JobsFormPipeline.bind(
      [
        {
          name: "school",
          find: () => greenhouseCombobox(label("school")),
          answer: answers.schoolSpec(entry.school),
        },
        // One degree rule for every ATS: this control's own options, the
        // confirmed subtype first, a level fallback, never an invented subtype.
        {
          name: "degree",
          find: () => greenhouseCombobox(label("degree")),
          answer: answers.degreeSpec(entry.degree),
        },
        {
          name: "discipline",
          find: () => greenhouseCombobox(label("discipline")),
          answer: () =>
            entry.fieldOfStudy &&
            answers.knownSpec(
              jobsFindXPath(label("discipline"))?.textContent,
              entry.fieldOfStudy,
            ),
        },
        {
          name: "start-month",
          find: () => greenhouseCombobox(label("start-month")),
          answer: answers.datePartSpec(entry.startDate, "month"),
        },
        {
          name: "start-year",
          find: () => document.querySelector(`input#start-year--${index}`),
          answer:
            entry.startDate && jobsFormatProfileMonth(entry.startDate, `yyyy`),
        },
        {
          name: "end-month",
          find: () => greenhouseCombobox(label("end-month")),
          answer: answers.datePartSpec(entry.endDate, "month"),
        },
        {
          name: "end-year",
          find: () => document.querySelector(`input#end-year--${index}`),
          answer:
            entry.endDate && jobsFormatProfileMonth(entry.endDate, `yyyy`),
        },
      ],
      { canProceed },
    );
  }
}
async function greenhouseFillEmploymentHistory(
  employmentEntries,
  canProceed = () => true,
) {
  const answers = JobsProfileAnswers;
  await greenhouseAddEntries(
    `.employment--container`,
    `//div[@class='employment-form']`,
    `.employment--container .add-another-button`,
    employmentEntries.length,
    canProceed,
  );
  for (let index = 0; index < employmentEntries.length; index++) {
    const entry = employmentEntries[index],
      label = (id) => `//label[@id='${id}-${index}-label']`;
    await JobsFormPipeline.bind(
      [
        {
          name: "company",
          find: () => document.querySelector(`input#company-name-${index}`),
          answer: entry.company,
        },
        {
          name: "title",
          find: () => document.querySelector(`input#title-${index}`),
          answer: entry.jobTitle,
        },
        {
          name: "start-month",
          find: () => greenhouseCombobox(label("start-date-month")),
          answer: answers.datePartSpec(entry.startDate, "month"),
        },
        {
          name: "start-year",
          find: () => document.querySelector(`input#start-date-year-${index}`),
          answer:
            entry.startDate && jobsFormatProfileMonth(entry.startDate, `yyyy`),
        },
        {
          name: "end-month",
          find: () => greenhouseCombobox(label("end-date-month")),
          answer: answers.datePartSpec(entry.endDate, "month"),
        },
        {
          name: "end-year",
          find: () => document.querySelector(`input#end-date-year-${index}`),
          answer:
            entry.endDate && jobsFormatProfileMonth(entry.endDate, `yyyy`),
        },
        {
          name: "current-role",
          find: () => document.querySelector(`#current-role-${index} input`),
          checked: entry.currentlyWorkHere === true ? true : undefined,
        },
      ],
      { canProceed },
    );
  }
}
async function greenhouseFillCustomQuestions(
  profile,
  saveResponses,
  canProceed = () => true,
) {
  const root = document.querySelector(
    JobsPlatformConfig.structure.greenhouse.root,
  );
}
// The shared question entrance tells ordinary from protected veteran status
// by this question's own wording and options.

// One EEO rule for every ATS; this form's own options decide the wording.
async function greenhouseFillDemographicQuestions(
  employment,
  canProceed = () => true,
) {
  const label = (keyword) =>
      `//label[not(@id='gender-label' or @id='race-label' or @id='hispanic_ethnicity-label' or @id='veteran_status-label' or @id='disability_status-label') and contains(${jobsLowercaseXPath(`.`)},'${keyword}')]`,
    eeo = JobsProfileAnswers.eeoSpec;
  return JobsFormPipeline.bind(
    [
      {
        name: "gender",
        find: () => greenhouseCombobox(label(`gender`)),
        answer: eeo(`gender`, employment),
      },
      {
        name: "race",
        find: () => greenhouseCombobox(label(`ethnic`)),
        answer: eeo(`race`, employment),
      },
      {
        name: "disability",
        find: () => greenhouseCombobox(label(`disability`)),
        answer: eeo(`disability`, employment),
      },
    ],
    { canProceed },
  );
}
async function greenhouseFillStandardDisclosures(
  employment,
  canProceed = () => true,
) {
  const label = (id) => `//label[@id='${id}-label']`,
    eeo = JobsProfileAnswers.eeoSpec;
  return JobsFormPipeline.bind(
    [
      {
        name: "gender",
        find: () => greenhouseCombobox(label(`gender`)),
        answer: eeo(`gender`, employment),
      },
      {
        name: "hispanic",
        find: () => greenhouseCombobox(label(`hispanic_ethnicity`)),
        answer: eeo(`hispanic`, employment),
      },
      {
        name: "race",
        find: () => greenhouseCombobox(label(`race`)),
        answer: eeo(`race`, employment),
      },
      {
        name: "disability",
        find: () => greenhouseCombobox(label(`disability_status`)),
        answer: eeo(`disability`, employment),
      },
    ],
    { canProceed },
  );
}
async function greenhouseTrackApplication(onRecorded, record = true) {
  let t = document.querySelector(`.job__title h1`),
    n = document.querySelector(`a.logo`),
    r = ``,
    i = ``;
  if (
    (t && t.textContent && (r = t.textContent), n && n.getAttribute(`href`))
  ) {
    let e = n.getAttribute(`href`) || ``;
    try {
      i = new URL(e).origin;
    } catch {
      i = ``;
    }
  }
  let a = window.location.href,
    o = document.title.split(` at `),
    s = o[1]?.trim() || ``;
  !r &&
    o.length > 0 &&
    (r = o[0]?.replace(`Job Application for `, ``).trim() || ``);
  let c = /https:\/\/job-boards(\.eu)?\.greenhouse\.io\/embed\/job_app/,
    l;
  if (c.test(a)) {
    let e = new URL(a);
    ((i ||= `${e.origin}/${e.searchParams.get(`for`)}`),
      (l = `${e.origin}/${e.searchParams.get(`for`)}/jobs/${e.searchParams.get(`token`)}`));
  } else {
    let e = a.match(/(https:\/\/.+?\/jobs\/\d+)/);
    l = e ? e[1] : ``;
    let t = a.match(/(https?:\/\/[^/]+\/[^/]+)/);
    if (((i ||= t ? t[1] : ``), !l)) return;
  }
  jobsTrackApplicationOnUnload(
    JobsPlatformConfig.structure.greenhouse.submit,
    r,
    l,
    i,
    s,
    !1,
    5e3,
    onRecorded,
    record,
  );
}
async function greenhouseReadUnresolvedResponses(answered) {
  return JobsFormPipeline.unresolved(
    /** @type {Element} */ (
      jobsFindXPath(greenhouseQuestionLabelXPath)
    )?.closest(`.application--questions`),
    answered,
  );
}
// The upload is confirmed by the attached file name. A Profile without a
// resume or a page without the control skips it; an upload that is never
// confirmed holds the step (no navigation) instead of blocking the pipeline.
async function greenhouseUploadResume(resume, canProceed = () => true) {
  if (!resume?.resumeBase64 || !document.querySelector(`#resume`)) {
    JobsDiagnostics?.note(
      `auto_upload_skipped`,
      null,
      resume?.resumeBase64 ? `no_control` : `no_resume`,
    );
    return null;
  }
  jobsUploadResume(resume, `#resume`);
  const confirmed = await JobsDOMWait.until(
    () =>
      !JobsPageActions.live(canProceed)
        ? { cancelled: true }
        : jobsFindXPath(
            `//div[@aria-labelledby="upload-label-resume"]//div[contains(@class, "file-upload__filename")]`,
          ),
    { timeout: 30000, interval: 250 },
  );
  return (confirmed && !confirmed.cancelled) || confirmed?.cancelled
    ? null
    : { hold: `resume_upload_unconfirmed` };
}
async function greenhouseFillApplication(
  profile,
  saveResponses,
  canProceed = () => true,
) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`contact`, () => greenhouseFillContact(profile, canProceed));
  await section(`education`, () =>
    greenhouseFillEducationHistory(profile.educationData, canProceed),
  );
  await section(`employment`, () =>
    greenhouseFillEmploymentHistory(profile.jobData, canProceed),
  );
  await section(`questions`, () =>
    greenhouseFillCustomQuestions(profile, saveResponses, canProceed),
  );
  await section(`demographics`, () =>
    greenhouseFillDemographicQuestions(profile.employmentData, canProceed),
  );
  await section(`disclosures`, () =>
    greenhouseFillStandardDisclosures(profile.employmentData, canProceed),
  );
  return section(`resume`, () =>
    greenhouseUploadResume(profile.resumeData, canProceed),
  );
}
var greenhouseLegacyQuestionLabelXPath = `//div[@id='custom_fields']//div[@class='field']/label`;
async function greenhouseLegacyFillContact(profile, canProceed = () => true) {
  await JobsFormPipeline.bind(
    [
      {
        name: "first-name",
        find: () => document.querySelector(`#first_name`),
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: () => document.querySelector(`#last_name`),
        answer: profile.nameData.lastName,
      },
      {
        name: "email",
        find: () => document.querySelector(`#email`),
        answer: profile.contactData.email,
      },
      {
        name: "phone",
        find: () => document.querySelector(`#phone`),
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "city",
        find: () => document.querySelector("#auto_complete_input"),
        answer: JobsProfileAnswers.locationSpec(profile.addressData),
      },
    ],
    { canProceed },
  );
}
// Legacy history dates are separate month and year text inputs ("9", "2021").
function greenhouseLegacyDatePart(value, part) {
  const parts = value?.split(`-`).map((item) => parseInt(item, 10));
  return parts?.length >= 2 &&
    Number.isInteger(parts[0]) &&
    Number.isInteger(parts[1])
    ? String(part === `month` ? parts[1] : parts[0])
    : null;
}
function greenhouseLegacyDateInput(section, edge, part, index) {
  return jobsFindXPath(
    `(//div[@class='${section}']//input[@type='text' and contains(@class, '${part}') and contains(@class, '${edge}-date-${part}')])[${index + 1}]`,
  );
}
async function greenhouseLegacyFillEducationHistory(
  educationEntries,
  canProceed = () => true,
) {
  const answers = JobsProfileAnswers;
  await greenhouseAddEntries(
    `#education_section`,
    `//div[@class='education']`,
    `#add_education`,
    educationEntries.length,
    canProceed,
  );
  for (let index = 0; index < educationEntries.length; index++) {
    const entry = educationEntries[index],
      date = (edge, part) => ({
        name: `${edge}-${part}`,
        find: () => greenhouseLegacyDateInput(`education`, edge, part, index),
        answer: greenhouseLegacyDatePart(entry[edge + `Date`], part),
      });
    await JobsFormPipeline.bind(
      [
        {
          name: "school",
          find: () =>
            jobsFindXPath(
              `//label[@for = 'education_school_name_${index}']/..//div//input`,
            ),
          answer: answers.schoolSpec(entry.school),
        },
        {
          name: "degree",
          find: () => document.querySelector(`#education_degree_${index}`),
          answer: answers.degreeSpec(entry.degree),
        },
        {
          name: "discipline",
          find: () => document.querySelector(`#education_discipline_${index}`),
          answer: answers.literalSpec("known-answer", entry.fieldOfStudy),
        },
        date(`start`, `month`),
        date(`start`, `year`),
        date(`end`, `month`),
        date(`end`, `year`),
      ],
      { canProceed },
    );
  }
}
async function greenhouseLegacyFillEmploymentHistory(
  employmentEntries,
  canProceed = () => true,
) {
  await greenhouseAddEntries(
    `#employment_section`,
    `//div[@class='employment']`,
    `#add_employment`,
    employmentEntries.length,
    canProceed,
  );
  for (let index = 0; index < employmentEntries.length; index++) {
    const entry = employmentEntries[index],
      date = (edge, part) => ({
        name: `${edge}-${part}`,
        find: () => greenhouseLegacyDateInput(`employment`, edge, part, index),
        answer: greenhouseLegacyDatePart(entry[edge + `Date`], part),
      });
    await JobsFormPipeline.bind(
      [
        {
          name: "company",
          find: () =>
            document.querySelector(`#employment_company_name_${index}`),
          answer: entry.company,
        },
        {
          name: "title",
          find: () => document.querySelector(`#employment_title_${index}`),
          answer: entry.jobTitle,
        },
        date(`start`, `month`),
        date(`start`, `year`),
        date(`end`, `month`),
        date(`end`, `year`),
        {
          name: "current-role",
          find: () => document.querySelector(`#employment_current_${index}`),
          checked: entry.currentlyWorkHere === true ? true : undefined,
        },
      ],
      { canProceed },
    );
  }
}
async function greenhouseLegacyFillCustomQuestions(
  profile,
  saveResponses,
  canProceed = () => true,
) {
  const root =
    document.querySelector(JobsPlatformConfig.structure.greenhouse.olderForm) ||
    document.querySelector(JobsPlatformConfig.structure.greenhouse.olderRoot);
}
async function greenhouseLegacyFillDemographicQuestions(
  employment,
  canProceed = () => true,
) {
  const field = (keyword) =>
    jobsFindXPath(
      `//div[@id='demographic_questions']//div[contains(@class,'field') and contains(${jobsLowercaseXPath(".")},'${keyword}')]//input[@type='radio' or @type='checkbox']`,
    );
  const eeo = JobsProfileAnswers.eeoSpec;
  return JobsFormPipeline.bind(
    [
      {
        name: "gender",
        find: () => field("gender"),
        answer: eeo("gender", employment),
      },
      {
        name: "legal-sex",
        find: () => field("legal sex"),
        answer: eeo("gender", employment),
      },
      {
        name: "race",
        find: () => field("ethnic"),
        answer: eeo("race", employment),
      },
      {
        name: "disability",
        find: () => field("disab"),
        answer: eeo("disability", employment),
      },
    ],
    { canProceed },
  );
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function greenhouseLegacyFillStandardDisclosures(
  employment,
  canProceed = () => true,
) {
  const eeo = JobsProfileAnswers.eeoSpec;
  return JobsFormPipeline.bind(
    [
      {
        name: "gender",
        find: () => document.querySelector(`#job_application_gender`),
        answer: eeo(`gender`, employment),
      },
      {
        name: "hispanic",
        find: () =>
          document.querySelector(`#job_application_hispanic_ethnicity`),
        answer: eeo(`hispanic`, employment),
      },
      {
        name: "race",
        find: () => document.querySelector(`#job_application_race`),
        answer: eeo(`race`, employment),
      },
      // The shared question entrance tells ordinary from protected veteran status.
      {
        name: "disability",
        find: () =>
          document.querySelector(`#job_application_disability_status`),
        answer: eeo(`disability`, employment),
      },
    ],
    { canProceed },
  );
}
async function greenhouseLegacyTrackApplication(record = true) {
  let e = document.querySelector(`h1.app-title`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href;
  t ||= n;
  let r = /https:\/\/boards(\.eu)?\.greenhouse\.io\/embed\/job_app/,
    i,
    a;
  if (r.test(n)) {
    let e = decodeURIComponent(n.split(`b=`)[1]);
    ((i = `${e}?gh_jid=${new URL(n).searchParams.get(`token`)}`),
      (a = new URL(e).origin),
      (t =
        /** @type {HTMLMetaElement} */ (
          document.querySelector(`meta[property="og:title"]`)
        )?.content ?? t));
  } else {
    let e = n.match(/(https:\/\/.+?\/jobs\/\d+)/);
    i = e ? e[1] : ``;
    let t = n.match(/(https?:\/\/[^/]+\/[^/]+)/);
    if (((a = t ? t[1] : ``), !i)) return;
  }
  jobsTrackApplicationOnUnload(
    JobsPlatformConfig.structure.greenhouse.olderSubmitAny,
    t,
    i,
    a,
    undefined,
    undefined,
    undefined,
    undefined,
    record,
  );
}
async function greenhouseLegacyReadUnresolvedResponses(answered) {
  return JobsFormPipeline.unresolved(
    /** @type {Element} */ (
      jobsFindXPath(greenhouseLegacyQuestionLabelXPath)
    )?.closest(`#custom_fields`),
    answered,
  );
}
async function greenhouseLegacyFillApplication(
  profile,
  saveResponses,
  canProceed = () => true,
) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`contact`, () =>
    greenhouseLegacyFillContact(profile, canProceed),
  );
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      jobsUploadResume(
        profile.resumeData,
        `#s3_upload_for_resume input[type='file']`,
      ),
  );
  await section(`education`, () =>
    greenhouseLegacyFillEducationHistory(profile.educationData, canProceed),
  );
  await section(`employment`, () =>
    greenhouseLegacyFillEmploymentHistory(profile.jobData, canProceed),
  );
  await section(`questions`, () =>
    greenhouseLegacyFillCustomQuestions(profile, saveResponses, canProceed),
  );
  await section(`demographics`, () =>
    greenhouseLegacyFillDemographicQuestions(profile.employmentData),
  );
  await section(`disclosures`, () =>
    greenhouseLegacyFillStandardDisclosures(profile.employmentData, canProceed),
  );
}
async function greenhouseObserveConfirmation(context, setMessage, record) {
  if (!record) return;
  const initialUrl = location.href;
  let recorded = false,
    pending;
  const inspect = async () => {
    const url = location.href;
    const jobLink =
      JobsPlatformConfig.structure.greenhouse.confirmationUrl.exec(
        location.origin + location.pathname,
      )?.[1];
    if (
      !jobLink ||
      !JobsJobMatch.same(initialUrl, jobLink) ||
      context.isInvalid ||
      recorded
    )
      return;
    if (pending) return pending;
    pending = (async () => {
      try {
        // An existing click plus this exact posting's receipt route confirms
        // the attempt. Visiting a guessed receipt URL alone creates no record.
        const prior = await chrome.runtime.sendMessage({
          type: "jobs:application-status",
          url: jobLink,
        });
        if (prior?.error) throw Error(prior.error);
        if (!prior?.data?.applied || context.isInvalid || location.href !== url)
          return;
        if (!prior.data.confirmed) {
          const reply = await jobsSaveApplicationRecord({
            jobLink,
            jobTitle: "",
            jobsSyncProof: "ats_confirmation",
          });
          if (reply?.ok !== true) throw Error("Receipt was not acknowledged");
        }
        recorded = true;
        if (!context.isInvalid && location.href === url)
          setMessage("confirmed");
      } catch {
        if (!context.isInvalid && location.href === url)
          setMessage("complete-manually");
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  for (const event of ["jobs:locationchange", "online", "focus"])
    context.addEventListener(window, event, inspect);
  await inspect();
}

async function greenhouseRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  await greenhouseObserveConfirmation(
    context,
    setMessage,
    autofillSettings.saveApplications,
  );
  if (
    JobsPlatformConfig.structure.greenhouse.confirmationUrl.test(
      location.origin + location.pathname,
    )
  )
    return;
  // Both Greenhouse forms run as one page pipeline: declared Profile facts
  // and the question block by rule, then AI for remaining required answers,
  // review and navigation. Filling starts once the page has loaded and the
  // form's fields stop changing, not after a fixed delay.
  const ready = async (form) => {
    await JobsDOMWait.until(() => document.readyState === `complete`, {
      root: document,
      timeout: 5000,
      interval: 100,
    });
    await JobsFormPipeline.settled(form);
  };
  (jobsWaitForCssNodes(JobsPlatformConfig.structure.greenhouse.olderRoot).then(
    async () => {
      const form =
        document.querySelector(
          JobsPlatformConfig.structure.greenhouse.olderForm,
        ) ||
        document.querySelector(
          JobsPlatformConfig.structure.greenhouse.olderRoot,
        );
      await ready(form);
      let i = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//div[@id='custom_fields']//textarea`, `parent::label`],
      ]);
      jobsWatchXPathPresence(
        `//textarea[@id='cover_letter_text']`,
        async () =>
          await jobsMountManualAnswerControls(context, [
            [
              `//textarea[@id='cover_letter_text']`,
              `ancestor::fieldset//label`,
            ],
          ]),
      );
      await greenhouseLegacyTrackApplication(
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile: i,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.greenhouse.olderSubmit,
        fill: (current) =>
          greenhouseLegacyFillApplication(
            i,
            autofillSettings.saveResponses,
            current,
          ),
      });
    },
  ),
    jobsWaitForCssNodes(JobsPlatformConfig.structure.greenhouse.root).then(
      async () => {
        const form = document.querySelector(
          JobsPlatformConfig.structure.greenhouse.root,
        );
        await ready(form);
        let i = await getProfile();
        await jobsMountManualAnswerControls(context, [
          [
            `//div[contains(@class, 'application--questions')]//textarea`,
            `preceding-sibling::label`,
          ],
        ]);
        jobsWatchXPathPresence(
          `//textarea[@id='cover_letter_text']`,
          async () =>
            await jobsMountManualAnswerControls(context, [
              [
                `//textarea[@id='cover_letter_text']`,
                `ancestor::fieldset/legend/label`,
              ],
            ]),
        );
        await greenhouseTrackApplication(
          () => setMessage(null),
          Boolean(autofillSettings.saveApplications),
        );
        await JobsAutomatic.advance({
          root: form,
          profile: i,
          setMessage,
          action: autofillSettings.autoSubmit ? `submit` : `fill`,
          selector: JobsPlatformConfig.structure.greenhouse.submit,
          fill: (current) =>
            greenhouseFillApplication(
              i,
              autofillSettings.saveResponses,
              current,
            ),
        });
      },
    ));
}

export {
  greenhouseQuestionLabelXPath,
  greenhouseCombobox,
  greenhouseAddEntries,
  greenhouseFillContact,
  greenhouseFillEducationHistory,
  greenhouseFillEmploymentHistory,
  greenhouseFillCustomQuestions,
  greenhouseFillDemographicQuestions,
  greenhouseFillStandardDisclosures,
  greenhouseTrackApplication,
  greenhouseReadUnresolvedResponses,
  greenhouseUploadResume,
  greenhouseFillApplication,
  greenhouseLegacyQuestionLabelXPath,
  greenhouseLegacyFillContact,
  greenhouseLegacyDatePart,
  greenhouseLegacyDateInput,
  greenhouseLegacyFillEducationHistory,
  greenhouseLegacyFillEmploymentHistory,
  greenhouseLegacyFillCustomQuestions,
  greenhouseLegacyFillDemographicQuestions,
  greenhouseLegacyFillStandardDisclosures,
  greenhouseLegacyTrackApplication,
  greenhouseLegacyReadUnresolvedResponses,
  greenhouseLegacyFillApplication,
  greenhouseRunApplication,
};
