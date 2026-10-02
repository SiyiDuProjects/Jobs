import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsPageSession } from "../../../src/custom/control-content.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsAshbyControls } from "../../../src/custom/ashby-controls.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
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
} from "../shared/dom-controls.js";
async function ashbyRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  JobsPageSession?.setAutofill(async () => {
    const root = document.querySelector(
        JobsPlatformConfig.structure.ashby.root,
      ),
      profile = await getProfile();
    return JobsAutomatic.advance({
      root,
      profile,
      action: "fill",
      retry: true,
      setMessage,
      fill: (current) => ashbyFillApplication(profile, null, current),
    });
  });
  // Each Ashby form runs as one page pipeline: declared Profile facts and
  // the questions by rule, then AI for remaining required answers, review
  // and navigation. Filling starts once the form's fields stop changing.
  JobsAshbyControls.watch(
    `//*[@aria-labelledby='job-application-form']//*[contains(@class, 'ashby-application-form-section-container')]`,
    async (jobsLife) => {
      await JobsFormPipeline.settled(jobsLife.root, {
        canProceed: () => jobsLife.current(),
      });
      let i = await getProfile();
      jobsLife.assertCurrent();
      await jobsMountManualAnswerControls(context, [
        [
          `//div[@aria-labelledby='job-application-form']//div[contains(@class, 'ashby-application-form-section-container')]//textarea`,
          `preceding-sibling::label`,
        ],
      ]);
      await ashbyTrackApplication(
        setMessage,
        jobsLife,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: jobsLife.root,
        profile: i,
        canProceed: () => jobsLife.current(),
        setMessage: setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.ashby.submit,
        fill: (current) => ashbyFillApplication(i, jobsLife, current),
      });
    },
    () => setMessage(null),
    context,
    () => setMessage(`complete-required`),
  );
}
async function ashbyFillApplication(
  profile,
  lifecycle,
  canProceed = () => true,
) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  const label = (keyword) =>
    `//label[contains(${jobsLowercaseXPath(`text()`)},'${keyword}')]`;
  const link = (keyword) =>
    jobsFindXPath(
      `${label(keyword)}/following-sibling::input | ${label(keyword)}/following-sibling::*//input`,
    );
  await section(`contact`, () =>
    JobsFormPipeline.bind(
      [
        {
          name: "name",
          find: () =>
            document.querySelector(`#_systemfield_name:not([disabled])`),
          answer: `${profile.nameData.firstName} ${profile.nameData.lastName}`,
        },
        {
          name: "email",
          find: () => document.querySelector(`#_systemfield_email`),
          answer: profile.contactData.email,
        },
        {
          name: "phone",
          find: () => document.querySelector(`[type='tel']`),
          answer: profile.contactData.phoneNumber,
        },
        {
          name: "linkedin",
          find: () => link(`linkedin`),
          answer: profile.websiteData?.linkedin,
        },
        {
          name: "github",
          find: () => link(`github`),
          answer: profile.websiteData?.github,
        },
      ],
      { canProceed },
    ),
  );
  await section(`location`, () =>
    ashbySelectLocation(profile.addressData, lifecycle),
  );
  await section(`disclosures`, () => ashbyFillDisclosures(profile, canProceed));
  await section(
    `resume`,
    () =>
      profile.resumeData?.resumeBase64 &&
      jobsUploadResume(profile.resumeData, `#_systemfield_resume`),
  );
}
// One EEO rule for every ATS; this form's own options decide the wording.
// Veteran status goes through the shared question entrance, which tells
// ordinary from protected veteran status by the question's own options.
async function ashbyFillDisclosures(profile, canProceed = () => true) {
  const control = (field) =>
    jobsFindXPath(
      `//label[contains(@for,'_systemfield_eeoc_${field}')]/preceding-sibling::span//input`,
    );
  const eeo = JobsProfileAnswers.eeoSpec;
  await JobsFormPipeline.bind(
    [
      {
        name: "gender",
        find: () => control(`gender`),
        answer: eeo(`gender`, profile.employmentData),
      },
      {
        name: "race",
        find: () => control(`race`),
        answer: eeo(`race`, profile.employmentData),
      },
      {
        name: "disability",
        find: () => control(`disability_status`),
        answer: eeo(`disability`, profile.employmentData),
      },
    ],
    { canProceed },
  );
}
async function ashbyTrackApplication(setMessage, lifecycle, record = true) {
  const jobsUrl = location.href;
  let t = document.querySelector(`h1`),
    n = /** @type {HTMLAnchorElement} */ (
      jobsFindXPath(`//a[contains(@class, 'navLogoLink')]`)
    ),
    r = /** @type {HTMLImageElement} */ (document.querySelector(`a img`)),
    i = ``,
    a = ``,
    o = ``;
  (t && t.textContent && (i = t.textContent),
    n && n.href && (a = n.href),
    (o = r && r.alt ? r.alt : document.title.split(` @ `).pop()?.trim() || ``));
  let s = window.location.href,
    c =
      s.match(/^(https:\/\/jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]+)/)?.[1] ?? ``;
  void jobsReportJobTitle(i, jobsUrl);
  if (!record) return;
  ((a ||= s.match(/^(https:\/\/jobs\.ashbyhq\.com\/[^/]+)/)?.[1] ?? ``),
    jobsWaitForConfirmation("ashby", { signal: lifecycle?.signal }).then(
      (found) => {
        if (
          location.href !== jobsUrl ||
          (lifecycle && (!found || !lifecycle.canConfirm()))
        )
          return;
        (setMessage(null),
          jobsSaveApplicationRecord({
            jobsSyncProof: "ats_confirmation",
            jobTitle: i,
            jobLink: c,
            companyLink: a,
            companyName: o,
          }));
      },
    ));
}
async function ashbySelectLocation(address, lifecycle) {
  return JobsFormPipeline.bind([
    {
      name: "location",
      find: () =>
        jobsFindXPath(
          `//label[@for='_systemfield_location']/following-sibling::input | //label[contains(${jobsLowercaseXPath("text()")},'location')]/following-sibling::input[@aria-haspopup='listbox'] | //label[contains(${jobsLowercaseXPath("text()")},'location')]/following-sibling::div/input[@aria-haspopup='listbox']`,
        ),
      answer: JobsProfileAnswers.locationSpec(address),
    },
  ]);
}

export {
  ashbyRunApplication,
  ashbyFillApplication,
  ashbyFillDisclosures,
  ashbyTrackApplication,
  ashbySelectLocation,
};
