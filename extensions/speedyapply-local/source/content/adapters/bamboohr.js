import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForXPathNodes,
  jobsWatchXPathPresence,
} from "../shared/dom-controls.js";
import { jobsFormatStreetAddress } from "../shared/profile-format.js";
// The BambooHR form runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the custom questions), AI
// for remaining required answers, review and navigation.
async function bamboohrRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWatchXPathPresence(
    `//button//span[contains(., "View Job Description")]`,
    async () => {
      void jobsReportJobTitle(bamboohrReadApplication().jobTitle);
      const profile = await getProfile(),
        root = document.querySelector(
          JobsPlatformConfig.structure.bamboohr.root,
        );
      await JobsFormPipeline.settled(root);
      await jobsMountManualAnswerControls(context, [
        [`//textarea[not(@aria-hidden='true')]`, `../preceding-sibling::div`],
      ]);
      autofillSettings.saveApplications &&
        jobsWaitForConfirmation("bamboohr").then(() => {
          (setMessage(null), bamboohrRecordApplication());
        });
      await JobsAutomatic.advance({
        root,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        target:
          jobsFindXPath(JobsPlatformConfig.structure.bamboohr.submitXPath) ||
          void 0,
        fill: (current) => bamboohrFillApplication(profile, current),
      });
    },
    () => setMessage(null),
  );
}
async function bamboohrFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  const address = profile.addressData,
    answers = JobsProfileAnswers;
  // The state is a menu for countries with regions, otherwise a text box;
  // it is replaced once the country is chosen.
  const stateMenu = () =>
    jobsFindXPath(`//select[@name='state.value']/preceding-sibling::div`);
  const stateText = () =>
    !stateMenu() && document.querySelector(`input[name='state.value']`);
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `#firstName`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `#lastName`,
        answer: profile.nameData.lastName,
      },
      { name: "email", find: `#email`, answer: profile.contactData.email },
      {
        name: "phone",
        find: `#phone`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "country",
        find: `//select[@name='countryId.value']/preceding-sibling::div`,
        answer: answers.countrySpec(address.country),
        after: () =>
          JobsFormPipeline.settled(
            document.querySelector(
              JobsPlatformConfig.structure.bamboohr.root,
            ) || document.body,
            { canProceed },
          ),
      },
      {
        name: "state",
        find: stateMenu,
        answer: answers.regionSpec(address.state, address.country),
      },
      { name: "state-text", find: stateText, answer: address.state },
      {
        name: "street",
        find: `[name='streetAddress.value']`,
        answer: jobsFormatStreetAddress(address),
      },
      { name: "city", find: `[name='city.value']`, answer: address.city },
      {
        name: "postal-code",
        find: `[name='zip.value']`,
        answer: address.postalCode,
      },
      {
        name: "website",
        find: `#websiteUrl`,
        answer: profile.websiteData.personal,
      },
      {
        name: "linkedin",
        find: `#linkedinUrl`,
        answer: profile.websiteData.linkedin,
      },
      {
        name: "school",
        find: `#educationInstitutionName`,
        answer: profile.educationData[0]?.school,
      },
    ]),
  );
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      jobsUploadResume(
        profile.resumeData,
        `//input[@name='resumeFileId']/preceding-sibling::div[1]//input[@type='file']`,
        !0,
      ),
  );
  await section(`disclosures`, () =>
    bamboohrFillDisclosures(profile.employmentData),
  );
}
function bamboohrReadApplication() {
  let e = document.querySelector(`h3`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href.match(
      /^(https:\/\/[^/]+\.bamboohr\.com\/careers)(?:\/(\d+))?/,
    ),
    r = n ? n[1] : ``,
    i = n && n[2] ? `${n[1]}/${n[2]}` : ``;
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: t,
    jobLink: i,
    companyLink: r,
  };
}
async function bamboohrRecordApplication() {
  jobsSaveApplicationRecord(bamboohrReadApplication());
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function bamboohrFillDisclosures(employment) {
  const menu = (name) =>
    `//select[@name='${name}']/preceding-sibling::div//div[@role='button' and @aria-haspopup='true'] | //select[@name='${name}']/preceding-sibling::div//button[@aria-haspopup='true' and @data-menu-id]`;
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: menu(`genderId`),
      answer: eeo(`gender`, employment),
    },
    {
      name: "race",
      find: menu(`ethnicityId`),
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: menu(`disabilityId`),
      answer: eeo(`disability`, employment),
    },
  ]);
}

export {
  bamboohrRunApplication,
  bamboohrFillApplication,
  bamboohrRecordApplication,
  bamboohrFillDisclosures,
};
