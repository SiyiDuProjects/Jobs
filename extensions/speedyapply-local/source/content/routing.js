import { JobsPageSession } from "../../src/custom/control-content.js";
import { adpRunApplication } from "./adapters/adp.js";
import { ashbyRunApplication } from "./adapters/ashby.js";
import { bamboohrRunApplication } from "./adapters/bamboohr.js";
import { breezyRunApplication } from "./adapters/breezy.js";
import { comeetRunApplication } from "./adapters/comeet.js";
import { dayforceRunApplication } from "./adapters/dayforce.js";
import { doverRunApplication } from "./adapters/dover.js";
import { eightfoldRunApplication } from "./adapters/eightfold.js";
import { freshteamRunApplication } from "./adapters/freshteam.js";
import { greenhouseRunApplication } from "./adapters/greenhouse.js";
import { gustoRunApplication } from "./adapters/gusto.js";
import { icimsRunApplication } from "./adapters/icims.js";
import { indeedRunApplication } from "./adapters/indeed.js";
import { jazzhrRunApplication } from "./adapters/jazzhr.js";
import { jobviteRunApplication } from "./adapters/jobvite.js";
import { leverRunApplication } from "./adapters/lever.js";
import { oracleRunApplication } from "./adapters/oracle.js";
import { paylocityRunApplication } from "./adapters/paylocity.js";
import { phenomRunApplication } from "./adapters/phenom.js";
import { pinpointRunApplication } from "./adapters/pinpoint.js";
import { polymerRunApplication } from "./adapters/polymer.js";
import { ripplingRunApplication } from "./adapters/rippling.js";
import { seekRunApplication } from "./adapters/seek.js";
import { smartrecruitersRunApplication } from "./adapters/smartrecruiters.js";
import { successfactorsRunApplication } from "./adapters/successfactors.js";
import { teslaRunApplication } from "./adapters/tesla.js";
import { tiktokRunApplication } from "./adapters/tiktok.js";
import { ultiproRunApplication } from "./adapters/ultipro.js";
import { workableRunApplication } from "./adapters/workable.js";
import { workdayRunApplication } from "./adapters/workday.js";
function jobsRunAdapter(script, options) {
  // Stable protocol IDs are independent of readable JavaScript function names.
  const jobsAdapterId =
    {
      adpRunApplication: "adp",
      ashbyRunApplication: "ashby",
      bamboohrRunApplication: "bamboohr",
      breezyRunApplication: "breezy",
      comeetRunApplication: "comeet",
      dayforceRunApplication: "dayforce",
      doverRunApplication: "dover",
      eightfoldRunApplication: "eightfold",
      freshteamRunApplication: "freshteam",
      gustoRunApplication: "gusto",
      icimsRunApplication: "icims",
      jazzhrRunApplication: "jazzhr",
      jobviteRunApplication: "jobvite",
      leverRunApplication: "lever",
      paylocityRunApplication: "paylocity",
      phenomRunApplication: "phenom",
      pinpointRunApplication: "pinpoint",
      polymerRunApplication: "polymer",
      ripplingRunApplication: "rippling",
      seekRunApplication: "seek",
      smartrecruitersRunApplication: "smartrecruiters",
      successfactorsRunApplication: "successfactors",
      teslaRunApplication: "tesla",
      tiktokRunApplication: "tiktok",
      ultiproRunApplication: "ultipro",
      workableRunApplication: "workable",
      workdayRunApplication: "workday",
      greenhouseRunApplication: "greenhouse",
      indeedRunApplication: "indeed",
      oracleRunApplication: "oracle",
    }[script.name] || script.name;
  return JobsPageSession.run(script, { ...options, jobsAdapterId });
}
var jobsAdapterRoutes = [
  {
    script: workdayRunApplication,
    pattern: RegExp(`^https?://.*\\.(myworkdayjobs|myworkdaysite)\\.com/`),
  },
  {
    script: greenhouseRunApplication,
    pattern: RegExp(
      `^https?://(job-boards|boards)\\.(eu\\.)?greenhouse\\.io/.*`,
    ),
  },
  {
    script: leverRunApplication,
    pattern: RegExp(`^https?://jobs(?:\\.[a-z]+)?\\.lever\\.co/[^/]+/[^/]+/.*`),
  },
  {
    script: successfactorsRunApplication,
    pattern: RegExp(
      `^https?://(?:.*\\.)?(?:successfactors|sapsf)\\.(?:com|eu)/.*`,
    ),
  },
  {
    script: icimsRunApplication,
    pattern: RegExp(`^https?://.*.icims.(com|eu)/.*`),
  },
  {
    script: workableRunApplication,
    pattern: RegExp(`^https://apply\\.workable\\.com/`),
  },
  {
    script: ripplingRunApplication,
    pattern: RegExp(
      `^https?://(?:ats\\.rippling\\.com/[^/]+/jobs(?:/.*|\\?.*|$)|[^/]*\\.rippling-ats\\.com/job/[^/]+(?:/.*)?)`,
    ),
  },
  {
    script: breezyRunApplication,
    pattern: RegExp(`^https://[^/]*\\.breezy\\.hr/p/[a-z0-9-]+`),
  },
  {
    script: jazzhrRunApplication,
    pattern: RegExp(
      `^https?://[^/]+\\.(applytojob|theresumator)\\.com/apply/[^/]+(/[^/]+)?`,
    ),
  },
  {
    script: ashbyRunApplication,
    pattern: RegExp(`^https://jobs.ashbyhq.com/.*`),
  },
  {
    script: smartrecruitersRunApplication,
    pattern: RegExp(
      `^https://jobs\\.smartrecruiters\\.com/oneclick-ui/company/[^/]+/(publication|job)/.*`,
    ),
  },
  {
    script: paylocityRunApplication,
    pattern: RegExp(
      `^https://recruiting\\.paylocity\\.com/Recruiting/Jobs/.*`,
      `i`,
    ),
  },
  {
    script: freshteamRunApplication,
    pattern: RegExp(`^https://[^/]+\\.freshteam\\.com/jobs/[^/]+/[^/]+`),
  },
  {
    script: doverRunApplication,
    pattern: RegExp(`^https://app\\.dover\\.(io|com)/apply/.+`),
  },
  {
    script: pinpointRunApplication,
    pattern: RegExp(`^https://[^/]+\\.pinpointhq\\.com/.*`),
  },
  {
    script: comeetRunApplication,
    pattern: RegExp(`^https://www\\.comeet\\.co/jobs/.*/apply.*`),
  },
  {
    script: gustoRunApplication,
    pattern: RegExp(
      `^https://jobs\\.gusto\\.com/postings/[^/]+/applicants(/new)?$`,
    ),
  },
  {
    script: polymerRunApplication,
    pattern: RegExp(`^https://jobs\\.polymer\\.co/[^/]+/\\d+(#apply)?$`),
  },
  {
    script: adpRunApplication,
    pattern: RegExp(
      `^https://workforcenow\\.adp\\.com/mascsr/.*(\\?.*jobId=\\d+)?`,
    ),
  },
  {
    script: jobviteRunApplication,
    pattern: RegExp(
      `^https://jobs\\.jobvite\\.com/[^/]+(?:/[^/]+)?/job/[^/]+/(apply|applyConfirmation)(\\?.*)?$`,
    ),
  },
  {
    script: ultiproRunApplication,
    pattern: RegExp(`^https://[^/]+\\.ultipro\\.(com|ca)(/.*)?$`),
  },
  {
    script: teslaRunApplication,
    pattern: RegExp(
      `^https://www\\.tesla\\.com/careers/search/job/apply/\\d+$`,
    ),
  },
  {
    script: tiktokRunApplication,
    pattern: RegExp(
      `^https://(careers\\.tiktok\\.com|lifeattiktok\\.com)(/.*)?$`,
    ),
  },
  {
    script: eightfoldRunApplication,
    pattern: RegExp(
      `^https://[a-zA-Z0-9-]+\\.eightfold\\.ai/careers(\\?.*)?(#.*)?$`,
    ),
    selector: `#EFSmartApplyContainer`,
  },
  {
    script: seekRunApplication,
    pattern: RegExp(`^https?://(?:www\\.)?seek\\.com\\.au/job/\\d+(?:/apply)?`),
  },
  {
    script: bamboohrRunApplication,
    pattern: RegExp(`^https?://[^/]*\\.bamboohr\\.com/careers(/.*)?$`),
  },
  { script: phenomRunApplication, selector: `head[data-ph-id]` },
  {
    script: dayforceRunApplication,
    pattern: RegExp(`^https?://[^/]*\\.dayforcehcm\\.com(/.*)?$`),
  },
  {
    script: indeedRunApplication,
    pattern: RegExp(`^https://(?:[a-z]{2}\\.)?smartapply\\.indeed\\.com/.*`),
  },
  {
    script: oracleRunApplication,
    pattern: RegExp(
      `^https://[^/]+\\.oraclecloud\\.com/hcmUI/CandidateExperience/[^/]+/sites/[^/]+/job/[^/]+/apply(?:/|$)`,
      "i",
    ),
  },
];

export { jobsRunAdapter, jobsAdapterRoutes };
