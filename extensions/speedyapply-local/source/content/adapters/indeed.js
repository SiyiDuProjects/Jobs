import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";
import { JobsFormPipeline } from "../../../src/custom/form-pipeline.js";
import { JobsAutomatic } from "../../../src/custom/automatic-fill.js";
import {
  jobsReportJobTitle,
  jobsSaveApplicationRecord,
} from "../shared/runtime-messages.js";
import { jobsLowercaseXPath } from "../shared/answer-helpers.js";
import {
  jobsFindXPath,
  jobsWaitForXPathNodes,
} from "../shared/dom-controls.js";
// Indeed SmartApply question pages run as one page pipeline: the rules (the
// EEO facts and the screening questions), AI for remaining required answers
// and review. The person continues; the review page's job is recorded once
// the post-apply page confirms it.
async function indeedRunApplication({
  setMessage: setMessage,
  getProfile: getProfile,
  autofillSettings: autofillSettings,
  ctx: context,
}) {
  const site = `${location.protocol}//${location.hostname.replace(`smartapply.`, ``)}`;
  let attempt;
  const page = async (url) => {
    if (url.pathname.includes(`post-apply`)) {
      if (attempt && autofillSettings.saveApplications)
        await jobsSaveApplicationRecord({
          ...attempt,
          jobsSyncProof: "ats_confirmation",
        });
      attempt = void 0;
      return;
    }
    if (url.pathname.includes(`/form/review`)) {
      attempt = indeedReadAttempt(site);
      return;
    }
    if (
      !url.pathname.includes(`/questions/`) &&
      !url.pathname.includes(`/demographic-questions/`)
    )
      return;
    const [item] = await jobsWaitForXPathNodes(
      `//div[contains(@class, 'ia-Questions-item')]`,
    );
    const profile = await getProfile(),
      root =
        item.closest(JobsPlatformConfig.structure.indeed.root) ||
        item.closest(JobsPlatformConfig.structure.indeed.main) ||
        void 0;
    await JobsFormPipeline.settled(root || document.body);
    await JobsAutomatic.advance({
      root,
      profile,
      setMessage,
      action: `fill`,
      fill: () =>
        url.pathname.includes(`/demographic-questions/`) &&
        JobsFormPipeline.bind([
          {
            name: "agree",
            find: `//label[contains(${jobsLowercaseXPath(`.`)}, 'agree')]//input`,
            topic: "consent",
          },
        ]),
    });
  };
  context.addEventListener(window, `jobs:locationchange`, ({ newUrl: url }) =>
    page(url),
  );
  page(new URL(location.href));
}
// The job named on the review page, recorded once the application is sent.
function indeedReadAttempt(site) {
  const header = document.querySelector(`.ia-JobHeader`);
  const title = header?.querySelector(`h1`)?.textContent?.trim(),
    company = header
      ?.querySelector(`span`)
      ?.textContent?.trim()
      ?.split(` - `)[0];
  void jobsReportJobTitle(title);
  const key = [...document.querySelectorAll(`script:not([src])`)]
    .map((script) => script.textContent?.match(/"jk"\s*:\s*"([^"]+)"/)?.[1])
    .find(Boolean);
  if (!key || !title || !company) return void 0;
  return {
    jobTitle: title,
    jobLink: `${site}/viewjob?jk=${key}`,
    companyName: company,
    companyLink: company.toLowerCase().includes(`confidential`)
      ? ``
      : `${site}/cmp/${company.replace(/\s+/g, `-`)}`,
  };
}

export { indeedRunApplication, indeedReadAttempt };
