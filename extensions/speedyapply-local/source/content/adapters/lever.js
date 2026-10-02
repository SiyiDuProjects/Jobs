import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindAllXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsFormatToday,
} from "../shared/profile-format.js";
var leverQuestionFieldXPath = `//div[@data-qa='additional-cards']//div[contains(@class,'application-field')]`;
// The Lever form runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the additional
// questions), AI for remaining required answers, review and navigation.
async function leverRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.lever.root).then(
    async ([form]) => {
      void jobsReportJobTitle(leverReadApplication().jobTitle);
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//div[@data-qa='additional-cards']//div[contains(@class,'application-field')]//textarea`,
          `../preceding-sibling::div//div[@class='text']`,
        ],
        [
          `//textarea[@id='additional-information']`,
          `../preceding-sibling::label//h4`,
        ],
      ]);

      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.lever.submit,
        fill: (current) => leverFillApplication(profile, current),
      });
    },
  );
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("lever").then(leverRecordApplication);
}
async function leverFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      jobsUploadResume(profile.resumeData, `#resume-upload-input`),
  );
  await section(`contact`, () => leverFillContact(profile));
  await section(`disclosures`, () =>
    leverFillStandardDisclosures(profile, canProceed),
  );
  await section(`additional`, () => leverFillAdditionalDisclosures(profile));
}
async function leverFillContact(profile) {
  const websites = profile.websiteData;
  await JobsFormPipeline.bind([
    {
      name: "name",
      find: `[name='name']`,
      answer: jobsFormatFullName(profile.nameData),
    },
    {
      name: "email",
      find: `[name='email']`,
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: `[name='phone']`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "current-company",
      find: `[name='org']`,
      answer: profile.jobData.find((job) => job.currentlyWorkHere)?.company,
    },
    {
      name: "location",
      find: `[name='location']`,
      answer: JobsProfileAnswers.locationSpec(profile.addressData),
    },
    {
      name: "linkedin",
      find: `[name='urls[LinkedIn]']`,
      answer: websites.linkedin,
    },
    {
      name: "twitter",
      find: `[name='urls[Twitter]']`,
      answer: websites.twitter,
    },
    { name: "github", find: `[name='urls[GitHub]']`, answer: websites.github },
    {
      name: "portfolio",
      find: `[name='urls[Portfolio]']`,
      answer: websites.personal,
    },
    {
      name: "other-website",
      find: `[name='urls[Other]']`,
      answer: websites.websites?.[0],
    },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
// A disability answer reveals its signature and date.
async function leverFillStandardDisclosures(profile, canProceed = () => true) {
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: `select[name='eeo[gender]']`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "race",
      find: () =>
        document.querySelector(`select[name='eeo[race]']`) ||
        document.querySelector(`input[name='eeo[race]']`),
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: `select[name='eeo[disability]']`,
      answer: eeo(`disability`, employment),
      after: () =>
        JobsDOMWait.until(
          () =>
            !JobsPageActions.live(canProceed) ||
            document.querySelector(`[name='eeo[disabilitySignature]']`),
          { timeout: 2000 },
        ),
    },
    {
      name: "disability-signature",
      find: `[name='eeo[disabilitySignature]']`,
      answer: jobsFormatFullName(profile.nameData),
    },
    {
      name: "disability-signature-date",
      find: `[name='eeo[disabilitySignatureDate]']`,
      answer: jobsFormatToday(),
    },
  ]);
}
function leverAgeRange(age) {
  return age >= 60
    ? `60 or older`
    : age >= 50
      ? `50-59`
      : age >= 40
        ? `40-49`
        : age >= 30
          ? `30-39`
          : age >= 21
            ? `21-29`
            : age >= 18
              ? `18-20`
              : `Under 18`;
}
async function leverFillAdditionalDisclosures(profile) {
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData,
    lower = jobsLowercaseXPath(`text()`);
  const group = (caption) =>
    `//div[${caption}]/../following-sibling::div//input[@type='radio' or @type='checkbox']`;
  await JobsFormPipeline.bind([
    {
      name: "candidate-location",
      find: `[data-qa='candidate-location-select']`,
      answer: JobsProfileAnswers.countrySpec(profile.addressData.country),
    },
    {
      name: "age-range",
      find: `//input[@value='${leverAgeRange(employment.age)}']`,
      checked: typeof employment.age === `number` ? true : undefined,
    },
    {
      name: "race",
      find: group(`contains(${lower}, 'race') or contains(${lower}, 'ethnic')`),
      answer: eeo(`race`, employment),
    },
    {
      name: "gender",
      find: group(`contains(${lower}, 'gender')`),
      answer: eeo(`gender`, employment),
    },
    {
      name: "disability",
      find: group(
        `contains(${lower}, 'disability') or contains(${lower}, 'disabled')`,
      ),
      answer: eeo(`disability`, employment),
    },
    {
      name: "privacy-policy",
      find: `//div[contains(@class,'text') and contains(text(), 'Privacy Policy')]/../..//input`,
      topic: "consent",
    },
  ]);
}
function leverReadApplication() {
  let e = document.querySelector(`h2`),
    t = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`.main-footer-text p:first-child a`)
    ),
    n = document.title.split(` - `)[0].trim(),
    r = ``,
    i = ``;
  (e && e.textContent && (r = e.textContent), t && t.href && (i = t.href));
  let a = window.location.href,
    o = a.match(/(https:\/\/jobs(?:\.[a-z]+)?\.lever\.co\/.+?\/thanks)/),
    s = o ? o[1] : ``;
  if (((s = s.replace(`/thanks`, ``)), !i)) {
    let e = a.match(/(https:\/\/jobs(?:\.[a-z]+)?\.lever\.co\/[^/]+)\//);
    i = e ? e[1] : ``;
  }
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: r,
    jobLink: s,
    companyLink: i,
    companyName: n,
  };
}
async function leverRecordApplication() {
  await jobsSaveApplicationRecord(leverReadApplication());
}

export {
  leverQuestionFieldXPath,
  leverRunApplication,
  leverFillApplication,
  leverFillContact,
  leverFillStandardDisclosures,
  leverAgeRange,
  leverFillAdditionalDisclosures,
  leverRecordApplication,
};
