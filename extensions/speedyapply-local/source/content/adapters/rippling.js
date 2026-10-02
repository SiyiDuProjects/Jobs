import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import { jobsTrackApplicationOnUnload } from "../shared/response-capture.js";
// Both Rippling forms run as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the other questions), AI
// for remaining required answers, review and navigation.
async function ripplingRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.rippling.root).then(
    async ([form]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//form[@id='job-application-form']//textarea`,
          `preceding-sibling::label`,
        ],
      ]);
      await ripplingLegacyTrackApplication(
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.rippling.submit,
        fill: (current) => ripplingLegacyFillApplication(profile, current),
      });
    },
  );
  jobsWaitForXPathNodes(`//form//div[@data-testid='field']`).then(
    async ([field]) => {
      void jobsReportJobTitle(ripplingReadApplication().jobTitle);
      const profile = await getProfile(),
        form = field.closest(JobsPlatformConfig.structure.rippling.form);
      if (profile.resumeData?.resumeBase64) {
        setMessage(`uploading-resume`);
        jobsUploadResume(
          profile.resumeData,
          `input[data-testid='input-resume']`,
        );
        // Rippling parses the resume behind an alert; filling starts once it is gone.
        await JobsDOMWait.until(
          () => document.querySelector(`[role='alert']`),
          { timeout: 10000 },
        );
        await JobsDOMWait.until(
          () => !document.querySelector(`[role='alert']`),
          { timeout: 30000 },
        );
      }
      await jobsMountManualAnswerControls(context, [
        [
          `//form//div[@data-testid='field']//textarea`,
          `../../../preceding-sibling::div`,
        ],
      ]);
      let receiptSave,
        receiptRecorded = false;
      autofillSettings.saveApplications &&
        context.addEventListener(
          window,
          `jobs:locationchange`,
          ({ newUrl: t }) => {
            if (
              t.searchParams.get(`step`) !== `confirmation` ||
              receiptRecorded
            )
              return;
            if (!receiptSave)
              receiptSave = ripplingRecordApplication()
                .then((reply) => {
                  if (reply?.ok !== true)
                    throw Error("Receipt was not acknowledged");
                  receiptRecorded = true;
                  setMessage(null);
                })
                .catch(() => setMessage("complete-manually"))
                .finally(() => {
                  receiptSave = undefined;
                });
            return receiptSave;
          },
        );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.rippling.formSubmit,
        fill: (current) => ripplingFillApplication(profile, current),
      });
    },
  );
}
async function ripplingFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `input[data-input='first_name']`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `input[data-input='last_name']`,
        answer: profile.nameData.lastName,
      },
      {
        name: "email",
        find: `input[data-input='email']`,
        answer: profile.contactData.email,
      },
      {
        name: "current-company",
        find: `input[data-input='current_company']`,
        answer: profile.jobData[0]?.company,
      },
      {
        name: "phone",
        find: `input[data-input='phone_number']`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "location",
        find: `[data-testid='location'] input`,
        answer: JobsProfileAnswers.locationSpec(profile.addressData),
      },
      {
        name: "linkedin",
        find: `input[data-input='linkedin_link']`,
        answer: profile.websiteData.linkedin,
      },
      {
        name: "website",
        find: `input[data-input='website_link']`,
        answer: profile.websiteData.personal,
      },
    ]),
  );
  await section(`disclosures`, () =>
    ripplingFillDisclosures(profile.employmentData),
  );
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function ripplingFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec,
    box = (name) => `[data-testid='eeoc.${name}'] [role='combobox']`;
  await JobsFormPipeline.bind([
    { name: "gender", find: box(`gender`), answer: eeo(`gender`, employment) },
    { name: "race", find: box(`race`), answer: eeo(`race`, employment) },
    {
      name: "hispanic",
      find: box(`hispanicOrLatino`),
      answer: eeo(`hispanic`, employment),
    },
    {
      name: "disability",
      find: box(`disabilityStatus`),
      answer: eeo(`disability`, employment),
    },
  ]);
}
function ripplingReadApplication() {
  let e =
      document.querySelector(`title`)?.textContent?.replace(`Apply - `, ``) ??
      ``,
    t = window.location.href,
    n = t.match(/^(https:\/\/ats\.rippling\.com\/[^/]+\/jobs\/[^/]+)(\/.*)?/),
    r = n ? n[1] : ``,
    i = t.match(/^(https:\/\/ats\.rippling\.com\/[^/]+\/jobs)\/.*/);
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: e,
    jobLink: r,
    companyLink: i ? i[1] : ``,
  };
}
async function ripplingRecordApplication() {
  return jobsSaveApplicationRecord(ripplingReadApplication());
}
async function ripplingLegacyFillApplication(profile, canProceed = () => true) {
  const address = profile.addressData,
    answers = JobsProfileAnswers;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#user\\.first_name`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#user\\.last_name`,
      answer: profile.nameData.lastName,
    },
    { name: "email", find: `#user\\.email`, answer: profile.contactData.email },
    {
      name: "phone",
      find: `#user\\.phone`,
      answer:
        profile.contactData.phoneNumber &&
        `1` + profile.contactData.phoneNumber,
    },
    { name: "address1", find: `input#user\\.address1`, answer: address.line1 },
    { name: "address2", find: `#user\\.address2`, answer: address.line2 },
    { name: "city", find: `#user\\.city`, answer: address.city },
    { name: "zip", find: `#user\\.zip`, answer: address.postalCode },
    // The state list is loaded for the chosen country.
    {
      name: "country",
      find: () => document.getElementById(`user.country`),
      answer: answers.countrySpec(address.country),
      after: () =>
        JobsFormPipeline.settled(
          document.querySelector(JobsPlatformConfig.structure.rippling.root) ||
            document.body,
          { canProceed },
        ),
    },
    {
      name: "state",
      find: () => document.getElementById(`user.state`),
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "linkedin",
      find: `#user\\.linkedin_url`,
      answer: profile.websiteData.linkedin,
    },
  ]);
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(
      profile.resumeData,
      `input.dz-hidden-input:nth-of-type(2)`,
    );
  await JobsFormPipeline.bind([
    {
      name: "disclosure-agree",
      find: `#gdpr_disclosure_agree,#disclosure_agree`,
      topic: "consent",
    },
  ]);
}
async function ripplingLegacyTrackApplication(record = true) {
  let e = document.querySelector(`.job-title-container h2`),
    t = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`.company-logo a`)
    ),
    n = ``,
    r = ``;
  (e && e.textContent && (n = e.textContent), t && t.href && (r = t.href));
  let i = window.location.href;
  if (!r) {
    let e = i.match(/(https:\/\/[^/]*\.rippling-ats\.com)/);
    r = e ? e[1] : ``;
  }
  jobsTrackApplicationOnUnload(
    JobsPlatformConfig.structure.rippling.submit,
    n,
    i,
    r,
    undefined,
    undefined,
    undefined,
    undefined,
    record,
  );
}

export {
  ripplingRunApplication,
  ripplingFillApplication,
  ripplingFillDisclosures,
  ripplingRecordApplication,
  ripplingLegacyFillApplication,
  ripplingLegacyTrackApplication,
};
