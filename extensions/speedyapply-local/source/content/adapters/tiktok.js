import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import {
  jobsClick,
  jobsFillAccount,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForXPathNodes,
  jobsWatchCssPresence,
} from "../shared/dom-controls.js";
import {
  jobsFormatFullName,
  jobsFormatToday,
  jobsProfileWebsiteEntries,
} from "../shared/profile-format.js";
// The TikTok resume form runs as one page pipeline: declared Profile facts,
// history, languages and websites, then the rules (work authorization,
// sponsorship and the other questions), AI for remaining required answers,
// review and navigation. Sign-in and sign-up take the saved account.
async function tiktokRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  accountSettings: accountSettings,
  ctx: context,
}) {
  if (accountSettings.accountPassword)
    for (const form of [`.emailLogin-formWrap form`, `.signUp-formWrap form`])
      jobsWatchCssPresence(
        form,
        () => tiktokFillAccount(accountSettings),
        void 0,
        () => setMessage(null),
      );
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.tiktok.rootXPath).then(
    async ([form]) => {
      const profile = await getProfile();
      tiktokTrackApplication(
        { ctx: context, setMessage: setMessage },
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root: form,
        profile,
        setMessage,
        action: autofillSettings.autoSubmit ? `submit` : `fill`,
        selector: JobsPlatformConfig.structure.tiktok.submit,
        fill: (current) => tiktokFillApplication(profile, current),
      });
    },
  );
}
async function tiktokFillAccount(accountSettings) {
  await jobsFillAccount([
    { find: `input#email`, value: accountSettings.accountEmail },
    { find: `input#password`, value: accountSettings.accountPassword },
    { find: `input.atsx-checkbox-input`, topic: "consent" },
  ]);
}
async function tiktokFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`resume`, async () => {
    if (!profile.resumeData?.resumeBase64) return;
    jobsUploadResume(profile.resumeData, `[data-test='uploadResume'] input`);
    await JobsDOMWait.until(
      () => jobsFindXPath(`//p[contains(@class, 'loadedFilename')]`),
      { timeout: 30000 },
    );
  });
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "name",
        find: `#name`,
        answer: jobsFormatFullName(profile.nameData),
      },
      {
        name: "phone",
        find: `//input[contains(@class, 'phone-input')]`,
        answer: profile.contactData.phoneNumber,
      },
      { name: "email", find: `#email`, answer: profile.contactData.email },
    ]),
  );
  // Entries the resume parser added are replaced by the Profile's own.
  for (const button of document.querySelectorAll(`.formOperate-remove`))
    if (!JobsPageActions.click(button)) return;
  const month = (item, index) =>
    `${item}//div[contains(@class, 'atsx-date-picker')]//div[contains(@class,'atsx-date-picker-period-month-label')][${index}]`;
  const today = jobsFormatToday(`yyyy-MM`),
    answers = JobsProfileAnswers;
  await section(`employment`, () =>
    tiktokAddEntries(
      `Work Experience`,
      profile.jobData,
      (entry, item) => [
        {
          name: "company",
          find: `${item}//input[contains(@id, 'company')]`,
          answer: entry.company,
        },
        {
          name: "title",
          find: `${item}//input[contains(@id, 'title')]`,
          answer: entry.jobTitle,
        },
        { name: "start", find: month(item, 1), answer: entry.startDate },
        { name: "end", find: month(item, 2), answer: entry.endDate ?? today },
        {
          name: "description",
          find: `${item}//textarea[contains(@id, 'desc')]`,
          answer: entry.description,
        },
      ],
      canProceed,
    ),
  );
  await section(`education`, () =>
    tiktokAddEntries(
      `Education`,
      profile.educationData,
      (entry, item) => [
        {
          name: "school",
          find: `${item}//input[contains(@id, 'school')]`,
          answer: entry.school,
        },
        {
          name: "degree",
          find: `${item}//div[contains(@id, 'degree')]`,
          answer: answers.degreeSpec(entry.degree),
        },
        {
          name: "field-of-study",
          find: `${item}//input[contains(@id, 'fieldOfStudy')]`,
          answer: entry.fieldOfStudy,
        },
        {
          name: "start",
          find: month(item, 1),
          answer: entry.startDate ?? today,
        },
        { name: "end", find: month(item, 2), answer: entry.endDate ?? today },
      ],
      canProceed,
    ),
  );
  await section(`languages`, () =>
    tiktokAddEntries(
      `Language`,
      profile.languageData,
      (entry, item) => [
        {
          name: "language",
          find: `${item}//div[contains(@id, 'language')]`,
          answer: answers.literalSpec("known-answer", entry.language),
        },
        {
          name: "proficiency",
          find: `${item}//div[contains(@id, 'proficiency')]`,
          answer: answers.languageSpec(entry.proficiency, entry),
        },
      ],
      canProceed,
    ),
  );
  const websites = profile.websiteData,
    links = jobsProfileWebsiteEntries(websites).map((entry) => entry.url);
  const kind = (url) =>
    websites.linkedin && url === websites.linkedin
      ? `LinkedIn`
      : websites.github && url === websites.github
        ? `GitHub`
        : websites.twitter && url === websites.twitter
          ? `Twitter`
          : `Personal website`;
  await section(`websites`, () =>
    tiktokAddEntries(
      `SNS`,
      links,
      (url, item) => [
        {
          name: "type",
          find: `${item}//div[contains(@id, 'snsType')]`,
          answer: answers.literalSpec("known-answer", kind(url)),
        },
        {
          name: "link",
          find: `${item}//input[contains(@id, 'link')]`,
          answer: url,
        },
      ],
      canProceed,
    ),
  );
  await section(`disclosures`, () => tiktokFillDisclosures(profile));
  await JobsFormPipeline.bind([
    {
      name: "privacy",
      find: `//label[contains(@class, 'resumeEdit-privacyArea')]//input`,
      topic: "consent",
    },
  ]);
}
// Structure: one item per Profile entry in a titled section, added with its plus button.
async function tiktokAddEntries(
  title,
  entries,
  bindings,
  canProceed = () => true,
) {
  const section = `//p[contains(@class, 'createFormSection-text') and contains(text(), '${title}')]/../../following-sibling::div`;
  if (!jobsFindXPath(section)) return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const item = `${section}//div[contains(@class, 'resumeEditForm-item')][${index + 1}]`;
    if (!jobsFindXPath(item)) {
      jobsClick(`${section}//i[contains(@class, 'addMore-plus')]`, !0);
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(item), { timeout: 5000 }))
      )
        break;
    }
    await JobsFormPipeline.bind(bindings(entries[index], item));
  }
}
// One EEO rule for every ATS; this form's own options decide the wording.
async function tiktokFillDisclosures(profile) {
  const select = (field) =>
    `//div[contains(@data-form-field-i18n-name, '${field}')]//div[contains(@class, 'ud__select__selector')]`;
  const eeo = JobsProfileAnswers.eeoSpec,
    employment = profile.employmentData;
  await JobsFormPipeline.bind([
    {
      name: "gender",
      find: select(`gender`),
      answer: eeo(`gender`, employment),
    },
    {
      name: "disability",
      find: select(`disability`),
      answer: eeo(`disability`, employment),
    },
    {
      name: "ethnicity",
      find: select(`ethnicity`),
      answer: eeo(`ethnicity`, employment),
    },
    {
      name: "recruiting-source",
      find: select(`hear`),
      answer: JobsProfileAnswers.recruitingSourceSpec(profile),
    },
  ]);
}
function tiktokTrackApplication(
  { ctx: context, setMessage: setMessage },
  record = true,
) {
  let n = jobsFindXPath(`//div[contains(@class, 'resumeEditForm-headerText')]`),
    r = ``;
  n && n.textContent && (r = n.textContent);
  let i = window.location.href.match(
      /^(https:\/\/(careers\.tiktok\.com|lifeattiktok\.com)\/resume\/)(\d+)\/apply$/,
    ),
    a = i ? i[1].split(`/resume/`)[0] : ``,
    o = i ? i[3] : ``,
    s = o ? `${a}/position/${o}/detail` : ``;
  void jobsReportJobTitle(r);
  if (!record) return;
  let receiptSave,
    receiptRecorded = false;
  context.addEventListener(window, `jobs:locationchange`, ({ newUrl: e }) => {
    if (e.href !== `${a}/resume/applied` || receiptRecorded) return;
    if (!receiptSave)
      receiptSave = jobsSaveApplicationRecord({
        jobsSyncProof: "ats_confirmation",
        jobTitle: r,
        jobLink: s,
        companyLink: `${a}/`,
      })
        .then((reply) => {
          if (reply?.ok !== true) throw Error("Receipt was not acknowledged");
          receiptRecorded = true;
          setMessage(null);
        })
        .catch(() => setMessage("complete-manually"))
        .finally(() => {
          receiptSave = undefined;
        });
    return receiptSave;
  });
}

export {
  tiktokRunApplication,
  tiktokFillAccount,
  tiktokFillApplication,
  tiktokAddEntries,
  tiktokFillDisclosures,
  tiktokTrackApplication,
};
