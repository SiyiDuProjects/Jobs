import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
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
  jobsWatchCssPresence,
} from "../shared/dom-controls.js";
import { jobsFormatProfileMonth } from "../shared/profile-format.js";
// One EEO rule for every ATS; this form's own options decide the wording.
async function paylocityFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec,
    list = (id) => () => document.getElementById(`acknowledgements.${id}`);
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: list(`eeoGender`),
      answer: eeo(`gender`, employment),
    },
    {
      name: "race",
      find: list(`racialOrEthnicGroup`),
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: list(`disability`),
      answer: eeo(`disability`, employment),
    },
  ]);
}
async function paylocityFillInformationPage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`resume`, () => paylocityUploadResume(profile.resumeData));
  await section(`personal`, () => paylocityFillPersonalInformation(profile));
  await section(`employment`, () =>
    paylocityFillEmploymentHistory(profile.jobData, canProceed),
  );
  await section(`education`, () =>
    paylocityFillEducationHistory(profile.educationData, canProceed),
  );
}
async function paylocityFillEmploymentHistory(
  employmentEntries,
  canProceed = () => true,
) {
  return paylocityAddEntries(
    `btnAddWorkHistory`,
    `work-history-group`,
    employmentEntries,
    (entry, group, index) => [
      {
        name: "company",
        find: `${group}//input[@data-automation-id='workHistoryCompanyName${index}']`,
        answer: entry.company,
      },
      {
        name: "position",
        find: `${group}//input[@data-automation-id='workHistoryPosition${index}']`,
        answer: entry.jobTitle,
      },
      {
        name: "responsibilities",
        find: `${group}//textarea[@data-for='Responsibilities']`,
        answer: entry.description,
      },
      {
        name: "start-date",
        find: `${group}//input[@data-automation-id='txt-workHistory-startDate-${index}']`,
        answer:
          entry.startDate && jobsFormatProfileMonth(entry.startDate, `MM/yyyy`),
      },
      {
        name: "end-date",
        find: `${group}//input[@data-automation-id='txt-workHistory-endDate-${index}']`,
        answer:
          entry.endDate && jobsFormatProfileMonth(entry.endDate, `MM/yyyy`),
      },
      {
        name: "current",
        find: () =>
          document.getElementById(`workHistory.currentlyWorkingHere.${index}`),
        checked: entry.currentlyWorkHere === true ? true : undefined,
      },
      {
        name: "contact-supervisor",
        find: `${group}//div[@id='workHistory.mayWeContactSupervisor.${index}']`,
        answer: JobsProfileAnswers.literalSpec(
          "supervisor_contact",
          typeof entry.mayContactSupervisor === "boolean"
            ? entry.mayContactSupervisor
              ? "Yes"
              : "No"
            : null,
        ),
      },
    ],
    canProceed,
  );
}
async function paylocityFillEducationHistory(
  educationEntries,
  canProceed = () => true,
) {
  return paylocityAddEntries(
    `btnAddEducationHistory`,
    `education-history-group`,
    educationEntries,
    (entry, group, index) => {
      const answers = JobsProfileAnswers;
      return [
        {
          name: "school",
          find: `${group}//input[@data-automation-id='educationHistoryName${index}']`,
          answer: entry.school,
        },
        {
          name: "type",
          find: `${group}//div[@id='educationHistory.type.${index}']`,
          answer: answers.educationTypeSpec(entry),
        },
        {
          name: "area-of-study",
          find: `${group}//input[@data-automation-id='educationHistoryAreaOfStudy${index}']`,
          answer: entry.fieldOfStudy,
        },
        {
          name: "gpa",
          find: `${group}//input[@data-automation-id='educationHistoryGpa${index}']`,
          answer: entry.gpa,
        },
        {
          name: "graduated",
          find: `${group}//div[@id='educationHistory.didYouGraduate.${index}']`,
          answer:
            entry.endDate &&
            answers.literalSpec(
              "graduated",
              answers.resolve("Have you graduated?", { educationData: [entry] })
                ?.answer,
            ),
        },
        {
          name: "degree",
          find: `${group}//div[@id='educationHistory.degreeId.${index}']`,
          answer: entry.endDate && answers.degreeSpec(entry.degree),
        },
        {
          name: "graduation-date",
          find: `${group}//input[@data-automation-id='txt-educationHistory-graduationDate-${index}']`,
          answer:
            entry.endDate && jobsFormatProfileMonth(entry.endDate, `MM/yyyy`),
        },
      ];
    },
    canProceed,
  );
}
// The resume is uploaded as an attachment only, not used to prefill the form.
async function paylocityUploadResume(resume) {
  await JobsFormPipeline.bind([
    {
      name: "fill-from-resume",
      find: `#useAttachedResumeToFillOutApplication`,
      checked: false,
    },
  ]);
  if (!resume?.resumeBase64) return;
  jobsUploadResume(resume, `#btn-resume`);
  await JobsDOMWait.until(
    () => jobsFindXPath(`//div[contains(text(), '${resume.fileName}')]`),
    { timeout: 30000 },
  );
}
async function paylocityFillPersonalInformation(profile) {
  const address = profile.addressData,
    answers = JobsProfileAnswers,
    search = (name) =>
      `//div[@data-automation-id='public-site-address-${name}-input-base']`;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `[data-automation-id='infoFirstName']`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `[data-automation-id='infoLastName']`,
      answer: profile.nameData.lastName,
    },
    {
      name: "preferred-name",
      find: `[data-automation-id='infoPreferredName']`,
      answer: profile.nameData.preferredFirstName,
    },
    {
      name: "email",
      find: `[data-automation-id='infoEmail']`,
      answer: profile.contactData.email,
    },
    {
      name: "cell-phone",
      find: `[data-automation-id='infoCellPhone']`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "phone",
      find: `[data-automation-id='infoPhone']`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "country",
      find: search(`country`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "address1",
      find: `[data-automation-id='public-site-address-address-1']`,
      answer: address.line1,
    },
    {
      name: "address2",
      find: `[data-automation-id='public-site-address-address-2']`,
      answer: address.line2,
    },
    {
      name: "city",
      find: `//input[@data-automation-id='public-site-address-city' or @data-automation-id='public-site-address-locality']`,
      answer: address.city,
    },
    {
      name: "postal-code",
      find: `//input[@data-automation-id='public-site-address-zip' or @data-automation-id='public-site-address-postal-code']`,
      answer: address.postalCode,
    },
    {
      name: "state",
      find: search(`us-state`),
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "linkedin",
      find: `[data-automation-id='infoLinkedIn']`,
      answer: profile.websiteData.linkedin,
    },
    {
      name: "skills",
      find: `#info\\.skills`,
      answer: profile.skillsData?.join(`, `),
    },
  ]);
}
// Structure: one history group per Profile entry, added with the page's button.
async function paylocityAddEntries(
  button,
  group,
  entries,
  bindings,
  canProceed = () => true,
) {
  if (!document.querySelector(`[data-automation-id='${button}']`)) return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const node = `//div[contains(@class, '${group}')][${index + 1}]`;
    if (!jobsFindXPath(node)) {
      jobsClick(`[data-automation-id='${button}']`);
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(node), { timeout: 5000 }))
      )
        break;
    }
    await JobsFormPipeline.bind(bindings(entries[index], node, index));
  }
}
async function paylocityFillAcknowledgements() {
  await JobsFormPipeline.bind([
    {
      name: "acknowledgement",
      find: `#applyAcknowledgement`,
      topic: "consent",
    },
  ]);
}
// Each Paylocity page runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (work authorization, veteran status and the
// screening pages), AI for remaining required answers, review and navigation.
async function paylocityRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const run = async (fill) => {
    void jobsReportJobTitle(paylocityReadApplication().jobTitle);
    const profile = await getProfile();
    await JobsFormPipeline.settled(JobsPageSession?.root() || document.body);
    await JobsAutomatic.advance({
      profile,
      setMessage,
      ...jobsStepNavigation(
        autofillSettings,
        JobsPlatformConfig.structure.paylocity.next,
        JobsPlatformConfig.structure.paylocity.submit,
      ),
      fill: fill && ((canProceed) => fill(profile, canProceed)),
    });
  };
  jobsWaitForCssNodes(JobsPlatformConfig.structure.paylocity.infoRoot).then(
    () => run(paylocityFillInformationPage),
  );
  jobsWatchCssPresence(
    `#pcty-wr-apply-screeners,#pcty-wr-apply-references,#pcty-wr-expanded-identity-page`,
    async () => {
      await jobsMountManualAnswerControls(context, [[`//textarea`, `..`]]);
      await run(null);
    },
  );
  jobsWaitForCssNodes(JobsPlatformConfig.structure.paylocity.eeoRoot).then(() =>
    run((profile) => paylocityFillDisclosures(profile.employmentData)),
  );
  jobsWaitForCssNodes(JobsPlatformConfig.structure.paylocity.reviewRoot).then(
    () => run(paylocityFillAcknowledgements),
  );
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("paylocity").then(() => {
      (setMessage(null), paylocityRecordApplication());
    });
}
function paylocityReadApplication() {
  let e = jobsFindXPath(`//span[contains(@class,'job-apply-title')]/span`),
    t = /** @type {Element} */ (
      jobsFindXPath(`//a[contains(text(),'View All Jobs')]`)
    ),
    n = ``,
    r = ``;
  (e && e.textContent && (n = e.textContent),
    t &&
      t.getAttribute(`href`) &&
      (r = `https://recruiting.paylocity.com` + t.getAttribute(`href`) || ``));
  let i = window.location.href.match(
      /^https:\/\/recruiting\.paylocity\.com\/Recruiting\/Jobs\/([^/]+)\/([^/]+)/,
    ),
    a = i
      ? `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${i[2]}`
      : ``;
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: n,
    jobLink: a,
    companyLink: r,
  };
}
async function paylocityRecordApplication() {
  await jobsSaveApplicationRecord(paylocityReadApplication());
}

export {
  paylocityFillDisclosures,
  paylocityFillInformationPage,
  paylocityFillEmploymentHistory,
  paylocityFillEducationHistory,
  paylocityUploadResume,
  paylocityFillPersonalInformation,
  paylocityAddEntries,
  paylocityFillAcknowledgements,
  paylocityRunApplication,
  paylocityRecordApplication,
};
