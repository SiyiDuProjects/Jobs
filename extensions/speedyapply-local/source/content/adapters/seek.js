import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForCssNodes,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
// Each Seek step runs as one page pipeline: declared Profile facts, history
// drawers and skills, then the rules, AI for remaining required answers,
// review and navigation. The last step submits from the review page.
async function seekRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
}) {
  const current = (name) =>
    `//ol//li//button[@tabindex='0' and @aria-current='step' and contains(., '${name}')]`;
  const step = (name, fill, last = false) =>
    jobsWaitForXPathNodes(current(name)).then(async () => {
      // The step's form is the page's application root.
      const profile = await getProfile();
      await JobsFormPipeline.settled(JobsPageSession?.root() || document.body);
      await JobsAutomatic.advance({
        profile,
        setMessage,
        ...(last
          ? {
              action: autofillSettings.autoSubmit ? `submit` : `fill`,
              selector: JobsPlatformConfig.structure.seek.submit,
              review: true,
            }
          : {
              action: autofillSettings.autoClickNextPage ? `next` : `fill`,
              selector: JobsPlatformConfig.structure.seek.next,
            }),
        fill: fill && ((canProceed) => fill(profile, canProceed)),
      });
    });
  step(`document`, seekFillDocumentsPage);
  step(`question`, null);
  step(`SEEK`, seekFillProfilePage);
  step(`submit`, null, true);
  jobsWaitForXPathNodes(current(`submit`)).then(() =>
    seekTrackApplication(Boolean(autofillSettings.saveApplications)),
  );
}
async function seekFillDocumentsPage(profile) {
  const answers = JobsProfileAnswers;
  // Personal details open as an editable panel only when Seek lacks them.
  const save = document.querySelector(
    `button[data-testid='save-personal-details']`,
  );
  if (save) {
    await JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `input#firstName`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `input#lastName`,
        answer: profile.nameData.lastName,
      },
      {
        name: "location",
        find: `input[data-automation="current-location2"]`,
        answer: answers.locationSpec(profile.addressData),
      },
      {
        name: "calling-code",
        find: `select#countryCallingCode`,
        answer: answers.countrySpec(profile.addressData.country),
      },
      {
        name: "phone",
        find: `input#phoneNumber`,
        answer: profile.contactData.phoneNumber,
      },
    ]);
    jobsClick(`button[data-testid='save-personal-details']`);
  }
  // A resume Seek already stores is chosen by its file name; otherwise upload it.
  const documents = /** @type {HTMLSelectElement} */ (
      document.querySelector(`select[data-testid="select-input"]`)
    ),
    fileName = profile.resumeData?.fileName;
  if (
    documents &&
    [...documents.options].some((option) => option.text.trim() === fileName)
  )
    await JobsFormPipeline.bind([
      {
        name: "resume",
        find: () => documents,
        answer: answers.literalSpec("known-answer", fileName),
      },
    ]);
  else if (profile.resumeData?.resumeBase64)
    jobsUploadResume(profile.resumeData, `input#resume-fileFile`);
  await JobsFormPipeline.bind([
    {
      name: "cover-letter-none",
      find: `input[data-testid='coverLetter-method-none']`,
      checked: true,
    },
  ]);
}
async function seekFillProfilePage(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`employment`, () =>
    seekFillEmploymentHistory(profile.jobData, canProceed),
  );
  await section(`education`, () =>
    seekFillEducationHistory(profile.educationData, canProceed),
  );
  await section(`skills`, () => seekFillSkills(profile.skillsData));
}
// Structure: each Profile entry is edited in a drawer opened from its row
// (or the add button) and closed with the drawer's save button.
async function seekEditInDrawer(open, drawer, save, bindings) {
  jobsClick(...open);
  const panel = await JobsDOMWait.until(() => document.querySelector(drawer), {
    timeout: 5000,
  });
  if (!panel) throw Error(`Drawer did not open: ${drawer}`);
  await JobsFormPipeline.bind(bindings);
  jobsClick(save);
  await JobsDOMWait.until(() => !panel.isConnected, { timeout: 5000 });
}
async function seekFillEmploymentHistory(
  employmentEntries,
  canProceed = () => true,
) {
  const date = JobsProfileAnswers.datePartSpec;
  await JobsDOMWait.until(
    () => document.querySelector(`[data-automation='career-history-section']`),
    { timeout: 5000 },
  );
  for (
    let index = 0;
    index < employmentEntries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const entry = employmentEntries[index],
      row = `(//div[@data-automation='career-history-section']//ul//li//div[@data-automation='read-role'])[${index + 1}]`;
    await seekEditInDrawer(
      jobsFindXPath(row)
        ? [`${row}//button`, !0]
        : [`[data-automation='add-role']`],
      `[data-automation='career-history-form-drawer']`,
      `[data-automation='career-history-save-button']`,
      [
        {
          name: "title",
          find: `input[data-automation='role-title']`,
          answer: entry.jobTitle,
        },
        {
          name: "company",
          find: `input[data-automation='company-name']`,
          answer: entry.company,
        },
        {
          name: "start-month",
          find: `select#from-month`,
          answer: date(entry.startDate, "month"),
        },
        {
          name: "start-year",
          find: `select#from-year`,
          answer: date(entry.startDate, "year"),
        },
        {
          name: "end-month",
          find: `select#to-month`,
          answer: entry.endDate && date(entry.endDate, "month"),
        },
        {
          name: "end-year",
          find: `select#to-year`,
          answer: entry.endDate && date(entry.endDate, "year"),
        },
        {
          name: "still-in-role",
          find: `input#stillInRole`,
          checked:
            !entry.endDate && entry.currentlyWorkHere === true
              ? true
              : undefined,
        },
        {
          name: "achievements",
          find: `textarea[data-automation='career-history-achievements']`,
          answer: entry.description,
        },
      ],
    );
  }
}
async function seekFillEducationHistory(
  educationEntries,
  canProceed = () => true,
) {
  const date = JobsProfileAnswers.datePartSpec;
  await JobsDOMWait.until(
    () => document.querySelector(`[data-automation='education-section']`),
    { timeout: 5000 },
  );
  for (
    let index = 0;
    index < educationEntries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const entry = educationEntries[index],
      row = `(//div[@data-automation='education-section']//ul//li//div[@data-automation='read-qualification'])[${index + 1}]`;
    const attending = entry.currentlyAttending === true;
    await seekEditInDrawer(
      jobsFindXPath(row)
        ? [`${row}//button`, !0]
        : [`[data-automation='add-education']`],
      `[data-automation='education-form-drawer']`,
      `[data-automation='education-save-button']`,
      [
        {
          name: "qualification",
          find: `input[data-automation='qualification']`,
          answer: entry.fieldOfStudy,
        },
        {
          name: "institute",
          find: `input[data-automation='institute']`,
          answer: entry.school,
        },
        {
          name: "completed",
          find: `input#completed`,
          checked: attending ? undefined : true,
        },
        {
          name: "completion-month",
          find: `select#completionDate-month`,
          answer: attending && entry.endDate && date(entry.endDate, "month"),
        },
        {
          name: "completion-year",
          find: attending
            ? `select#completionDate-year`
            : `select#completionDate`,
          answer: entry.endDate && date(entry.endDate, "year"),
        },
      ],
    );
  }
}
// Skills are free-text tags added in their own drawer.
async function seekFillSkills(skills) {
  if (!skills?.length) return;
  await JobsDOMWait.until(
    () => document.querySelector(`[data-automation="skill-section"]`),
    { timeout: 5000 },
  );
  jobsClick(`[data-testid="add-skills"]`);
  const drawer = await JobsDOMWait.until(
    () => document.querySelector(`[data-automation="skills-form-drawer"]`),
    { timeout: 5000 },
  );
  if (!drawer) return;
  const [added] = await JobsFormPipeline.bind([
    {
      name: "skills",
      find: () => drawer,
      answers: skills.map(JobsProfileAnswers.skillSpec).filter(Boolean),
    },
  ]);
  jobsClick(
    added
      ? `[data-automation="skills-save-button"]`
      : `button[aria-label="Close"]`,
  );
  await JobsDOMWait.until(() => !drawer.isConnected, { timeout: 5000 });
}
async function seekTrackApplication(record = true) {
  let e = document.querySelector(`h1`),
    t = ``;
  e && e.textContent && (t = e.textContent);
  let n = window.location.href.match(
      /^(https:\/\/www\.seek\.com\.au\/job\/\d+)(?:\/apply.*)?$/,
    ),
    r = n ? n[1] : ``;
  void jobsReportJobTitle(t);
  if (!record) return;
  jobsWaitForConfirmation("seek").then(() =>
    jobsSaveApplicationRecord({
      jobsSyncProof: "ats_confirmation",
      jobTitle: t,
      jobLink: r,
    }),
  );
}

export {
  seekRunApplication,
  seekFillDocumentsPage,
  seekFillProfilePage,
  seekEditInDrawer,
  seekFillEmploymentHistory,
  seekFillEducationHistory,
  seekFillSkills,
  seekTrackApplication,
};
