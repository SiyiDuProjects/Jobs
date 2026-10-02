import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsClickAllXPath,
  jobsFillAccount,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitAndClick,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsFormatProfileMonth,
  jobsFormatToday,
} from "../shared/profile-format.js";
async function successfactorsFillLogin(accountSettings) {
  await jobsFillAccount([
    { find: `#username`, value: accountSettings.accountEmail },
    { find: `#password`, value: accountSettings.accountPassword },
  ]);
}
async function successfactorsFillRegistration(profile, accountSettings) {
  const country = JobsProfileAnswers.countrySpec(profile.addressData.country);
  await jobsFillAccount([
    {
      find: `//input[contains(@id,'userName')]`,
      value: accountSettings.accountEmail,
    },
    {
      find: `//input[contains(@id,'emailConf')]`,
      value: accountSettings.accountEmail,
    },
    {
      find: `//input[contains(@id,'pwd')]`,
      value: accountSettings.accountPassword,
    },
    {
      find: `//input[contains(@id,'pwdConf')]`,
      value: accountSettings.accountPassword,
    },
    {
      find: `//input[contains(@id,'fName')]`,
      value: profile.nameData.firstName,
    },
    {
      find: `//input[contains(@id,'lName')]`,
      value: profile.nameData.lastName,
    },
    {
      find: `//input[contains(@id,'phoneNumber')]`,
      value: profile.contactData.phoneNumber,
    },
    { find: `//select[contains(@id,'ituCode')]`, spec: country },
    { find: `//select[contains(@id,'country')]`, spec: country },
  ]);
}
// A field's input: the paged list inside its container, or its text box.
function successfactorsList(container) {
  return `${container}//div[contains(@id, 'selectContainer')]//input[not(@disabled)]`;
}
function successfactorsText(container) {
  return `${container}//div[not(contains(@id, 'selectContainer'))]//input`;
}
function successfactorsDate(container) {
  return `${container}/div[contains(@id, 'datepicker')]//ui5-date-picker-xweb-calendar-widget`;
}
async function successfactorsFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`resume`, () => successfactorsUploadResume(profile.resumeData));
  await section(`personal`, () =>
    successfactorsFillPersonalInformation(profile),
  );
  const field = (row, caption) =>
    `${row}//label[${caption}]/following-sibling::div[@class='fieldComponentInput']`;
  const lower = jobsLowercaseXPath(`.`),
    answers = JobsProfileAnswers,
    iso = (date) => date && jobsFormatProfileMonth(date, `yyyy-MM-dd`);
  await section(`employment`, () =>
    successfactorsAddRows(
      `(contains(${jobsLowercaseXPath(`span/text()`)}, 'work') or contains(${jobsLowercaseXPath(`span/text()`)}, 'employment')) and not(contains(${jobsLowercaseXPath(`span/text()`)}, 'within'))`,
      profile.jobData,
      (entry, row) => [
        {
          name: "company",
          find: successfactorsText(
            field(row, `contains(., 'Company') or contains(., 'Employer')`),
          ),
          answer: entry.company,
        },
        {
          name: "title",
          find: successfactorsText(
            field(row, `contains(., 'Title') or contains(., 'Position')`),
          ),
          answer: entry.jobTitle,
        },
        {
          name: "location",
          find: successfactorsText(
            field(row, `contains(., 'Location') or contains(., 'City')`),
          ),
          answer: entry.location,
        },
        {
          name: "start",
          find: successfactorsDate(
            field(
              row,
              `contains(., 'Begin') or contains(., 'From') or contains(., 'Start Date')`,
            ),
          ),
          answer: iso(entry.startDate),
        },
        {
          name: "end",
          find: successfactorsDate(field(row, `contains(., 'End')`)),
          answer: iso(entry.endDate) || jobsFormatToday(`yyyy-MM-dd`),
        },
      ],
      canProceed,
    ),
  );
  await section(`education`, () =>
    successfactorsAddRows(
      `contains(${jobsLowercaseXPath(`span/text()`)}, 'education')`,
      profile.educationData,
      (entry, row) => [
        // One decision over the complete paged list.
        {
          name: "degree",
          find: successfactorsList(field(row, `contains(., 'Degree')`)),
          answer: answers.degreeSpec(entry.degree),
        },
        {
          name: "school",
          find: successfactorsText(
            field(
              row,
              `contains(${lower}, 'institution') or contains(${lower}, 'school') or contains(${lower}, 'university')`,
            ),
          ),
          answer: entry.school,
        },
        {
          name: "major",
          find: successfactorsList(
            field(
              row,
              `contains(${lower}, 'major') or contains(${lower}, 'program') or contains(${lower}, 'study')`,
            ),
          ),
          answer: answers.literalSpec("known-answer", entry.fieldOfStudy),
        },
        {
          name: "gpa",
          find: successfactorsText(field(row, `contains(., 'GPA')`)),
          answer: entry.gpa,
        },
        {
          name: "start",
          find: successfactorsDate(
            field(
              row,
              `contains(., 'Begin') or contains(., 'From') or contains(., 'Start Date')`,
            ),
          ),
          answer: iso(entry.startDate),
        },
        {
          name: "end",
          find: successfactorsDate(
            field(row, `contains(., 'End') or contains(., 'Graduation')`),
          ),
          answer: iso(entry.endDate),
        },
        {
          name: "graduation-year",
          find: successfactorsList(
            field(row, `contains(., 'Graduation Year')`),
          ),
          answer:
            entry.endDate &&
            answers.literalSpec(
              "known-answer",
              jobsFormatProfileMonth(entry.endDate, `yyyy`),
            ),
        },
      ],
      canProceed,
    ),
  );
  await section(`languages`, () =>
    successfactorsAddRows(
      `contains(span/text(), 'Language')`,
      profile.languageData,
      (entry, row) => [
        {
          name: "language",
          find: successfactorsList(field(row, `contains(., 'Language')`)),
          answer: answers.literalSpec("known-answer", entry.language),
        },
        ...[`Speaking`, `Reading`, `Writing`, `Fluency`, `Level`].map(
          (skill) => ({
            name: skill.toLowerCase(),
            find: field(row, `contains(${lower}, '${skill.toLowerCase()}')`),
            answer: answers.languageSpec(entry.proficiency, entry),
          }),
        ),
      ],
      canProceed,
    ),
  );
  await section(`questions`, () => successfactorsFillJobQuestions(profile));
}
async function successfactorsUploadResume(resume) {
  if (!resume?.resumeBase64) return;
  // An earlier attachment is removed first; the page confirms the removal.
  if (
    jobsClick(
      `//label[contains(., 'Resume')]/following-sibling::div//span[@role='button' and contains(@class,'removeAttachments')]`,
      !0,
    )
  )
    await jobsWaitAndClick(
      `//button[@type='button' and contains(., 'OK')]`,
      !0,
    );
  await jobsWaitAndClick(
    `//label[contains(${jobsLowercaseXPath(`.`)}, 'resume') or contains(${jobsLowercaseXPath(`.`)}, 'cv')]/following-sibling::div//span[@role='button' and contains(@class,'addAttachments')]`,
    !0,
  );
  if (
    !(await JobsDOMWait.until(
      () => jobsFindXPath(`//input[contains(@class, "fileUpload")]`),
      { timeout: 10000 },
    ))
  )
    return;
  jobsUploadResume(resume, `//input[contains(@class, "fileUpload")]`, !0);
  await JobsDOMWait.until(
    () => jobsFindXPath(`//div[contains(@class,'successBG')]`),
    { timeout: 30000 },
  );
}
async function successfactorsFillPersonalInformation(profile) {
  const profileSection = `//button[contains(span/text(), 'Profile') and contains(@class, 'topBar')]/../following-sibling::div[contains(@id, 'sectionContent')]`;
  const field = (caption) =>
    `${profileSection}//label[${caption}]/following-sibling::div[@class='fieldComponentInput']`;
  const name = profile.nameData,
    address = profile.addressData,
    answers = JobsProfileAnswers;
  // The state is a paged list for countries with regions, otherwise a text box.
  const stateList = () =>
    jobsFindXPath(
      successfactorsList(
        field(`contains(${jobsLowercaseXPath(`.`)}, 'state')`),
      ),
    );
  await JobsFormPipeline.bind([
    {
      name: "preferred-name",
      find: `input[name="preferredName"]`,
      answer:
        name.preferredName && name.preferredFirstName
          ? name.preferredFirstName
          : name.firstName,
    },
    {
      name: "first-name",
      find: `input[name="firstName"]`,
      answer: name.firstName,
    },
    {
      name: "last-name",
      find: `input[name="lastName"]`,
      answer: name.lastName,
    },
    {
      name: "country",
      find: field(`contains(., 'Country')`),
      answer: answers.countrySpec(address.country),
    },
    { name: "address", find: `input[name="address"]`, answer: address.line1 },
    {
      name: "address2",
      find: `input[name="custAddress"]`,
      answer: address.line2,
    },
    { name: "city", find: `input[name="city"]`, answer: address.city },
    {
      name: "state",
      find: stateList,
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "state-text",
      find: () => !stateList() && document.querySelector(`input[name="state"]`),
      answer: address.state,
    },
    { name: "zip", find: `input[name="zip"]`, answer: address.postalCode },
    {
      name: "email",
      find: `input[name="contactEmail"]`,
      answer: profile.contactData.email,
    },
    {
      name: "phone-country",
      find: field(`contains(${jobsLowercaseXPath(`.`)}, 'phone country')`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "cell-phone",
      find: `input[name="cellPhone"]`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "home-phone",
      find: `input[name="homePhone"]`,
      answer: profile.contactData.phoneNumber,
    },
  ]);
}
// Structure: a section's existing rows are cleared, then one row per
// Profile entry is added with the section's Add button.
async function successfactorsAddRows(
  title,
  entries,
  bindings,
  canProceed = () => true,
) {
  const section = `//button[${title} and contains(@class, 'topBar')]/../following-sibling::div[contains(@id, 'sectionContent')]`;
  if (!jobsFindXPath(section)) return;
  await jobsClickAllXPath(
    `${section}//div[@role='button' and contains(@title, 'Delete Row')]`,
  );
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const row = `(${section}//div[contains(@id, 'sectionComponent')])[${index + 1}]`;
    if (!jobsFindXPath(row)) {
      jobsClick(
        `${section}//div[@role='button' and contains(@title, 'Add new')]`,
        !0,
      );
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(row), { timeout: 5000 }))
      )
        break;
    }
    await JobsFormPipeline.bind(bindings(entries[index], row));
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
// Age, work authorization, sponsorship and veteran status are the rules'.
async function successfactorsFillJobQuestions(profile) {
  const lower = jobsLowercaseXPath(`.`);
  const section = `//button[(contains(${lower}, 'specific') or (contains(${lower}, 'job') and contains(${lower}, 'questions'))) and contains(@class, 'topBar')]/../following-sibling::div[contains(@id, 'sectionContent')]`;
  if (!jobsFindXPath(section)) return;
  const field = (caption) =>
    `${section}//label[${caption}]/following-sibling::div[@class='fieldComponentInput']`;
  const list = (caption) =>
    `${field(caption)}//div[contains(@id, 'selectContainer')]//input[not(@type='hidden')]`;
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  await JobsFormPipeline.bind([
    {
      name: "source",
      find: list(
        `contains(${lower}, 'source') or (contains(${lower}, 'hear') and contains(${lower}, 'about') and (contains(${lower}, 'this') or contains(${lower}, 'us')))`,
      ),
      answer: JobsProfileAnswers.recruitingSourceSpec(profile),
    },
    {
      name: "ethnicity",
      find: list(`contains(${lower}, 'ethnicity')`),
      answer: eeo(`ethnicity`, employment),
    },
    {
      name: "race",
      find: list(`contains(${lower}, 'race')`),
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: list(`contains(${lower}, 'disability')`),
      answer: eeo(`disability`, employment),
    },
    {
      name: "signature",
      find: successfactorsText(
        field(`contains(., 'Signature') or contains(., 'Full Name')`),
      ),
      answer: jobsFormatFullName(profile.nameData),
    },
    {
      name: "gender",
      find: list(`contains(${lower}, 'gender')`),
      answer: eeo(`gender`, employment),
    },
  ]);
}
async function successfactorsTrackApplication(record = true) {
  let e =
      jobsFindXPath(`//div[contains(@id, 'pageTitle')]//h1`)?.textContent || ``,
    t =
      /** @type {HTMLAnchorElement} */ (
        jobsFindXPath(
          `//div[@class='customheaderimagecontainer']//a | //img[contains(@class, 'logo')]/..`,
        )
      )?.href || ``;
  void jobsReportJobTitle(e);
  if (!record) return;
  jobsWaitForConfirmation("successfactors").then(
    async () =>
      await jobsSaveApplicationRecord({
        jobsSyncProof: "ats_confirmation",
        jobTitle: e,
        jobLink: ``,
        companyLink: t,
      }),
  );
}
// The SuccessFactors application runs as one page pipeline: declared
// Profile facts, history and disclosures, then the rules, AI for remaining
// required answers, review and navigation. Sign-in and registration take
// the saved account.
async function successfactorsRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
}) {
  jobsWaitForXPathNodes(`//input[@id='username']`).then(() =>
    successfactorsFillLogin(accountSettings),
  );
  jobsWaitForXPathNodes(`//input[contains(@id,'userName')]`).then(async () =>
    successfactorsFillRegistration(await getProfile(), accountSettings),
  );
  // The application's sections are expanded before filling.
  jobsWaitAndClick(`//a[contains(@class, "expandCollapseTxt")]`, !0).then(
    async () => {
      const profile = await getProfile();
      await successfactorsTrackApplication(
        Boolean(autofillSettings.saveApplications),
      );
      const submit =
        jobsFindXPath(
          JobsPlatformConfig.structure.successfactors.submitXPath,
        ) ||
        jobsFindXPath(JobsPlatformConfig.structure.successfactors.saveXPath);
      await JobsAutomatic.advance({
        profile,
        setMessage,
        action: autofillSettings.autoSubmit && submit ? `submit` : `fill`,
        target: submit || void 0,
        fill: (current) => successfactorsFillApplication(profile, current),
      });
    },
  );
}

export {
  successfactorsFillLogin,
  successfactorsFillRegistration,
  successfactorsList,
  successfactorsText,
  successfactorsDate,
  successfactorsFillApplication,
  successfactorsUploadResume,
  successfactorsFillPersonalInformation,
  successfactorsAddRows,
  successfactorsFillJobQuestions,
  successfactorsTrackApplication,
  successfactorsRunApplication,
};
