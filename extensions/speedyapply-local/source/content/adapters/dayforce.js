import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFillAccount,
  jobsFindXPath,
  jobsStepNavigation,
  jobsUploadResume,
  jobsWaitAndClick,
  jobsWaitForXPathNodes,
  jobsWatchAttribute,
  jobsWatchCssPresence,
} from "../shared/dom-controls.js";
import {
  jobsFormatProfileMonth,
  jobsIsProfileMonthInPast,
} from "../shared/profile-format.js";
async function dayforceFillLogin(accountSettings) {
  await jobsFillAccount([
    { find: `#loginForm #email`, value: accountSettings.accountEmail },
    { find: `#loginForm #password`, value: accountSettings.accountPassword },
  ]);
}
async function dayforceFillRegistration(profile, accountSettings) {
  await jobsFillAccount([
    { find: `#registrationForm #firstName`, value: profile.nameData.firstName },
    { find: `#registrationForm #lastName`, value: profile.nameData.lastName },
    {
      find: `#registrationForm #emailAddress`,
      value: profile.contactData.email,
    },
    {
      find: `#registrationForm #confirmEmailAddress`,
      value: profile.contactData.email,
    },
    {
      find: `#registrationForm #password`,
      value: accountSettings.accountPassword,
    },
    {
      find: `#registrationForm #confirmPassword`,
      value: accountSettings.accountPassword,
    },
  ]);
}
async function dayforceFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`resume`, async () => {
    const done = `//div[@test-id='upload-file-item-test']//div[contains(@class, 'ant-upload-list-item-done')]`;
    if (jobsFindXPath(done) || !profile.resumeData?.resumeBase64) return;
    jobsUploadResume(
      profile.resumeData,
      `//input[@id='jobPostingApplication_files_resume']`,
      !0,
    );
    await JobsDOMWait.until(() => jobsFindXPath(done), { timeout: 30000 });
  });
  await section(`personal`, () => dayforceFillPersonalInformation(profile));
  await section(`education`, () =>
    dayforceReplaceRecords(
      `educationHistory`,
      `educationhistory`,
      profile.educationData,
      (entry, index) => {
        const field = (name) =>
          `#jobPostingApplication_educationHistory_${index}_${name}`;
        return [
          { name: "degree", find: field(`degreeName`), answer: entry.degree },
          {
            name: "major",
            find: field(`majorName`),
            answer: entry.fieldOfStudy,
          },
          { name: "school", find: field(`schoolName`), answer: entry.school },
          {
            name: "start",
            find: field(`effectiveStart`),
            answer:
              entry.startDate &&
              jobsFormatProfileMonth(entry.startDate, `yyyy-MM-dd`),
          },
          {
            name: "end",
            find: field(`effectiveEnd`),
            answer:
              entry.endDate &&
              jobsFormatProfileMonth(entry.endDate, `yyyy-MM-dd`),
          },
          {
            name: "not-completed",
            find: field(`notCompleted`),
            checked:
              entry.endDate && !jobsIsProfileMonthInPast(entry.endDate)
                ? true
                : undefined,
          },
        ];
      },
      canProceed,
    ),
  );
  await section(`employment`, () =>
    dayforceReplaceRecords(
      `workHistory`,
      `workhistory`,
      profile.jobData,
      (entry, index) => {
        const field = (name) =>
          `#jobPostingApplication_workHistory_${index}_${name}`;
        return [
          { name: "title", find: field(`title`), answer: entry.jobTitle },
          {
            name: "company",
            find: field(`companyName`),
            answer: entry.company,
          },
          {
            name: "start",
            find: field(`effectiveStart`),
            answer:
              entry.startDate &&
              jobsFormatProfileMonth(entry.startDate, `yyyy-MM-dd`),
          },
          {
            name: "end",
            find: field(`effectiveEnd`),
            answer:
              entry.endDate &&
              jobsFormatProfileMonth(entry.endDate, `yyyy-MM-dd`),
          },
          {
            name: "current",
            find: field(`isCurrent`),
            checked: entry.currentlyWorkHere === true ? true : undefined,
          },
          {
            name: "description",
            find: field(`description`),
            answer: entry.description,
          },
        ];
      },
      canProceed,
    ),
  );
}
async function dayforceFillPersonalInformation(profile) {
  const name = profile.nameData,
    address = profile.addressData,
    answers = JobsProfileAnswers,
    field = (id) => `#jobPostingApplication_personalInfo_${id}`;
  await JobsFormPipeline.bind([
    { name: "email", find: field(`email`), answer: profile.contactData.email },
    {
      name: "confirm-email",
      find: field(`confirmEmail`),
      answer: profile.contactData.email,
    },
    { name: "first-name", find: field(`firstName`), answer: name.firstName },
    {
      name: "middle-name",
      find: field(`middleName`),
      answer:
        name.preferredFirstName && name.preferredName
          ? name.preferredFirstName
          : name.firstName,
    },
    { name: "last-name", find: field(`lastName`), answer: name.lastName },
    {
      name: "linkedin",
      find: field(`linkedInURL`),
      answer: profile.websiteData.linkedin,
    },
    {
      name: "phone-country",
      find: `[test-id="personal-info-mobile-phone-dropdown"] input`,
      answer: answers.countrySpec(address.country),
    },
    {
      name: "mobile-phone",
      find: field(`mobilePhone`),
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "country",
      find: field(`countryCode`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "state",
      find: field(`stateCode`),
      answer: answers.regionSpec(address.state, address.country),
    },
    { name: "address1", find: field(`address1`), answer: address.line1 },
    { name: "address2", find: field(`address2`), answer: address.line2 },
    { name: "city", find: field(`city`), answer: address.city },
    {
      name: "postal-code",
      find: field(`postalCode`),
      answer: address.postalCode,
    },
    {
      name: "source",
      find: field(`candidateSource`),
      answer: answers.recruitingSourceSpec(profile),
    },
  ]);
  jobsClick(`[test-id="personal-info-update-button"]`);
}
// Structure: records already on the page (resume-parsed) are removed, then
// one record per Profile entry is added, filled and saved.
async function dayforceReplaceRecords(
  form,
  record,
  entries,
  bindings,
  canProceed = () => true,
) {
  for (const existing of [
    ...document.querySelectorAll(`[test-id="${record}-record"]`),
  ]) {
    if (jobsClick(`[test-id="${form}-cancel-button"]`)) continue;
    jobsClick(`#${existing.id} [test-id="${form}-delete-button"]`);
    await jobsWaitAndClick(
      `//div[@role='dialog']//button[contains(@class, 'ant-btn-primary') and not(contains(@class, 'ant-btn-background-ghost'))]`,
      !0,
    );
  }
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    if (!jobsClick(`[test-id="add-${record}-record"]`)) break;
    if (
      !(await JobsDOMWait.until(
        () => document.querySelector(`form[id="${form}-${index}"]`),
        { timeout: 5000 },
      ))
    )
      break;
    await JobsFormPipeline.bind(bindings(entries[index], index));
    jobsClick(`form[id="${form}-${index}"] [test-id="${form}-update-button"]`);
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function dayforceFillEqualOpportunity({ employmentData: employment }) {
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "ethnicity",
      find: `[test-id='personal-info-ethnicity-dropdown'] input`,
      answer: eeo(`race`, employment),
    },
    {
      name: "gender",
      find: `[test-id='personal-info-gender-dropdown'] input`,
      answer: eeo(`gender`, employment),
    },
  ]);
}
async function dayforceFillDisability({ employmentData: employment }) {
  // Keep this step's labelled native question; never find a global Yes/No.
  await JobsFormPipeline.bind([
    {
      name: "disability",
      find: `//label[contains(., 'disability')]//input[@type='radio' or @type='checkbox']`,
      answer: JobsProfileAnswers.eeoSpec(`disability`, employment),
    },
  ]);
}
// Each Dayforce step runs as one page pipeline: declared Profile facts,
// history and disclosures, then the rules (veteran status and the
// questionnaires), AI for remaining required answers, review and navigation.
// Sign-in and registration take the saved account.
async function dayforceRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
}) {
  const run = async (fill) => {
    void jobsReportJobTitle(dayforceReadApplication().jobTitle);
    const profile = await getProfile();
    await JobsFormPipeline.settled(JobsPageSession?.root() || document.body);
    await JobsAutomatic.advance({
      profile,
      setMessage,
      ...jobsStepNavigation(
        autofillSettings,
        JobsPlatformConfig.structure.dayforce.next,
        JobsPlatformConfig.structure.dayforce.submit,
      ),
      fill: fill && ((canProceed) => fill(profile, canProceed)),
    });
  };
  if (accountSettings.accountPassword) {
    jobsWatchCssPresence(
      `#loginForm`,
      () => dayforceFillLogin(accountSettings),
      void 0,
      () => setMessage(null),
    );
    jobsWatchCssPresence(
      `#registrationForm`,
      async () => dayforceFillRegistration(await getProfile(), accountSettings),
      void 0,
      () => setMessage(null),
    );
  }
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("dayforce").then(() => {
      (setMessage(null), dayforceRecordApplication());
    });
  jobsWaitForXPathNodes(
    `//input[@id='jobPostingApplication_files_resume']`,
  ).then(() => run(dayforceFillApplication));
  const steps = new Map([
    [`equal-employment-opportunity-title`, dayforceFillEqualOpportunity],
    [`disability-form-questionnaire-title`, dayforceFillDisability],
    [`veteran-form-questionnaire-title`, null],
  ]);
  jobsWatchAttribute(
    `//div[@test-id='application-step-questionnaire']//h2[@test-id]`,
    `test-id`,
    (step) => {
      step && run(steps.get(step) || null);
    },
    !0,
  );
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.dayforce.reviewXPath).then(
    () =>
      run(() =>
        JobsFormPipeline.bind([
          {
            name: "acknowledged",
            find: `//input[@type='checkbox' and @test-id='user-acknowledged-checkbox']`,
            topic: "consent",
          },
        ]),
      ),
  );
}
function dayforceReadApplication() {
  let e = jobsFindXPath(`//h1[@test-id='job-detail-title']`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href,
    r = n.split(`/apply`)[0],
    i = n.split(`/jobs/`)[0];
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: t,
    jobLink: r,
    companyLink: i,
  };
}
async function dayforceRecordApplication() {
  await jobsSaveApplicationRecord(dayforceReadApplication());
}

export {
  dayforceFillLogin,
  dayforceFillRegistration,
  dayforceFillApplication,
  dayforceFillPersonalInformation,
  dayforceReplaceRecords,
  dayforceFillEqualOpportunity,
  dayforceFillDisability,
  dayforceRunApplication,
  dayforceRecordApplication,
};
