// Capture requests from the actual extension transport and website store.
// Python sends these envelopes through the real HTTP routes in an isolated DB.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from '../../../extensions/speedyapply-local/node_modules/esbuild/lib/main.js';
import {readModule} from '../../../extensions/speedyapply-local/tests/helpers/module-source.mjs';

let incoming='';
for await (const chunk of process.stdin)incoming+=chunk;
const input=JSON.parse(incoming);
const custom=new URL('../../../extensions/speedyapply-local/src/custom/',import.meta.url);
const requests=[];
let scenario='',docs={};
const fetch=async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):undefined;
  const path=new URL(url,'https://jobs.siyidu.com').pathname;
  if(body)requests.push({scenario,path,method:options.method,headers:options.headers,body});
  let value={};
  if(path.endsWith('/events'))value={event_id:body.event_id,state:'submitted',retryable:false};
  if(path.endsWith('/answer/jobs'))value={state:'completed',result:{text:'Fixture answer'}};
  if(path.endsWith('/state')){
    for(const change of body?.changes||[])docs[change.key]={value:change.value,revision:change.revision+1};
    value=docs;
  }
  return {ok:true,status:200,json:async()=>structuredClone(value)};
};
const storage={jobsSyncV1:{deviceId:input.device_id,token:input.receipt_token,profileToken:input.profile_token,outbox:[]}};
const session={};
const area=data=>({get:async()=>structuredClone(data),set:async values=>Object.assign(data,structuredClone(values))});
const context=vm.createContext({URL,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,Date,fetch,console,setTimeout,clearTimeout,
 chrome:{runtime:{id:'ccohapahbamkcbgkpegidkpknoeikiko',onMessage:{addListener(){}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
 storage:{local:area(storage),session:area(session)},tabs:{query:async()=>[],sendMessage:async()=>({})},alarms:{create(){},onAlarm:{addListener(){}}}}});
for(const name of ['brand','job-match-rules','job-match','public-job-url','sync'])vm.runInContext(await readModule(new URL(name+'.js',custom),'utf8'),context);
if(input.title_only){
 scenario='job-title';
 await context.JobsSync.reportJobTitle(input.job_url,input.title,input.website_job_id);
 process.stdout.write(JSON.stringify(requests));
 process.exit(0);
}
for(const proof of ['submit_attempt','submit_validation_error','ats_confirmation','tracker_record']){
 scenario=proof;
 await context.JobsSync.record({status:'applied',jobLink:input.job_url,jobTitle:'Fixture Engineer',companyName:'Fixture Company',date:'2026-09-26',profileName:'Fixture'},
   {url:input.job_url,proof,eventId:webcrypto.randomUUID(),profileId:input.profile_id});
 await context.JobsSync.flush();
}
scenario='answer-text';
await context.JobsSync.generateAnswer({profileId:input.profile_id,profileVersion:input.profile_version,prompt:'Why this team?',additionalContext:'Synthetic test only',jobTitle:'Fixture Engineer',jobDescription:'Fixture role'});
scenario='answer-fields';
await context.JobsSync.generateAnswer({profileId:input.profile_id,profileVersion:input.profile_version,
 fields:[{fieldId:'motivation',question:'Why this team?',type:'textarea',required:true,options:[]}],
 formContext:[{question:'First name',answer:'Fixture'}],jobTitle:'Fixture Engineer',jobDescription:'Fixture role'});

const bundle=(await build({entryPoints:[fileURLToPath(new URL('../web/src/manage/store.ts',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'WebsiteStore',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles[0].text;
const web=vm.createContext({fetch,AbortSignal,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,console});
vm.runInContext(bundle,web);
const store=new web.WebsiteStore.ManagementStore();
scenario='state-settings';
await store.write({settings:{autofillSettings:{autoClickNextPage:true}}});
scenario='application-create';
await store.mutateApplications([{action:'create',value:{jobTitle:'Manual Fixture Engineer',jobLink:'https://jobs.lever.co/fixture/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',companyName:'Fixture',companyLink:'',date:'2026-09-26T12:00:00Z',status:'applied',profileName:'Fixture'}}]);
if(input.application){
 scenario='application-update';
 await store.mutateApplications([{action:'update',application_id:input.application.id,expected_version:input.application.version,value:{...input.application,jobTitle:'Updated Fixture Engineer'}}]);
 scenario='application-progress';
 await store.updateProgress(input.application,{stage:'interview',action:'set',summary:'Confirmed fixture interview',interview_round:1,is_final:false});
 scenario='application-delete';
 await store.mutateApplications([{action:'delete',application_id:input.application.id,expected_version:input.application.version+1}]);
}
process.stdout.write(JSON.stringify(requests));
