import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsClick,
  jobsFindAllXPath,
  jobsFindXPath,
  jobsStepNavigation,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import { jobsProfileWebsiteEntries } from "../shared/profile-format.js";
import { jobsTrackApplicationOnUnload } from "../shared/response-capture.js";
// A native list whose options load after it appears: wait (bounded) until it
// offers a real option, so the binding matches against the loaded list.
async function phenomOptionsLoaded(selectXPath) {
  return JobsDOMWait.until(
    () => {
      const select = /** @type {HTMLSelectElement} */ (
        jobsFindXPath(selectXPath)
      );
      return select &&
        [...select.options].some(
          (option) =>
            option.value !== `` &&
            !/select|applicable/i.test(option.textContent || ``),
        )
        ? select
        : null;
    },
    { timeout: 3000 },
  );
}
// Each Phenom step runs as one page pipeline: declared Profile facts,
// history, languages, disclosures and agreements, then the rules (veteran
// status, prior employment and the question steps), AI for remaining
// required answers, review and navigation. The review step submits.
async function phenomRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const run = async (fill) => {
    const profile = await getProfile();
    await JobsFormPipeline.settled(JobsPageSession?.root() || document.body);
    await JobsAutomatic.advance({
      profile,
      setMessage,
      ...jobsStepNavigation(
        autofillSettings,
        JobsPlatformConfig.structure.phenom.next,
        JobsPlatformConfig.structure.phenom.submit,
      ),
      fill: fill && ((canProceed) => fill(profile, canProceed)),
    });
  };
  const step = (names, fill) => {
    for (const name of names)
      jobsWaitForXPathNodes(
        `//form//div[contains(${jobsLowercaseXPath(`@class`)}, '${name.toLowerCase()}')]`,
      ).then(() => run(fill));
  };
  jobsWaitForCssNodes(JobsPlatformConfig.structure.phenom.submit).then(
    async () =>
      await phenomTrackApplication(Boolean(autofillSettings.saveApplications)),
  );
  step(
    [`personalInformation-step`, `personelInformation-step`],
    phenomFillPersonalInformation,
  );
  step(
    [`additionalInformation-step`, `workAndEducation-step`],
    phenomFillExperiencePage,
  );
  jobsWaitForXPathNodes(
    `//form//div[contains(@class, 'applicationQuestions-step') or contains(@class, 'jobSpecificQuestions-step') or contains(@class, 'applicationQuestionnaire-step')]`,
  ).then(() =>
    jobsMountManualAnswerControls(context, [
      [`//textarea`, `../preceding-sibling::label`],
    ]),
  );
  step(
    [
      `applicationQuestions-step`,
      `jobSpecificQuestions-step`,
      `applicationQuestionnaire-step`,
    ],
    null,
  );
  step([`userDetailsAndPreferences-step`], phenomFillPreferencesPage);
  step(
    [
      `disabilityInformation-step`,
      `voluntaryInfoDisability-step`,
      `Disability-step`,
      `voluntaryInformation-step`,
      `eeo-step`,
      `esign-step`,
      `Agreement-step`,
      `applicantAgreement-step`,
      `status-step`,
      `applicantAcknowledgment-step`,
    ],
    phenomFillDisclosuresAndAgreements,
  );
  step([`applicationReview-step`, `summary-step`], null);
}
async function phenomFillPersonalInformation(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`resume`, async () => {
    const uploaded = `//a[contains(@class, 'downloadFile') or @id='deleteResume']`;
    if (!profile.resumeData?.resumeBase64 || jobsFindXPath(uploaded)) return;
    jobsUploadResume(
      profile.resumeData,
      `.//body[not(descendant::a[contains(@class, "downloadFile") or @id="deleteResume"])]//input[@type="file" and parent::*[contains(., "Upload Resume") or contains(@*, "resume") or descendant::label[@title="Upload Resume" or @for="resumefiles"]]]`,
      !0,
    );
    // The resume is parsed into the form once its stored ID is set.
    await JobsDOMWait.until(() => jobsFindXPath(uploaded), { timeout: 30000 });
    await JobsDOMWait.until(
      () =>
        jobsFindXPath(
          `//input[@id='resumeBucketId' and string-length(@value) > 0]`,
        ),
      { timeout: 30000 },
    );
  });
  const name = profile.nameData,
    address = profile.addressData,
    answers = JobsProfileAnswers;
  const state = `//select[contains(@id, 'region') or contains(@id, 'state') or contains(@id, 'territory')]`,
    preferred = !!(
      name.preferredName &&
      name.preferredFirstName &&
      name.preferredLastName
    );
  await JobsFormPipeline.bind([
    // The state list is loaded for the chosen country.
    {
      name: "country",
      find: `//select[contains(@id, 'country') and not(contains(@id, 'PhoneCode'))]`,
      answer: answers.countrySpec(address.country),
      after: () => address.state && phenomOptionsLoaded(state),
    },
    {
      name: "phone-code",
      find: `//select[contains(@id, 'countryPhoneCode')]`,
      answer: answers.countrySpec(address.country),
    },
    {
      name: "first-name",
      find: `//input[contains(@id, 'firstName')]`,
      answer: name.firstName,
    },
    {
      name: "last-name",
      find: `//input[contains(@id, 'lastName')]`,
      answer: name.lastName,
    },
    {
      name: "use-preferred-name",
      find: `//select[contains(@id, 'preferredName')]`,
      answer: preferred ? answers.literalSpec("known-answer", `Yes`) : null,
      after: () =>
        JobsDOMWait.until(
          () => jobsFindXPath(`//input[contains(@id, 'preferredFirstName')]`),
          { timeout: 3000 },
        ),
    },
    {
      name: "preferred-first-name",
      find: `//input[contains(@id, 'preferredFirstName')]`,
      answer: preferred && name.preferredFirstName,
    },
    {
      name: "preferred-last-name",
      find: `//input[contains(@id, 'preferredLastName')]`,
      answer: preferred && name.preferredLastName,
    },
    {
      name: "state",
      find: state,
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "address1",
      find: `//input[contains(@id, 'addressLine1') or @id='address']`,
      answer: address.line1,
    },
    {
      name: "address2",
      find: `//input[contains(@id, 'addressLine2')]`,
      answer: address.line2,
    },
    {
      name: "city",
      find: `//input[contains(@id, 'city')]`,
      answer: address.city,
    },
    {
      name: "postal-code",
      find: `//input[contains(@id, 'postalCode') or contains(@id, 'zip')]`,
      answer: address.postalCode,
    },
    {
      name: "email",
      find: `//input[contains(@id, 'email')]`,
      answer: profile.contactData.email,
    },
    {
      name: "device-type",
      find: `//select[contains(@id, 'deviceType')]`,
      answer: answers.phoneTypeSpec(profile.contactData.phoneDeviceType),
    },
    {
      name: "phone",
      find: `//input[contains(@id, 'phoneNumber')]`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "source",
      find: `//select[contains(@id, 'source') or contains(@id, 'applicantSource')]`,
      answer: answers.recruitingSourceSpec(profile),
    },
    {
      name: "linkedin",
      find: `//input[contains(@id, 'linkedIn')]`,
      answer: profile.websiteData.linkedin,
    },
    ...[
      `emailAgreement`,
      `smsOptIn`,
      `smsOption`,
      `noticeAgreement`,
      `privacy`,
      `notice`,
    ].map((id) => ({
      name: id,
      find: `//input[contains(${jobsLowercaseXPath(`@id`)}, '${id.toLowerCase()}')]`,
      topic: "consent",
    })),
  ]);
}
async function phenomFillExperiencePage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`employment`, () =>
    phenomAddEntries(
      `experienceData`,
      profile.jobData,
      (entry, item) => [
        {
          name: "title",
          find: `${item}//input[contains(@id, 'title')]`,
          answer: entry.jobTitle,
        },
        {
          name: "company",
          find: `${item}//input[contains(@id, 'companyName')]`,
          answer: entry.company,
        },
        {
          name: "location",
          find: `${item}//input[contains(@id, 'location')]`,
          answer: entry.location,
        },
        {
          name: "description",
          find: `${item}//textarea[contains(${jobsLowercaseXPath(`@id`)}, 'description')]`,
          answer: entry.description,
        },
        {
          name: "current",
          find: `${item}//input[contains(@id, 'currentlyWorkHere')]`,
          checked: entry.currentlyWorkHere === true ? true : undefined,
        },
      ],
      canProceed,
    ),
  );
  await section(`education`, () =>
    phenomAddEntries(
      `educationData`,
      profile.educationData,
      async (entry, item) => {
        // Options load late; then the shared rules pick one exact option.
        await phenomOptionsLoaded(
          `${item}//select[contains(@id, 'fieldOfStudy')]`,
        );
        await phenomOptionsLoaded(`${item}//select[contains(@id, 'degree')]`);
        return [
          {
            name: "school",
            find: `${item}//input[contains(@id, 'Institution') or contains(@id, 'schoolName')]`,
            answer: entry.school,
          },
          {
            name: "gpa",
            find: `${item}//input[contains(@id, 'gradeAverage') or contains(@id, 'overall')]`,
            answer: entry.gpa,
          },
          {
            name: "field-of-study",
            find: `${item}//select[contains(@id, 'fieldOfStudy')]`,
            answer: JobsProfileAnswers.literalSpec(
              "known-answer",
              entry.fieldOfStudy,
            ),
          },
          {
            name: "program",
            find: `${item}//input[contains(@id, 'program')]`,
            answer: entry.fieldOfStudy,
          },
          {
            name: "degree",
            find: `${item}//select[contains(@id, 'degree')]`,
            answer: JobsProfileAnswers.degreeSpec(entry.degree),
          },
        ];
      },
      canProceed,
    ),
  );
  await section(`preferences`, () =>
    phenomFillPreferencesPage(profile, canProceed),
  );
  await JobsFormPipeline.bind([
    {
      name: "skills",
      find: `//textarea[contains(@id, 'skills')] | //input[contains(@id, 'skills')]`,
      answer: profile.skillsData?.join(`, `),
    },
    {
      name: "linkedin",
      find: `//input[contains(@label, 'LinkedIn')]`,
      answer: profile.websiteData.linkedin,
    },
  ]);
}
async function phenomFillPreferencesPage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`languages`, () =>
    phenomAddEntries(
      `languageData`,
      profile.languageData,
      async (entry, item) => {
        const language = `${item}//select[contains(@id, '.language')]`,
          lower = jobsLowercaseXPath(`@id`);
        await phenomOptionsLoaded(language);
        const levels = [
          `comprehension`,
          `overall`,
          `reading`,
          `speaking`,
          `writing`,
        ].map((skill) => `${item}//select[contains(${lower}, '${skill}')]`);
        const abilities = jobsFindAllXPath(
          `${item}//select[contains(${lower}, 'language_ability')]`,
        ).map(
          (_, index) =>
            `(${item}//select[contains(${lower}, 'language_ability')])[${index + 1}]`,
        );
        const spec = entry.proficiency
          ? JobsProfileAnswers.languageSpec(entry.proficiency)
          : null;
        return [
          {
            name: "language",
            find: language,
            answer: JobsProfileAnswers.literalSpec(
              "known-answer",
              entry.language,
            ),
          },
          {
            name: "native",
            find: `${item}//input[contains(@id, 'native')]`,
            checked: entry.proficiency === `Native` ? true : undefined,
          },
          ...[...levels, ...abilities].map((find, index) => ({
            name: `level-${index}`,
            find,
            answer: spec,
          })),
        ];
      },
      canProceed,
    ),
  );
  await section(`websites`, () =>
    phenomAddEntries(
      `websites`,
      jobsProfileWebsiteEntries(profile.websiteData),
      (entry, item) => [
        {
          name: "website",
          find: `${item}//input[contains(@id, 'website')]`,
          answer: entry.url,
        },
      ],
      canProceed,
    ),
  );
  await section(`disclosures`, () =>
    phenomFillDisclosuresAndAgreements(profile),
  );
}
// Structure: one fieldset per Profile entry, added with the section's button.
// A new fieldset may be re-rendered once right after it appears.
async function phenomAddEntries(
  name,
  entries,
  bindings,
  canProceed = () => true,
) {
  const section = `//fieldset[contains(@id, '${name}')]`,
    add = `${section}//button[contains(@id, 'add-${name}')]`;
  if (!jobsFindXPath(section)) return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const item = `${section}//fieldset[contains(@id, '${name}') and contains(@id, '[${index}]')]`;
    if (!jobsFindXPath(item)) {
      if (!jobsClick(add, !0)) break;
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(item), { timeout: 5000 }))
      )
        break;
      await JobsFormPipeline.settled(jobsFindXPath(section), { canProceed });
    }
    await JobsFormPipeline.bind(await bindings(entries[index], item));
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function phenomFillDisclosuresAndAgreements(profile) {
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  const both =
    jobsFindXPath(`//select[contains(@id, 'ethnicity')]`) &&
    jobsFindXPath(`//select[contains(@id, 'race')]`);
  await JobsFormPipeline.bind([
    {
      name: "disability",
      find: `//select[contains(@id, 'disabilities')]`,
      answer: eeo(`disability`, employment),
    },
    {
      name: "gender",
      find: `//select[contains(@id, 'gender')]`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "hispanic",
      find: `//select[contains(@id, 'hispanicOrLatino') or contains(@id, 'hispanicLatino')]`,
      answer: eeo(`hispanic`, employment),
    },
    ...(both
      ? [
          {
            name: "ethnicity",
            find: `//select[contains(@id, 'ethnicity')]`,
            answer: eeo(`hispanic`, employment),
          },
          {
            name: "race",
            find: `//select[contains(@id, 'race')]`,
            answer: eeo(`race`, employment),
          },
        ]
      : [
          {
            name: "ethnicity",
            find: `//select[contains(@id, 'race') or contains(@id, 'ethnicity')]`,
            answer: eeo(`ethnicity`, employment),
          },
        ]),
    {
      name: "esignature",
      find: `//input[contains(@id, 'esignatureName')]`,
      answer: profile.nameData.firstName + ` ` + profile.nameData.lastName,
    },
    ...[
      `app_Declaration`,
      `agreementCheck`,
      `arbitrationAgreementConsentConfirmationReference`,
      `businessServicesPlan`,
      `arbitrationAgree`,
      `signature`,
      `acceptAgreement`,
    ].map((id) => ({
      name: id,
      find: `//input[contains(@id, '${id}') and @type='checkbox']`,
      topic: "consent",
    })),
    {
      name: "disability-choice",
      find: `//input[contains(${jobsLowercaseXPath(`@id`)}, 'disability') and (@type='radio' or @type='checkbox')]`,
      answer: eeo(`disability`, employment),
    },
  ]);
}
async function phenomTrackApplication(record = true) {
  let e = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`#job-description-url`)
    ),
    t = ``,
    n = ``,
    r = ``;
  (e && e.textContent && (t = e.textContent.trim()),
    e && e.href && ((n = e.href), (r = new URL(n).origin)),
    jobsTrackApplicationOnUnload(
      JobsPlatformConfig.structure.phenom.submit,
      t,
      n,
      r,
      ``,
      !1,
      3e4,
      undefined,
      record,
    ));
}

export {
  phenomOptionsLoaded,
  phenomRunApplication,
  phenomFillPersonalInformation,
  phenomFillExperiencePage,
  phenomFillPreferencesPage,
  phenomAddEntries,
  phenomFillDisclosuresAndAgreements,
  phenomTrackApplication,
};
