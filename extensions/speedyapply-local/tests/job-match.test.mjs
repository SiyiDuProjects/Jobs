import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readModule } from "./helpers/module-source.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const service = path.resolve(root, "../../services/jobs-radar");
const rules = JSON.parse(
  fs.readFileSync(
    path.join(service, "jobs_radar/job_match_rules.json"),
    "utf8",
  ),
);
const context = vm.createContext({ URL, JobsMatchRules: rules });
vm.runInContext(
  await readModule(path.join(root, "src/custom/job-match.js"), "utf8"),
  context,
);
const urls = [
  "https://hpe.wd5.myworkdayjobs.com/en-US/jobs/job/San-Jose/AI_1211885",
  "https://hpe.wd5.myworkdayjobs.com/en-US/jobs/job/San-Jose%2C-California/AI_1211885",
  "https://other.wd5.myworkdayjobs.com/en-US/jobs/job/San-Jose/AI_1211885",
  "https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x",
  "https://boards.greenhouse.io/embed/job_app?for=acme&token=123",
  "https://job-boards.greenhouse.io/other/jobs/123",
  "https://jobs.ashbyhq.com/acme/abc/application",
  "https://jobs.ashbyhq.com/acme/abc",
  "https://jobs.ashbyhq.com/other/abc",
  "https://workforcenow.adp.com/jobs?cid=acme&jobId=42",
  "https://workforcenow.adp.com/jobs?cid=other&jobId=42",
  "https://acme.eightfold.ai/careers?pid=42",
  "https://www.linkedin.com/jobs/view/42/",
  "https://www.linkedin.com/jobs/search?currentJobId=42",
  "https://acme.icims.com/jobs/42/engineer/job",
  "https://acme.icims.com/jobs/42/engineer/job?mode=apply",
  "https://careers.example.com/job?id=1",
  "https://careers.example.com/job?id=2",
  "https://visa.wd5.myworkdayjobs.com/Visa/job/US---Foster-City/Software-Engineer_REF088587W",
  "https://visa.wd5.myworkdayjobs.com/en-US/visa_early_careers/job/US---Foster-City%2C-CA/Renamed-Engineer_REF088587W/apply/applyManually",
  "https://visa.wd5.myworkdayjobs.com/Visa/job/US---Foster-City/Software-Engineer_REF088587W-1",
  "https://axiomspace.wd5.myworkdayjobs.com/en-US/External_Career_Site/job/Software-Engineering-Intern_JR100691/apply/applyManually",
  "https://axiomspace.wd5.myworkdayjobs.com/en-US/External_Career_Site/job/Software-Engineering-Intern_JR100691",
  "https://apply.careers.microsoft.com/careers/job/1970393556998613",
  "https://apply.careers.microsoft.com/careers/apply?pid=1970393556998613",
  "https://apply.careers.microsoft.com/careers/apply?pid=1970393556998614",
  "https://careers.withwaymo.com/jobs?gh_jid=8203191",
  "https://careers.withwaymo.com/jobs/2027-summer-intern-phd-learning-based-behavior?gh_jid=8203191",
  "https://careers.withwaymo.com/jobs/2027-summer-intern-phd-learning-based-behavior?gh_jid=8203192",
  "https://acme.icims.com/jobs/42/renamed/login",
  "https://hpe.wd5.myworkdayjobs.com/en-US/jobs",
  "https://careers.amd.com/jobs/90950?icims=1",
  "https://careers.amd.com/careers-home/jobs/90950",
  "not a url",
  // 34+: shared normalization and the rules added for pages outside the old set.
  "https://www.careers.example.com/job/?id=77&utm_source=Simplify&ref=Simplify",
  "https://careers.example.com/job?id=77",
  "https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=341975",
  "https://textron.taleo.net/careersection/application.jss?lang=en&job=341975",
  "https://acme.wd5.myworkdaysite.com/recruiting/acme/External/job/Seattle/Engineer_R-123456",
  "https://acme.wd5.myworkdaysite.com/en-US/recruiting/acme/External/job/Seattle/Engineer_R-123456/apply/applyManually",
  "https://egay.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_4001/job/39682",
  "https://egay.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_4001/job/39682/apply/section/1",
  "https://app.careerpuck.com/job-board/lyft/job/8772571002?gh_jid=8772571002",
  "https://app.careerpuck.com/apply?gh_jid=8772571002",
  "https://careers.example.com/search?q=software engineer&page=2#results",
  "https://careers.example.com/jobs/1234567?icims=1",
  "https://qualcomm.eightfold.ai/careers/job/446721063770?utm_source=Simplify",
  "https://qualcomm.eightfold.ai/careers?pid=446721063770",
  "https://other.eightfold.ai/careers/job/446721063770",
  "https://boards.greenhouse.io/embed/job_app?token=7669159003&utm_source=Simplify&ref=Simplify",
  "https://job-boards.greenhouse.io/embed/job_app?token=7669159003",
  "https://job-boards.greenhouse.io/embed/job_app?token=7586263002",
  "https://job-boards.greenhouse.io/acme/jobs/7669159003",
  "https://jobs.smartrecruiters.com/SmithsGroup2/a22945f0-59b6-4c3f-87f1-43c05b535677",
  "https://jobs.smartrecruiters.com/SmithsGroup2/a22945f0-59b6-4c3f-87f1-43c05b535677/apply",
  "https://jobs.smartrecruiters.com/Other/a22945f0-59b6-4c3f-87f1-43c05b535677",
  "https://jobs.ashbyhq.com/Example/00cd591f-6894-4259-83b6-36c999351dde/application",
  "https://jobs.ashbyhq.com/example/00cd591f-6894-4259-83b6-36c999351dde",
  "https://jobs.ashbyhq.com/other/00cd591f-6894-4259-83b6-36c999351dde",
  "https://careers.example.com/job/CaseSensitive",
  "https://careers.example.com/job/casesensitive",
  "https://jobs.smartrecruiters.com/oneclick-ui/company/SmithsGroup2/publication/a22945f0-59b6-4c3f-87f1-43c05b535677?dcr_ci=SmithsGroup2",
  "https://jobs.smartrecruiters.com/oneclick-ui/company/Other/publication/a22945f0-59b6-4c3f-87f1-43c05b535677",
  "https://jobs.smartrecruiters.com/oneclick-ui/company/SmithsGroup2/job/123456789",
  "https://jobs.smartrecruiters.com/SmithsGroup2/123456789-engineer",
];
test("server and extension consume the same rules and produce identical keys", () => {
  const python =
    process.platform === "win32"
      ? path.join(service, ".venv/Scripts/python.exe")
      : path.join(service, ".venv/bin/python");
  const result = spawnSync(
    python,
    [
      "-c",
      "import json,sys;from jobs_radar.job_match import job_key;print(json.dumps([job_key(u) for u in json.load(sys.stdin)]))",
    ],
    {
      cwd: service,
      input: JSON.stringify(urls),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    urls.map((u) => context.JobsJobMatch.key(u)),
    JSON.parse(result.stdout),
  );
  for (const [a, b] of [
    [0, 1],
    [3, 4],
    [6, 7],
    [12, 13],
    [14, 15],
    [18, 19],
    [21, 22],
    [23, 24],
    [26, 27],
    [14, 29],
    [31, 32],
    [34, 35],
    [36, 37],
    [38, 39],
    [40, 41],
    [42, 43],
    [46, 47],
    [49, 50],
  ])
    assert.equal(context.JobsJobMatch.same(urls[a], urls[b]), true, urls[a]);
  for (const [a, b] of [
    [0, 2],
    [3, 5],
    [6, 8],
    [9, 10],
    [16, 17],
    [18, 20],
    [23, 25],
    [26, 28],
    [46, 48],
    [49, 51],
    [49, 52],
  ])
    assert.equal(context.JobsJobMatch.same(urls[a], urls[b]), false, urls[a]);
  assert.equal(context.JobsJobMatch.key(urls[30]), null);
  assert.equal(context.JobsJobMatch.same(urls[53], urls[54]), true);
  assert.equal(context.JobsJobMatch.same(urls[53], urls[55]), false);
  assert.equal(context.JobsJobMatch.same(urls[56], urls[57]), true);
  assert.equal(context.JobsJobMatch.same(urls[56], urls[58]), false);
  assert.equal(context.JobsJobMatch.same(urls[59], urls[60]), false);
  assert.equal(context.JobsJobMatch.same("bad", "bad"), false);
  assert.equal(context.JobsJobMatch.same(urls[61], urls[53]), true);
  assert.equal(context.JobsJobMatch.same(urls[61], urls[62]), false);
  assert.equal(context.JobsJobMatch.same(urls[63], urls[64]), true);
  assert.equal(context.JobsJobMatch.same(urls[61], urls[63]), false);
});

test("the module bundled into the extension has the current server rules", async () => {
  const runtime = vm.createContext({});
  vm.runInContext(
    await readModule(path.join(root, "src/custom/job-match-rules.js"), "utf8"),
    runtime,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.JobsMatchRules)), rules);
});
