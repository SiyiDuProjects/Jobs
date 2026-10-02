import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsMountManualAnswerControls } from "../shared/answer-ui.js";
import {
  jobsWaitForConfirmation,
  jobsClick,
  jobsFindXPath,
  jobsUploadResume,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
import {
  jobsFormatProfileMonth,
  jobsIsProfileMonthInPast,
  jobsProfileWebsiteEntries,
} from "../shared/profile-format.js";
// The Freshteam form runs as one page pipeline: the resume first (its
// parser prefills the form), declared Profile facts and history, then the
// rules, AI for remaining required answers and review.
async function freshteamRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  jobsWaitForXPathNodes(JobsPlatformConfig.structure.freshteam.rootXPath).then(
    async ([form]) => {
      const profile = await getProfile();
      if (profile.resumeData?.resumeBase64) {
        jobsUploadResume(profile.resumeData, `input#uploadFile`);
        await JobsDOMWait.until(
          () =>
            document
              .querySelector(`label#uploadValue`)
              ?.textContent.includes(profile.resumeData.fileName),
          { timeout: 30000 },
        );
      }
      await jobsMountManualAnswerControls(context, [
        [
          `//div[contains(@class, 'form-group')]//textarea`,
          `preceding-sibling::label`,
        ],
      ]);
      await freshteamTrackApplication(
        setMessage,
        Boolean(autofillSettings.saveApplications),
      );
      await JobsAutomatic.advance({
        root:
          form.querySelector(JobsPlatformConfig.structure.freshteam.form) ||
          form,
        profile,
        setMessage,
        action: `fill`,
        fill: (current) => freshteamFillApplication(profile, current),
      });
    },
  );
}
async function freshteamFillApplication(profile, canProceed = () => true) {
  const section = (name, run) =>
    JobsFormPipeline.section(name, run, { canProceed });
  await section(`contact`, () =>
    JobsFormPipeline.bind([
      {
        name: "first-name",
        find: `#applicant_lead_attributes\\[first_name\\]`,
        answer: profile.nameData.firstName,
      },
      {
        name: "last-name",
        find: `#applicant_lead_attributes\\[last_name\\]`,
        answer: profile.nameData.lastName,
      },
      {
        name: "email",
        find: `#applicant_lead_attributes\\[email\\]`,
        answer: profile.contactData.email,
      },
      {
        name: "mobile",
        find: `#applicant_lead_attributes\\[mobile\\]`,
        answer: profile.contactData.phoneNumber,
      },
      {
        name: "phone",
        find: `#applicant_lead_attributes\\[phone\\]`,
        answer: profile.contactData.phoneNumber,
      },
    ]),
  );
  await section(`websites`, () =>
    freshteamFillWebsites(profile.websiteData, canProceed),
  );
  await section(`employment`, () =>
    freshteamAddEntries(
      `Add Employer`,
      `employer-group`,
      profile.jobData,
      (entry, group) => {
        const field = (tag, name) =>
          `${group}//${tag}[@name='applicant[lead_attributes][positions_attributes][][${name}]']`;
        return [
          {
            name: "title",
            find: field(`input`, `title`),
            answer: entry.jobTitle,
          },
          {
            name: "company",
            find: field(`input`, `company`),
            answer: entry.company,
          },
          {
            name: "summary",
            find: field(`textarea`, `summary`),
            answer: entry.description?.substring(0, 255),
          },
          {
            name: "start-date",
            find: field(`input`, `start_date`),
            answer:
              entry.startDate &&
              jobsFormatProfileMonth(entry.startDate, `MMMM dd, yyyy`),
          },
          {
            name: "end-date",
            find: field(`input`, `end_date`),
            answer:
              entry.endDate &&
              jobsFormatProfileMonth(entry.endDate, `MMMM dd, yyyy`),
          },
          {
            name: "current",
            find: field(`input`, `is_current`),
            checked: entry.currentlyWorkHere === true ? true : undefined,
          },
        ];
      },
      canProceed,
    ),
  );
  await section(`education`, () =>
    freshteamAddEntries(
      `Add Education`,
      `education-group`,
      profile.educationData,
      (entry, group) => {
        const field = (name) =>
          `${group}//input[@name='applicant[lead_attributes][qualifications_attributes][][${name}]']`;
        return [
          { name: "degree", find: field(`degree`), answer: entry.degree },
          {
            name: "field-of-study",
            find: field(`field_of_study`),
            answer: entry.fieldOfStudy,
          },
          { name: "school", find: field(`school_name`), answer: entry.school },
          {
            name: "start-date",
            find: field(`start_date`),
            answer:
              entry.startDate &&
              jobsFormatProfileMonth(entry.startDate, `MMMM dd, yyyy`),
          },
          {
            name: "end-date",
            find: field(`end_date`),
            answer:
              entry.endDate &&
              jobsFormatProfileMonth(entry.endDate, `MMMM dd, yyyy`),
          },
          {
            name: "current",
            find: field(`is_current`),
            checked:
              entry.endDate && !jobsIsProfileMonthInPast(entry.endDate)
                ? true
                : undefined,
          },
          { name: "grade", find: field(`grade`), answer: entry.gpa },
        ];
      },
      canProceed,
    ),
  );
}
// Structure: one link row per website; the first exists, the others are added.
async function freshteamFillWebsites(websites, canProceed = () => true) {
  if (document.querySelector(`.link-group`) === null) return;
  const links = jobsProfileWebsiteEntries(websites),
    input = (index) =>
      `(//input[@name='applicant[lead_attributes][profile_links][][url]'])[${index + 1}]`;
  for (
    let index = 0;
    index < links.length && JobsPageActions.live(canProceed);
    index++
  ) {
    if (!jobsFindXPath(input(index))) {
      jobsClick(`.link-group button.add`);
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(input(index)), {
          timeout: 5000,
        }))
      )
        break;
    }
    await JobsFormPipeline.bind([
      {
        name: `website-${index}`,
        find: input(index),
        answer: links[index].url,
      },
    ]);
  }
}
// Structure: one history group per Profile entry, added with the page's button.
async function freshteamAddEntries(
  button,
  group,
  entries,
  bindings,
  canProceed = () => true,
) {
  const add = `//button[contains(text(), '${button}')]`;
  if (jobsFindXPath(add) === null) return;
  for (
    let index = 0;
    index < entries.length && JobsPageActions.live(canProceed);
    index++
  ) {
    const node = `(//div[contains(@class,'${group}')])[${index + 1}]`;
    if (!jobsFindXPath(node)) {
      jobsClick(add, !0);
      if (
        !(await JobsDOMWait.until(() => jobsFindXPath(node), { timeout: 5000 }))
      )
        break;
    }
    await JobsFormPipeline.bind(bindings(entries[index], node));
  }
}
async function freshteamTrackApplication(setMessage, record = true) {
  let t = document.querySelector(`h1.brand-color`),
    n = ``;
  t && t.textContent && (n = t.textContent);
  let r = window.location.href,
    i = r.match(/(https:\/\/[^.]+\.freshteam\.com\/jobs)/),
    a = i ? i[1] : ``;
  void jobsReportJobTitle(n);
  if (!record) return;
  jobsWaitForConfirmation("freshteam").then(() => {
    (jobsSaveApplicationRecord({
      jobsSyncProof: "ats_confirmation",
      jobTitle: n,
      jobLink: r,
      companyLink: a,
    }),
      setMessage(null));
  });
}
export {
  freshteamRunApplication,
  freshteamFillApplication,
  freshteamFillWebsites,
  freshteamAddEntries,
  freshteamTrackApplication,
};
