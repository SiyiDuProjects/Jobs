import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForXPathNodesWithRetry,
  jobsWatchXPathPresence,
} from "../shared/dom-controls.js";
// The Pinpoint form runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the other questions), AI
// for remaining required answers and review.
async function pinpointRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  if (
    autofillSettings.saveApplications &&
    JobsPlatformConfig.confirmation(document, "pinpoint") !== null
  ) {
    pinpointRecordApplication();
    return;
  }
  jobsWatchXPathPresence(
    JobsPlatformConfig.structure.pinpoint.rootXPath,
    async (form) => {
      void jobsReportJobTitle(pinpointReadApplication().jobTitle);
      const profile = await getProfile();
      // The questions block mounts behind a suspense fallback.
      await jobsWaitForXPathNodesWithRetry(
        `//fieldset[@id='application-fieldset-questions'][not(.//div[contains(@class, 'react-suspense-fallback')])]`,
      );
      await jobsMountManualAnswerControls(context, [
        [`//textarea[@id='personal-summary']`, `preceding-sibling::label`],
        [
          `//fieldset[@id='application-fieldset-questions']//textarea`,
          `../../../../label`,
        ],
      ]);
      await JobsFormPipeline.settled(form);
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: `fill`,
        fill: (current) => pinpointFillApplication(profile, current),
      });
    },
    () => setMessage(null),
  );
}
async function pinpointFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  const address = profile.addressData,
    answers = JobsProfileAnswers;
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `#application_form_application_first_name`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `#application_form_application_last_name`,
        answer: profile.nameData.lastName,
      },
      {
        name: "email",
        find: `#application_form_application_email`,
        answer: profile.contactData.email,
      },
      {
        name: "phone",
        find: `#application_form_application_phone`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "country",
        find: `//label[contains(text(), 'Country')]/following-sibling::div`,
        answer: answers.countrySpec(address.country),
      },
      {
        name: "address",
        find: `#address1`,
        answer:
          address.line1 &&
          `${address.line1}${address.line2 ? ` ${address.line2}` : ``}`,
      },
      {
        name: "city",
        find: `//label[contains(text(), 'City') or contains(text(), 'Town')]/following-sibling::input`,
        answer: address.city,
      },
      {
        name: "state",
        find: `//label[contains(text(), 'State')]/following-sibling::div`,
        answer: answers.regionSpec(address.state, address.country),
      },
      { name: "postal-code", find: `#postcode`, answer: address.postalCode },
      {
        name: "linkedin",
        find: `#application_form_application_linkedin_url`,
        answer: profile.websiteData.linkedin,
      },
    ]),
  );
  await section(`disclosures`, () =>
    pinpointFillDisclosures(profile.employmentData),
  );
  await section(`resume`, async () => {
    const cv = `#application_form\\[application\\]\\[cv\\]`;
    profile.resumeData?.resumeBase64 &&
      (await JobsDOMWait.until(() => document.querySelector(cv), {
        timeout: 5000,
      })) &&
      jobsUploadResume(profile.resumeData, cv);
  });
  await JobsFormPipeline.bind([
    {
      name: "process-information",
      find: `#application_process_information`,
      topic: "consent",
    },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function pinpointFillDisclosures(employment) {
  const select = (name) => () => {
    const open = jobsFindXPath(
      `//div[contains(@id, 'application_form_equality_monitoring_${name}')]//div[contains(@class, 'react-select__placeholder') or contains(@class, 'react-select__single-value')]`,
    );
    return (
      /** @type {Element} */ (open)?.closest(".react-select__control") || open
    );
  };
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: select(`Gender`),
      answer: eeo(`gender`, employment),
    },
    {
      name: "disability",
      find: select(`Disability`),
      answer: eeo(`disability`, employment),
    },
  ]);
}
function pinpointReadApplication() {
  let e = jobsFindXPath(`//a/span`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href,
    r = new URL(n),
    i = n.match(
      /^(https:\/\/[^/]+\.pinpointhq\.com\/[^/]+\/postings\/[a-f0-9-]+)(\/applications\/thanks)?/,
    ),
    a = i ? i[1] : ``;
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: t,
    jobLink: a,
    companyLink: `https://${r.hostname}`,
  };
}
async function pinpointRecordApplication() {
  await jobsSaveApplicationRecord(pinpointReadApplication());
}

export {
  pinpointRunApplication,
  pinpointFillApplication,
  pinpointFillDisclosures,
  pinpointRecordApplication,
};
