import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
// The Gusto form runs as one page pipeline: declared Profile facts, then the
// rules, AI for remaining required answers, review and navigation.
async function gustoRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.gusto.root).then(
    async ([form]) => {
      void jobsReportJobTitle(gustoReadApplication().jobTitle);
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//textarea[@id='job_applicant_additional_information']`,
          `../preceding-sibling::label`,
        ],
        [
          `//input[contains(@name, 'custom_form') and contains(@name, '[text]') and @type='text' and not(contains(@placeholder, 'optional'))]`,
          `../../label`,
        ],
      ]);
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.gusto.submit,
        fill: () => gustoFillApplication(profile),
      });
    },
  );
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("gusto").then(() => gustoRecordApplication());
}
async function gustoFillApplication(profile) {
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#job_applicant_first_name`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#job_applicant_last_name`,
      answer: profile.nameData.lastName,
    },
    {
      name: "email",
      find: `#job_applicant_email`,
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: `#job_applicant_phone`,
      answer: profile.contactData.phoneNumber,
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(profile.resumeData, `#job_applicant_resume`);
}
function gustoReadApplication() {
  let e = /** @type {HTMLAnchorElement} */ (jobsFindXPath(`//li[2]//a`)),
    t = /** @type {HTMLAnchorElement} */ (jobsFindXPath(`//li[1]//a`)),
    n = ``,
    r = ``,
    i = ``;
  (e && e.textContent && (n = e.textContent),
    e && e.href && (r = e.href),
    t && t.href && (i = t.href));
  let a = window.location.href;
  if (!r) {
    let e = a.match(/(https:\/\/jobs\.gusto\.com\/postings\/[^/]+-[a-f0-9-]+)/);
    r = e ? e[1] : ``;
  }
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: n,
    jobLink: r,
    companyLink: i,
  };
}
async function gustoRecordApplication() {
  await jobsSaveApplicationRecord(gustoReadApplication());
}

export { gustoRunApplication, gustoFillApplication, gustoRecordApplication };
