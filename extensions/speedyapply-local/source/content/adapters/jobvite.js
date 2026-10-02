import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { jobsSaveApplicationRecord } from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsFindAllXPath,
  jobsFindXPath,
  jobsStepNavigation,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsFormatToday,
} from "../shared/profile-format.js";
// Each Jobvite step runs as one page pipeline: declared Profile facts and
// disclosures, then the rules (veteran status and the other questions), AI
// for remaining required answers, review and navigation.
async function jobviteRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const step = (found, fill) =>
    found.then(async ([node]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//form[contains(@name, 'applyForm')]//textarea`,
          `../preceding-sibling::label`,
        ],
      ]);
      const root =
        node.closest(JobsPlatformConfig.structure.jobvite.root) || node;
      await JobsFormPipeline.settled(root);
      await JobsAutomatic.advance({
        root,
        profile,
        setMessage,
        ...jobsStepNavigation(
          autofillSettings,
          JobsPlatformConfig.structure.jobvite.next,
          JobsPlatformConfig.structure.jobvite.submit,
        ),
        fill: (current) => fill(profile, current),
      });
    });
  step(
    jobsWaitForCssNodes(JobsPlatformConfig.structure.jobvite.consentRoot),
    jobviteSelectConsentCountry,
  );
  step(
    jobsWaitForXPathNodes(JobsPlatformConfig.structure.jobvite.firstRootXPath),
    jobviteFillPersonalInformation,
  );
  step(
    jobsWaitForXPathNodes(JobsPlatformConfig.structure.jobvite.secondRootXPath),
    jobviteFillDisclosures,
  );
  step(
    jobsWaitForXPathNodes(JobsPlatformConfig.structure.jobvite.thirdRootXPath),
    jobviteFillDisclosures,
  );
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("jobvite").then(() => jobviteRecordApplication());
}
async function jobviteSelectConsentCountry(profile) {
  await JobsFormPipeline.bind([
    {
      name: "country",
      find: `#jv-country-select`,
      answer: JobsProfileAnswers.countrySpec(profile.addressData.country),
    },
  ]);
}
async function jobviteFillPersonalInformation(profile) {
  if (profile.resumeData?.resumeBase64) {
    jobsUploadResume(profile.resumeData, `(//input[@type='file'])[1]`, !0);
    // The resume parser prefills the form; its spinner hides when it is done.
    await JobsDOMWait.until(
      () =>
        jobsFindXPath(
          `//span[@class='jv-spinner ng-hide' and @ng-show='resumeLoading']`,
        ),
      { timeout: 30000 },
    );
  }
  const name = profile.nameData,
    address = profile.addressData,
    answers = JobsProfileAnswers;
  const input = (caption) =>
    `//label[contains(text(),'${caption}')]/following-sibling::div/input`;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `input[autocomplete='given-name']`,
      answer: name.firstName,
    },
    {
      name: "last-name",
      find: `input[autocomplete='family-name']`,
      answer: name.lastName,
    },
    {
      name: "preferred-name",
      find: input(`Preferred`),
      answer: name.preferredName && name.firstName,
    },
    {
      name: "email",
      find: `input[autocomplete='email']`,
      answer: profile.contactData.email,
    },
    {
      name: "address",
      find: `//label[contains(text(),'Address') and not(contains(text(),'Email'))]/following-sibling::div/input`,
      answer:
        address.line1 &&
        `${address.line1}${address.line2 ? `, ${address.line2}` : ``}`,
    },
    { name: "city", find: input(`City`), answer: address.city },
    {
      name: "state",
      find: `//label[contains(text(),'State')]/following-sibling::div//select`,
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "country",
      find: `//label[contains(text(),'Country')]/following-sibling::div//select`,
      answer: answers.countrySpec(address.country),
    },
    {
      name: "postal-code",
      find: `input[autocomplete='postal-code']`,
      answer: address.postalCode,
    },
    {
      name: "phone",
      find: `input[autocomplete='tel']`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "linkedin",
      find: input(`LinkedIn`),
      answer: profile.websiteData.linkedin,
    },
  ]);
}
// One EEO rule for every ATS; this form's own options decide the wording.
// Each signature on the step takes today's date and the full name.
async function jobviteFillDisclosures(profile) {
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  const first =
    (...finds) =>
    () =>
      finds.map((find) => jobsFindXPath(find)).find(Boolean) || null;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: first(
        `//input[@name='gender'] | //legend[contains(text(),'Gender')]/following-sibling::label/input`,
        `//label[contains(text(),'gender')]/following-sibling::div//select`,
      ),
      answer: eeo(`gender`, employment),
    },
    {
      name: "hispanic",
      find: `//legend[contains(text(),'Hispanic or Latino')]/following-sibling::label/input`,
      answer: eeo(`hispanic`, employment),
    },
    {
      name: "race",
      find: first(
        `//legend[contains(text(),'ethnicity') or contains(text(),'race')]/following-sibling::label/input`,
        `//select[@name='input-race']`,
      ),
      answer: eeo(`race`, employment),
    },
    {
      name: "disability",
      find: `//input[contains(@value,'disability')]`,
      answer: eeo(`disability`, employment),
    },
    ...jobsFindAllXPath(`//input[@type='date']`).map((node, index) => ({
      name: `signature-date-${index}`,
      find: () => node,
      answer: jobsFormatToday(`yyyy-MM-dd`),
    })),
    ...jobsFindAllXPath(
      `//label[contains(text(),'Name')]/following-sibling::div/input`,
    ).map((node, index) => ({
      name: `signature-name-${index}`,
      find: () => node,
      answer: jobsFormatFullName(profile.nameData),
    })),
  ]);
}
async function jobviteRecordApplication() {
  let e = jobsFindXPath(
      `//script[@type='text/javascript' and contains(., 'function getCompanyName()')]`,
    ),
    t;
  if (e && e.textContent) {
    let n = e.textContent.match(/return\s+['"](.+?)['"]/);
    t = n ? n[1] : ``;
  } else t = document.title.replace(/\s*Careers\s*$/i, ``).trim();
  let n = window.location.href,
    r = n.match(/^(https:\/\/jobs\.jobvite\.com\/[^/]+\/job\/[^/]+)(\/.*)?/),
    i = r ? r[1] : ``,
    a = n.match(/^(https:\/\/jobs\.jobvite\.com\/[^/]+)\/.*/);
  jobsSaveApplicationRecord({
    jobsSyncProof: "ats_confirmation",
    jobTitle: ``,
    jobLink: i,
    companyLink: a ? a[1] : ``,
    companyName: t,
  });
}

export {
  jobviteRunApplication,
  jobviteSelectConsentCountry,
  jobviteFillPersonalInformation,
  jobviteFillDisclosures,
  jobviteRecordApplication,
};
