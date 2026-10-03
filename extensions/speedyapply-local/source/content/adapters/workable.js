import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
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
  jobsWatchXPathPresence,
} from "../shared/dom-controls.js";
// Each Workable form runs as one page pipeline: declared Profile facts and
// history sections, then the rules, AI for remaining required answers,
// review and navigation.
async function workableRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWatchXPathPresence(
    JobsPlatformConfig.structure.workable.rootXPath,
    async (form) => {
      const profile = await getProfile();
      await jobsMountManualAnswerControls(context, [
        [`//form[@data-ui='application-form']//textarea`, `ancestor::label[1]`],
      ]);
      await workableTrackApplication(
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.workable.submit,
        fill: (current) => workableFillApplication(profile, current),
      });
    },
    () => setMessage(null),
  );
}
async function workableFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  const address = profile.addressData;
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `#firstname`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `#lastname`,
        answer: profile.nameData.lastName,
      },
      { name: "email", find: `#email`, answer: profile.contactData.email },
      {
        name: "phone",
        find: `[name='phone']`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "address",
        find: `#address`,
        answer: `${address.line1}${address.line2 ? ` ` + address.line2 : ``} ${address.postalCode} ${address.city}, ${address.state || address.country}`,
      },
    ]),
  );
  const education = await section(`education`, () =>
    workableAddEntries(
      `education`,
      profile.educationData,
      (entry) => [
        { name: "school", find: `#school`, answer: entry.school },
        {
          name: "field-of-study",
          find: `#field_of_study`,
          answer: entry.fieldOfStudy,
        },
        { name: "degree", find: `#degree`, answer: entry.degree },
        {
          name: "start-date",
          find: `input[name='start_date']`,
          answer: entry.startDate && workableFormatMonth(entry.startDate),
        },
        {
          name: "end-date",
          find: `input[name='end_date']`,
          answer: entry.endDate && workableFormatMonth(entry.endDate),
        },
      ],
      canProceed,
    ),
  );
  if (education?.hold) return education;
  const experience = await section(`experience`, () =>
    workableAddEntries(
      `experience`,
      profile.jobData,
      (entry) => [
        { name: "title", find: `#title`, answer: entry.jobTitle },
        { name: "company", find: `#company`, answer: entry.company },
        { name: "location", find: `#location`, answer: entry.location },
        { name: "summary", find: `#summary`, answer: entry.description },
        {
          name: "start-date",
          find: `input[name='start_date']`,
          answer: entry.startDate && workableFormatMonth(entry.startDate),
        },
        {
          name: "end-date",
          find: `input[name='end_date']`,
          answer: entry.endDate && workableFormatMonth(entry.endDate),
        },
        {
          name: "current",
          find: `input[name='current']`,
          checked: entry.currentlyWorkHere === true ? true : undefined,
        },
      ],
      canProceed,
    ),
  );
  if (experience?.hold) return experience;
  profile.resumeData?.resumeBase64 &&
    jobsUploadResume(profile.resumeData, `input[data-ui='resume']`);
}
// Structure: one inline section per Profile entry, opened with the page's
// add button and closed with its save button.
async function workableAddEntries(
  name,
  entries,
  bindings,
  canProceed = () => true,
) {
  const button = (kind) =>
    document.querySelector(`[data-ui='${name}'] button[data-ui='${kind}']`);
  const scope = document.querySelector(`[data-ui='${name}']`);
  if (!scope) return;
  for (const entry of entries) {
    if (button(`save-section`))
      return { hold: `${name} entry is still being edited` };
    if (!JobsPageActions.live(canProceed) || !button(`add-section`)) break;
    jobsClick(`[data-ui='${name}'] button[data-ui='add-section']`);
    if (
      !(await JobsDOMWait.until(() => button(`save-section`), {
        timeout: 5000,
      }))
    ) {
      JobsDiagnostics?.note(`auto_repeat_section_failed`, null, name);
      return { hold: `${name} editor did not open` };
    }
    // The absent -> present Save transition confirms Add opened a new entry.
    // The persistent section alone is not an entry identity.
    if (
      !JobsPageActions.live(canProceed) ||
      !JobsFormPipeline.beginEntry(scope)
    )
      return { hold: `${name} filling stopped` };
    await JobsFormPipeline.bind(
      bindings(entry).map((binding) => ({
        ...binding,
        find: () => scope.querySelector(binding.find),
      })),
    );
    if (!JobsPageActions.live(canProceed))
      return { hold: `${name} filling stopped` };
    jobsClick(`[data-ui='${name}'] button[data-ui='save-section']`);
    if (
      !(await JobsDOMWait.until(() => !button(`save-section`), {
        timeout: 5000,
      }))
    )
      return { hold: `${name} entry was not saved` };
  }
}
function workableFormatMonth(monthValue) {
  let t = monthValue.split(`-`);
  return `${t[1]}/${t[0]}`;
}
async function workableTrackApplication(record = true) {
  let e = document.querySelector(`h1[data-ui='job-title']`),
    t = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`[data-ui='company-url']`)
    ),
    n = /** @type {HTMLImageElement} */ (
      document.querySelector(`[data-ui='header-logo'] img`)
    ),
    r = ``,
    i = ``,
    a = ``;
  (e && e.textContent && (r = e.textContent),
    t && t.href && (i = t.href),
    (a = n && n.alt ? n.alt : document.title.split(` - `).pop()?.trim() || ``));
  let o = window.location.href,
    s = o.match(/(https:\/\/apply\.workable\.com\/[^/]+\/j\/[^/]+\/)/),
    c = s ? s[1] : ``;
  if (!i) {
    let e = o.match(/(https:\/\/apply\.workable\.com\/[^/]+)/);
    i = e ? e[1] : ``;
  }
  void jobsReportJobTitle(r);
  if (!record) return;
  jobsWaitForConfirmation("workable").then(
    async () =>
      await jobsSaveApplicationRecord({
        jobsSyncProof: "ats_confirmation",
        jobTitle: r,
        jobLink: c,
        companyLink: i,
        companyName: a,
      }),
  );
}
export {
  workableRunApplication,
  workableFillApplication,
  workableAddEntries,
  workableFormatMonth,
  workableTrackApplication,
};
