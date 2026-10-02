import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFindXPath,
  jobsStepNavigation,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsProfileWebsiteEntries,
} from "../shared/profile-format.js";
// Each Tesla step runs as one page pipeline: declared Profile facts and
// acknowledgements, then the rules (the legal questions, veteran status),
// AI for remaining required answers, review and navigation.
async function teslaRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const step = (selector, fill) =>
    jobsWaitForCssNodes(selector).then(async ([root]) => {
      void jobsReportJobTitle(teslaReadApplication().jobTitle);
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//textarea`, `../preceding-sibling::label`],
      ]);
      await JobsFormPipeline.settled(root);
      await JobsAutomatic.advance({
        root: root.closest(JobsPlatformConfig.structure.tesla.root) || root,
        profile,
        setMessage,
        ...jobsStepNavigation(
          autofillSettings,
          JobsPlatformConfig.structure.tesla.next,
          JobsPlatformConfig.structure.tesla.submit,
        ),
        fill: fill && ((current) => fill(profile, current)),
      });
    });
  step(
    JobsPlatformConfig.structure.tesla.personalRoot,
    teslaFillPersonalInformation,
  );
  step(JobsPlatformConfig.structure.tesla.jobRoot, null);
  step(JobsPlatformConfig.structure.tesla.legalRoot, teslaFillLegalPage);
  step(JobsPlatformConfig.structure.tesla.eeoRoot, teslaFillDisclosures);
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("tesla").then(() => {
      (setMessage(null), teslaRecordApplication());
    });
}
async function teslaFillPersonalInformation(profile, canProceed = () => true) {
  const name = profile.nameData,
    answers = JobsProfileAnswers;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `input[name='personal.firstName']`,
      answer: name.firstName,
    },
    {
      name: "last-name",
      find: `input[name='personal.lastName']`,
      answer: name.lastName,
    },
    {
      name: "preferred-name",
      find: `input[name='personal.preferredName']`,
      answer:
        name.preferredName &&
        name.preferredFirstName + ` ` + name.preferredLastName,
    },
    {
      name: "phone",
      find: `input[name='personal.phone']`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "phone-type",
      find: `select[name='personal.phoneType']`,
      answer: answers.phoneTypeSpec(profile.contactData.phoneDeviceType),
    },
    {
      name: "email",
      find: `input[name='personal.email']`,
      answer: profile.contactData.email,
    },
    {
      name: "country",
      find: `select[name='personal.country']`,
      answer: answers.countrySpec(profile.addressData.country),
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(profile.resumeData, `input[name='personal.resume']`);
  // Structure: one profile-link row per website, added with the page's button.
  const links = jobsProfileWebsiteEntries(profile.websiteData).map(
      (entry) => entry.url,
    ),
    row = (index) => `//div[contains(@class,'ProfileLink_')][${index + 1}]`;
  for (
    let index = 0;
    index < links.length && JobsPageActions.live(canProceed);
    index++
  ) {
    if (!jobsFindXPath(row(index))) {
      if (
        !jobsClick(
          `//div[contains(@class,'ProfileLink')]//span[contains(@class,'Add')]/..`,
          !0,
        )
      )
        break;
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(row(index)), {
          timeout: 5000,
        }))
      )
        break;
    }
    await JobsFormPipeline.bind([
      { name: "website", find: `${row(index)}//input`, answer: links[index] },
      {
        name: "website-type",
        find: `${row(index)}//select`,
        answer: answers.websiteTypeSpec(links[index], profile.websiteData),
      },
    ]);
  }
}
async function teslaFillLegalPage(profile) {
  await JobsFormPipeline.bind([
    {
      name: "acknowledgment",
      find: `input[name='legal.legalAcknowledgment']`,
      topic: "consent",
    },
    {
      name: "acknowledgment-name",
      find: `input[name='legal.legalAcknowledgmentName']`,
      answer: jobsFormatFullName(profile.nameData),
    },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
// The acknowledgement is enabled once its disclaimer is scrolled to the end.
async function teslaFillDisclosures(profile) {
  const disclaimer = /** @type {Element} */ (
    jobsFindXPath(`//div[contains(@class,'Disclaimer_')]`)
  );
  if (disclaimer) disclaimer.scrollTop = disclaimer.scrollHeight;
  if (document.querySelector(`input[name='eeo.eeoAcknowledgment']`))
    await JobsDOMWait.until(
      () =>
        document.querySelector(
          `input[name='eeo.eeoAcknowledgment']:not([disabled])`,
        ),
      { timeout: 5000 },
    );
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  await JobsFormPipeline.bind([
    {
      name: "acknowledgment",
      find: `input[name='eeo.eeoAcknowledgment']:not([disabled])`,
      topic: "consent",
    },
    {
      name: "gender",
      find: `select[name='eeo.eeoGender']`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "race",
      find: `select[name='eeo.eeoRaceEthnicity']`,
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: `select[name='eeo.eeoDisabilityStatus']`,
      answer: eeo(`disability`, employment),
    },
    {
      name: "disability-name",
      find: `input[name='eeo.eeoDisabilityStatusName']`,
      answer: jobsFormatFullName(profile.nameData),
    },
  ]);
}
function teslaReadApplication() {
  let e = jobsFindXPath(`//p[contains(@class,'JobTitle_')]`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href.match(
      /^(https:\/\/www\.tesla\.com\/careers\/search\/job\/)apply\/(\d+)$/,
    ),
    r = n ? `${n[1]}${n[2]}` : ``;
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: t,
    jobLink: r,
    companyLink: `https://www.tesla.com/`,
  };
}
async function teslaRecordApplication() {
  await jobsSaveApplicationRecord(teslaReadApplication());
}

export {
  teslaRunApplication,
  teslaFillPersonalInformation,
  teslaFillLegalPage,
  teslaFillDisclosures,
  teslaRecordApplication,
};
