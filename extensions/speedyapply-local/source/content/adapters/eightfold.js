import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import {
  jobsIgnoredKeywordXPathPredicate,
  jobsKeywordXPathPredicate,
  jobsLowercaseXPath,
} from "../shared/answer-helpers.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitAndClick,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import { jobsFormatFullName } from "../shared/profile-format.js";
// A question's text box, found by its label's keywords.
function eightfoldTextByLabel(keywords, ignore = []) {
  const label = `//div[(contains(@class, 'body-question-label') or contains(@class, 'apply-question-label-container')) and ${jobsKeywordXPathPredicate({ keywords, appearances: 1 })} ${jobsIgnoredKeywordXPathPredicate({ ignore })}]`;
  return `${label}/following-sibling::div//*[self::textarea or (self::input and not(@type="file") and not(@role="combobox")) and not(ancestor::*[contains(@class, 'select-module') or contains(@class, 'checkBoxGroup') or @role='radiogroup'])]`;
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function eightfoldFillAlternateApplication(profile) {
  const lower = jobsLowercaseXPath(`@data-test-id`),
    answers = JobsProfileAnswers,
    name = profile.nameData,
    address = profile.addressData;
  const combobox = (test) => `//div[${test}]//input[@role='combobox']`,
    input = (id) => `//input[contains(@data-test-id, '${id}')]`;
  const eeo = (field) =>
    combobox(
      `contains(${lower}, '${field}') and not(contains(${lower}, 'transgender'))`,
    );
  await JobsFormPipeline.bind([
    { name: "first-name", find: input(`firstname`), answer: name.firstName },
    { name: "last-name", find: input(`lastname`), answer: name.lastName },
    { name: "email", find: input(`email`), answer: profile.contactData.email },
    {
      name: "phone-country",
      find: combobox(`contains(${lower}, 'phone-country')`),
      answer: answers.countrySpec(address.country),
    },
    {
      name: "phone",
      find: input(`phone`),
      answer: profile.contactData.phoneNumber,
    },
    // The state list is loaded for the chosen country.
    {
      name: "country",
      find: combobox(
        `contains(${lower}, 'country') and not(contains(${lower}, 'phone'))`,
      ),
      answer: answers.countrySpec(address.country),
      after: (node, canProceed) =>
        JobsFormPipeline.settled(node.closest(`form`) || document.body, {
          canProceed,
        }),
    },
    {
      name: "state",
      find: combobox(`contains(${lower}, 'state')`),
      answer: answers.regionSpec(address.state, address.country),
    },
    { name: "city", find: input(`city`), answer: address.city },
    {
      name: "preferred-name",
      find: input(`preferredName`),
      answer: name.preferredName && name.preferredFirstName,
    },
    { name: "address", find: input(`address`), answer: address.line1 },
    { name: "address2", find: input(`address2`), answer: address.line2 },
    { name: "zip", find: input(`zip`), answer: address.postalCode },
    {
      name: "portfolio",
      find: input(`portfolio`),
      answer: profile.websiteData.personal,
    },
    {
      name: "disability",
      find: eeo(`disability`),
      answer: answers.eeoSpec(`disability`, profile.employmentData),
    },
    {
      name: "gender",
      find: eeo(`gender`),
      answer: answers.eeoSpec(`gender`, profile.employmentData),
    },
    {
      name: "ethnicity",
      find: eeo(`ethnicity`),
      answer: answers.eeoSpec(`ethnicity`, profile.employmentData),
    },
    {
      name: "consent",
      find: `//input[@type='checkbox' and contains(${jobsLowercaseXPath(`@id`)}, 'consent')]`,
      topic: "consent",
    },
    {
      name: "agree",
      find: `//input[@type='checkbox' and contains(${jobsLowercaseXPath(`@id`)}, 'agree') and not(contains(${jobsLowercaseXPath(`@id`)}, 'consent'))]`,
      topic: "consent",
    },
    {
      name: "signature",
      find: `//input[contains(${lower}, 'signature') and not(@type='checkbox')]`,
      answer: jobsFormatFullName(name),
    },
  ]);
}
async function eightfoldTrackAlternateApplication(setMessage, record = true) {
  let t = jobsFindXPath(`//div[contains(@class, 'jobCartPositionName')]`),
    n = /** @type {HTMLMetaElement} */ (
      document.querySelector(`meta[name="description"]`)
    ),
    r = document.querySelector(`link[rel="canonical"]`),
    i = ``,
    a = ``;
  (t && t.textContent && (i = t.textContent),
    /** @type {HTMLMetaElement} */ (n)?.content &&
      /^careers at /i.test(n.content) &&
      (a = n.content.replace(/^careers at /i, ``)));
  let o = /** @type {HTMLAnchorElement} */ (r)?.href || window.location.href,
    s = o.match(/^(https?:\/\/[^/]+\/careers)/),
    c = o.match(/^https?:\/\/[^/]+/),
    l = s ? s[1] : c?.[0] || ``;
  void jobsReportJobTitle(i);
  if (!record) return;
  jobsWaitForConfirmation("eightfold").then(() => {
    (setMessage(null),
      jobsSaveApplicationRecord({
        jobsSyncProof: "ats_confirmation",
        jobTitle: i,
        jobLink: o,
        companyLink: l,
        companyName: a,
      }));
  });
}
async function eightfoldFillApplication(profile) {
  const answers = JobsProfileAnswers,
    address = profile.addressData,
    testid = (id) => `input[data-testid='${id}']`;
  const labelled = (keyword) =>
    `//div[contains(@class, 'apply-question-label-container') and contains(${jobsLowercaseXPath(`.`)}, '${keyword}')]/following-sibling::div`;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: testid(`common-text-input-first-name-input`),
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: testid(`common-text-input-last-name-input`),
      answer: profile.nameData.lastName,
    },
    {
      name: "email",
      find: testid(`common-text-input-postion-apply-input-email`),
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: testid(`common-text-input-phone-input`),
      answer: profile.contactData.phoneNumber,
    },
    // The state list is loaded for the chosen country.
    {
      name: "country",
      find: `${labelled(`country`)}//input[@role='combobox']`,
      answer: answers.countrySpec(address.country),
      after: (node, canProceed) =>
        JobsFormPipeline.settled(node.closest(`form`) || document.body, {
          canProceed,
        }),
    },
    {
      name: "state",
      find: `${labelled(`state`)}//input[not(@type='hidden')]`,
      answer: answers.regionSpec(address.state, address.country),
    },
    {
      name: "address",
      find: eightfoldTextByLabel([`address`, `street`], [`email`]),
      answer:
        address.line1 &&
        `${address.line1}${address.line2 ? `, ${address.line2}` : ``}`,
    },
    {
      name: "city",
      find: eightfoldTextByLabel([`city`]),
      answer: address.city,
    },
    {
      name: "postal-code",
      find: eightfoldTextByLabel([`post`, `zip`]),
      answer: address.postalCode,
    },
  ]);
}
async function eightfoldTrackApplication(setMessage, record = true) {
  let t = document.querySelector(`.apply-position-title`),
    n = ``;
  t && t.textContent && (n = t.textContent);
  let r = new URL(window.location.href),
    i = `${r.protocol}//${r.hostname}${r.pathname}`,
    a = r.searchParams.has(`pid`)
      ? `${i}?pid=${r.searchParams.get(`pid`)}`
      : ``;
  void jobsReportJobTitle(n);
  if (!record) return;
  jobsWaitForConfirmation("eightfold").then(() => {
    (setMessage(null),
      jobsSaveApplicationRecord({
        jobsSyncProof: "ats_confirmation",
        jobTitle: n,
        jobLink: a,
        companyLink: i,
      }));
  });
}
// Each Eightfold form runs as one page pipeline: the resume first, declared
// Profile facts, then the rules (the questions, disclosures and source), AI
// for remaining required answers, review and navigation.
async function eightfoldRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const dropzone = `//div[contains(@class,'upload-resume-modal')]//div[@data-test-id='upload-resume-component-dropzone']`;
  jobsWaitForXPathNodes(dropzone).then(async () => {
    const profile = await getProfile();
    if (!profile.resumeData?.resumeBase64) return;
    jobsUploadResume(
      profile.resumeData,
      `//div[@data-test-id='upload-resume-component-dropzone']//input`,
      !0,
    );
    await jobsWaitAndClick(`button[data-test-id='confirm-upload-resume']`);
  });
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.eightfold.rootXPath).then(
    async ([main]) => {
      const profile = await getProfile();
      // Without an attached resume the upload dialog is opened first.
      if (
        !jobsFindXPath(
          `//button[@id='resume-upload']//p[@class='resume-name']`,
        ) &&
        jobsClick(`//button[@id='resume-upload']`, !0)
      ) {
        await jobsWaitForXPathNodes(dropzone);
        await JobsDOMWait.until(
          () =>
            !jobsFindXPath(dropzone) &&
            document.getElementById(`apply-form-main-content`),
          { timeout: 60000 },
        );
      }
      await JobsFormPipeline.settled(main.closest(`form`) || main);
      await jobsMountManualAnswerControls(context, [
        [
          `//textarea`,
          `ancestor::div[contains(@class, 'apply-item-scroll')][1]`,
        ],
      ]);
      await eightfoldTrackApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.eightfold.submit,
        fill: () => eightfoldFillApplication(profile),
      });
    },
  );
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.eightfold.formXPath).then(
    async ([form]) => {
      const profile = await getProfile();
      if (profile.resumeData?.resumeBase64) {
        jobsUploadResume(
          profile.resumeData,
          `//span[contains(@class, 'upload-resume-dropzone')]//input`,
          !0,
        );
        // The resume is parsed while its progress bar shows.
        const progress = `//span[contains(@class, 'upload-resume-dropzone')]//div[contains(@class, 'upload-module_upload-list-item-progress')]`;
        await JobsDOMWait.until(() => jobsFindXPath(progress), {
          timeout: 10000,
        });
        await JobsDOMWait.until(() => !jobsFindXPath(progress), {
          timeout: 60000,
        });
      }
      await JobsFormPipeline.settled(form);
      await eightfoldTrackAlternateApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.eightfold.formSubmit,
        fill: () => eightfoldFillAlternateApplication(profile),
      });
    },
  );
}

export {
  eightfoldTextByLabel,
  eightfoldFillAlternateApplication,
  eightfoldTrackAlternateApplication,
  eightfoldFillApplication,
  eightfoldTrackApplication,
  eightfoldRunApplication,
};
