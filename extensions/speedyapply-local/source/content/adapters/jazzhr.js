import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsClick,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
} from "../shared/dom-controls.js";
import { jobsTrackApplicationOnUnload } from "../shared/response-capture.js";
// The JazzHR form runs as one page pipeline: declared Profile facts, then
// the rules (age, completed education, veteran status and the other
// questions), AI for remaining required answers and review.
async function jazzhrRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForCssNodes(JobsPlatformConfig.structure.jazzhr.root).then(
    async ([form]) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//div[contains(@class, 'form-group') and not(@id='resumator-resume')]//textarea`,
          `preceding-sibling::label`,
        ],
      ]);
      await jazzhrTrackApplication(Boolean(autofillSettings.saveApplications));
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: `fill`,
        fill: () => jazzhrFillApplication(profile),
      });
    },
  );
}
async function jazzhrFillApplication(profile) {
  const address = profile.addressData,
    school = JobsProfileAnswers.highestEducation(profile.educationData)?.school;
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#resumator-firstname-value`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#resumator-lastname-value`,
      answer: profile.nameData.lastName,
    },
    {
      name: "email",
      find: `#resumator-email-value`,
      answer: profile.contactData.email,
    },
    {
      name: "phone",
      find: `#resumator-phone-value`,
      answer: profile.contactData.phoneNumber,
    },
    {
      name: "address",
      find: `#resumator-address-value`,
      answer:
        address.line1 &&
        address.line1 + (address.line2 ? `, ` + address.line2 : ``),
    },
    { name: "city", find: `#resumator-city-value`, answer: address.city },
    { name: "state", find: `#resumator-state-value`, answer: address.state },
    {
      name: "postal-code",
      find: `#resumator-postal-value`,
      answer: address.postalCode,
    },
    {
      name: "linkedin",
      find: `#resumator-linkedin-value`,
      answer: profile.websiteData.linkedin,
    },
    { name: "college", find: `#resumator-college-value`, answer: school },
    {
      name: "languages",
      find: `#resumator-languages-value`,
      answer: profile.languageData
        .filter((entry) => entry.fluent)
        .map((entry) => entry.language)
        .join(`, `),
    },
  ]);
  await jazzhrFillDisclosures(profile.employmentData);
  if (profile.resumeData?.resumeBase64) {
    jobsUploadResume(profile.resumeData, `#resumator-resume-value`);
    jobsClick(`#resumator-choose-upload`);
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function jazzhrFillDisclosures(employment) {
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: `#resumator-eeo_gender-value`,
      answer: eeo(`gender`, employment),
    },
    {
      name: "race",
      find: `#resumator-eeo_race-value`,
      answer: eeo(`race`, employment),
    },
  ]);
}
async function jazzhrTrackApplication(record = true) {
  let e = document.querySelector(`.job_title, .job-header h1`),
    t = /** @type {HTMLAnchorElement} */ (
      jobsFindXPath(`//span[@id='resumator-view-our-website-text']/..`)
    ),
    n = document.querySelector(`script[type='application/ld+json']`),
    r = ``,
    i = ``,
    a = ``;
  if (
    (e && e.textContent && (r = e.textContent),
    t && t.href && (i = t.href),
    n && n.textContent)
  ) {
    try {
      let t = JSON.parse(n.textContent ?? `{}`);
      if (t["@type"] === "Organization" && typeof t.name === "string")
        a = t.name;
    } catch {}
  } else {
    let e = document.title.match(/-\s*([^-\n]+?)(?:\s*-\s*Career Page)?$/);
    a = e ? e[1].trim() : ``;
  }
  let o = window.location.href;
  if (!i) {
    let e = o.match(/(https:\/\/[^/]*\.(applytojob|theresumator)\.com\/apply)/);
    i = e ? e[1] : ``;
  }
  jobsTrackApplicationOnUnload(
    JobsPlatformConfig.structure.jazzhr.submit,
    r,
    o,
    i,
    a,
    undefined,
    undefined,
    undefined,
    record,
  );
}

export {
  jazzhrRunApplication,
  jazzhrFillApplication,
  jazzhrFillDisclosures,
  jazzhrTrackApplication,
};
