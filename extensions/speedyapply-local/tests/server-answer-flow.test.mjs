import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adapterPage, profile } from "./helpers/adapter-run.mjs";
import { bindAnswerEvidence } from "../src/custom/answer-proof.js";
const service = fileURLToPath(
  new URL("../../../services/jobs-radar/", import.meta.url),
);
const python =
  process.env.JOBS_TEST_PYTHON ||
  service +
    (process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python");
// Only the provider HTTP boundary is synthetic. Actual server engines, Profile
// projection, result conversion, worker binding, scanner and page writer run.
const program = `
import asyncio,json,sys,tempfile,httpx
from pathlib import Path
from jobs_radar.store import Store
from jobs_radar.profiles import Profiles
from jobs_radar.answers import Answers
payload=json.load(sys.stdin)
class Client:
 async def post(self,url,json):
  field=payload['fields'][0]
  if payload['flow']=='simple':
   body={'answers':[dict(fieldId=field['fieldId'],kind='answer',value='yes',questionZh='是否有美国工作许可',answerZh='是',reasonZh='资料明确记录有工作许可',jobSpecific=False,signingDate=False)]}
  else:
   body={'mappings':[dict(fieldId=field['fieldId'],binding=dict(predicate='us_work_eligible',options=['true','false'],argument='',polarity=True))],'answers':[]}
  return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps(body)}]}]})
with tempfile.TemporaryDirectory() as temp:
 store=Store(Path(temp)/'test.sqlite')
 p=dict(profileName='Synthetic',nameData={},contactData={},addressData={},jobData=[],educationData=[],languageData=[],resumeData={},websiteData={},skillsData=[],employmentData={'eligibilityUS':True})
 record=Profiles(store).save(p)
 reply=asyncio.run(Answers(store,flow=payload['flow']).generate(dict(profileId=record['id'],profileVersion=record['last_sync'],fields=payload['fields'],answerProtocol=3,jobCountry='US'),Client()))
 print(__import__('json').dumps(dict(reply=reply,bound={'id':record['id'],'lastSync':record['last_sync']})))
`;
for (const flow of ["simple", "legacy"])
  test(`actual Python ${flow} reply fills through the extension and continues`, async (t) => {
    const h = await adapterPage(t, {
      html: '<form><label>Are you authorized to work in the United States?<select required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label><button id="next" type="button">Next</button></form>',
    });
    const original = h.w.chrome.runtime.sendMessage;
    let calls = 0,
      continued = 0;
    h.doc.querySelector("#next").onclick = () => continued++;
    h.w.chrome.runtime.sendMessage = async (message) => {
      if (message.type !== "jobs:auto-answers") return original(message);
      calls++;
      const response = spawnSync(python, ["-c", program], {
        cwd: service,
        input: JSON.stringify({ fields: message.fields, flow }),
        encoding: "utf8",
      });
      assert.equal(response.status, 0, response.stderr);
      const { reply, bound } = JSON.parse(response.stdout);
      return {
        data: {
          ...reply,
          answers: reply.answers.map((row) =>
            bindAnswerEvidence(
              row,
              message.fields.find((field) => field.fieldId === row.fieldId),
              bound,
            ),
          ),
        },
      };
    };
    await h.w.JobsAutomatic.advance({
      root: h.doc.querySelector("form"),
      profile,
      // Force a local miss to exercise both actual service engines and the
      // provider-to-writer boundary; known-question routing has offline tests.
      resolveAnswers: async () => [],
      action: "next",
      selector: "#next",
      autoConfirm: true,
    });
    assert.equal(calls, 1);
    assert.equal(h.doc.querySelector("select").value, "yes");
    assert.equal(continued, 1);
  });
