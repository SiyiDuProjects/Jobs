import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsUploadResume,
  jobsWaitForCssNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatProfileMonth,
  jobsIsProfileMonthInPast,
} from "../shared/profile-format.js";
// The SmartRecruiters widgets live in open shadow roots; each is one field
// written through its registered component.
async function smartrecruitersFillApplication(
  profile,
  canProceed = () => true,
) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await JobsDOMWait.until(
    () => document.querySelector(`oc-personal-information`),
    { timeout: 10000 },
  );
  await section(`contact`, () => smartrecruitersFillContact(profile));
  const employment = await section(`employment`, () =>
    smartrecruitersAddEntries(
      `experience`,
      profile.jobData,
      (entry, form) => [
        {
          name: "title",
          find: `${form} [data-test='job-title-autocomplete']`,
          answer: JobsProfileAnswers.literalSpec(
            "known-answer",
            entry.jobTitle,
          ),
        },
        {
          name: "company",
          find: `${form} [data-test='company-autocomplete']`,
          answer: JobsProfileAnswers.literalSpec("known-answer", entry.company),
        },
        {
          name: "location",
          find: `${form} [data-test='location-autocomplete']`,
          answer: JobsProfileAnswers.locationSpec(entry.location),
        },
        {
          name: "description",
          find: `${form} [data-test='experience-description'] spl-textarea`,
          answer: entry.description,
        },
        {
          name: "from",
          find: `${form} [data-test='experience-date-from'] spl-date-field`,
          answer:
            entry.startDate &&
            jobsFormatProfileMonth(entry.startDate, `yyyy-MM-dd`),
        },
        {
          name: "to",
          find: `${form} [data-test='experience-date-to'] spl-date-field`,
          answer:
            entry.endDate &&
            jobsFormatProfileMonth(entry.endDate, `yyyy-MM-dd`),
        },
        {
          name: "current",
          find: `${form} [data-test='experience-current'] spl-checkbox`,
          checked: entry.currentlyWorkHere === true ? true : undefined,
        },
      ],
      canProceed,
    ),
  );
  const education = await section(`education`, () =>
    smartrecruitersAddEntries(
      `education`,
      profile.educationData,
      (entry, form) => [
        {
          name: "institution",
          find: `${form} [data-test='institution-autocomplete']`,
          answer: JobsProfileAnswers.schoolSpec(entry.school),
        },
        {
          name: "major",
          find: `${form} [data-test='education-major'] spl-input`,
          answer: entry.fieldOfStudy,
        },
        {
          name: "degree",
          find: `${form} [data-test='education-degree'] spl-input`,
          answer: entry.degree,
        },
        {
          name: "from",
          find: `${form} [data-test='education-date-from'] spl-date-field`,
          answer:
            entry.startDate &&
            jobsFormatProfileMonth(entry.startDate, `yyyy-MM-dd`),
        },
        {
          name: "to",
          find: `${form} [data-test='education-date-to'] spl-date-field`,
          answer:
            entry.endDate &&
            jobsFormatProfileMonth(entry.endDate, `yyyy-MM-dd`),
        },
        {
          name: "current",
          find: `${form} [data-test='education-current'] spl-checkbox`,
          checked:
            entry.endDate && !jobsIsProfileMonthInPast(entry.endDate)
              ? true
              : undefined,
        },
      ],
      canProceed,
    ),
  );
  await section(`websites`, () =>
    JobsFormPipeline.bind([
      {
        name: "linkedin",
        find: `#linkedin-input`,
        answer: profile.websiteData.linkedin,
      },
      {
        name: "twitter",
        find: `#twitter-input`,
        answer: profile.websiteData.twitter,
      },
      {
        name: "website",
        find: `#website-input`,
        answer: profile.websiteData.personal,
      },
    ]),
  );
  const resume = await section(`resume`, () => {
    const host = document.querySelector(`[data-test="resume-upload"]`);
    return (
      profile.resumeData?.resumeBase64 &&
      host?.shadowRoot &&
      jobsUploadResume(profile.resumeData, `input`, false, host.shadowRoot)
    );
  });
  return [employment, education, resume].find((result) => result?.hold);
}
async function smartrecruitersFillContact(profile) {
  await JobsFormPipeline.bind([
    {
      name: "first-name",
      find: `#first-name-input`,
      answer: profile.nameData.firstName,
    },
    {
      name: "last-name",
      find: `#last-name-input`,
      answer: profile.nameData.lastName,
    },
    { name: "email", find: `#email-input`, answer: profile.contactData.email },
    {
      name: "confirm-email",
      find: `#confirm-email-input`,
      answer: profile.contactData.email,
    },
    {
      name: "location",
      find: `[data-test='personal-info-location'] spl-autocomplete`,
      answer: JobsProfileAnswers.locationSpec(profile.addressData),
    },
    {
      name: "phone",
      find: `spl-phone-field`,
      answer: profile.contactData.phoneNumber,
    },
  ]);
}
// Structure: one entry per Profile item, added with the section's button
// and closed with its save button.
async function smartrecruitersAddEntries(
  name,
  entries,
  bindings,
  canProceed = () => true,
) {
  const form = `oc-${name}-entry [data-test='${name}-edit-form']`;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    if (document.querySelector(form))
      return { hold: `${name} entry is still being edited` };
    if (!jobsClick(`[data-test='${name}'] [data-test='add-${name}']`)) break;
    const open = await JobsDOMWait.until(() => document.querySelector(form), {
      timeout: 5000,
    });
    if (!open) return { hold: `${name} editor did not open` };
    await JobsFormPipeline.bind(
      bindings(entries[index], "").map((binding) => ({
        ...binding,
        find: () => open.querySelector(binding.find.trim()),
      })),
    );
    if (!JobsPageActions.live(canProceed))
      return { hold: `${name} filling stopped` };
    const save = open.querySelector(`[data-test='${name}-save']`);
    if (
      !save ||
      !JobsPageActions.click(save) ||
      !(await JobsDOMWait.until(() => !open.isConnected, { timeout: 5000 }))
    )
      return { hold: `${name} entry was not saved` };
  }
}
// Each SmartRecruiters step runs as one page pipeline: declared Profile
// facts and history on the first, then the rules (the screening questions),
// AI for remaining required answers, review and navigation.
async function smartrecruitersRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const step = (selector, fill, navigation) =>
    jobsWaitForCssNodes(selector).then(async () => {
      void jobsReportJobTitle(smartrecruitersReadApplication().jobTitle);
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [
          `//div[contains(@class, 'application--questions')]//textarea`,
          `preceding-sibling::label`,
        ],
      ]);
      await JobsAutomatic.advance({
        profile,
        setMessage,
        ...navigation,
        fill: (canProceed) => fill(profile, canProceed),
      });
    });
  step(
    JobsPlatformConfig.structure.smartrecruiters.root,
    smartrecruitersFillApplication,
    {
      action: autofillSettings.autoClickNextPage ? `next` : `fill`,
      selector: JobsPlatformConfig.structure.smartrecruiters.next,
    },
  );
  step(
    JobsPlatformConfig.structure.smartrecruiters.questionsRoot,
    () =>
      JobsFormPipeline.bind([
        {
          name: "consent",
          find: `[data-test='consent-box'] spl-checkbox`,
          topic: "consent",
        },
      ]),
    {
      action: autofillSettings.autoSubmit ? `submit` : `fill`,
      selector: JobsPlatformConfig.structure.smartrecruiters.submit,
    },
  );
  autofillSettings.saveApplications &&
    jobsWaitForConfirmation("smartrecruiters").then(() => {
      (setMessage(null), smartrecruitersRecordApplication());
    });
}
function smartrecruitersReadApplication() {
  let e = document.querySelector(`p[data-test='topbar-job-title']`),
    t = /** @type {HTMLImageElement} */ (
      document.querySelector(`img[data-test='topbar-logo']`)
    ),
    n = e && e.textContent ? e.textContent : ``,
    r;
  r =
    t && t.alt
      ? t.alt.replace(/\s*Logo\s*$/i, ``).trim()
      : document.title.split(` - `).pop()?.trim() || ``;
  let i = window.location.href,
    a = i.match(
      /^https:\/\/jobs\.smartrecruiters\.com\/oneclick-ui\/company\/([^/]+)\/(?:job|publication)\/([^/]+)/,
    ),
    o = a ? `https://jobs.smartrecruiters.com/${a[1]}/${a[2]}` : ``,
    s = i.match(
      /^https:\/\/jobs\.smartrecruiters\.com\/oneclick-ui\/company\/([^/]+)/,
    );
  return {
    jobsSyncProof: "ats_confirmation",
    jobTitle: n,
    jobLink: o,
    companyLink: s ? `https://careers.smartrecruiters.com/${s[1]}` : ``,
    companyName: r,
  };
}
async function smartrecruitersRecordApplication() {
  await jobsSaveApplicationRecord(smartrecruitersReadApplication());
}
export {
  smartrecruitersFillApplication,
  smartrecruitersFillContact,
  smartrecruitersAddEntries,
  smartrecruitersRunApplication,
  smartrecruitersRecordApplication,
};
