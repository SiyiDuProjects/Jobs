// Actual current migration worker ↔ real Python ASGI routes, through offline pipes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createMigration} from '../../../extensions/speedyapply-local/source/storage-migration/worker.js';

const child=spawn(process.argv[2], ['-u', fileURLToPath(new URL('./storage_migration_bridge.py', import.meta.url)), process.argv[3],process.argv[4]||'normal'], {stdio:['pipe','pipe','pipe']});
const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
let errors='';child.stderr.on('data', chunk=>{errors+=chunk;});
const take=async()=>{const line=await lines.next();assert.ok(!line.done,errors);return JSON.parse(line.value);};
const initial=await take();
const rpc=async(value)=>{child.stdin.write(JSON.stringify(value)+'\n');const result=await take();if(result.status>=400)throw Object.assign(Error(result.value.code||result.value.error),result.value);return result.value;};
function area(initial){
  const values=structuredClone(initial);
  return {values,
    getKeys:async()=>Object.keys(values),
    getBytesInUse:async(keys)=>Buffer.byteLength(JSON.stringify(Object.fromEntries([keys].flat().filter(k=>Object.hasOwn(values,k)).map(k=>[k,values[k]])))),
    get:async(keys)=>{assert.notEqual(keys,null);return structuredClone(Object.fromEntries([keys].flat().filter(k=>Object.hasOwn(values,k)).map(k=>[k,values[k]])));},
    set:async(value)=>{Object.assign(values,structuredClone(value));},
    remove:async(keys)=>{for(const key of [keys].flat())delete values[key];},
    clear:async()=>{throw Error('No storage.clear');},
  };
}
try{
  const record=initial.record, key='jobsResponses:'+record.id;
  const profile=structuredClone(record.profile);profile.applicationData={...profile.applicationData,aiNotes:'Local synthetic notes'};
  const operational={jobsSyncV1:{outbox:[{id:'protected'}],token:'SYNTHETIC-DO-NOT-UPLOAD'},autofillAccount:{accountPassword:'SYNTHETIC-DO-NOT-UPLOAD'}};
  const local=area({...operational,profile,lastSyncProfile:{id:record.id,lastSync:record.last_sync},settings:{premiumSettings:{responseContext:'Local context',keep:7}},configList:[{configName:'Synthetic',premiumSettings:{responseContext:'Config context',keep:true}}]});
  const pending={[key]:[{key:'why',question:'Why?',keywords:['why'],appearances:1,response:'Synthetic saved answer'}],jobsManagementBaseV1:{[key]:{value:[],revision:1}}};
  const session=area(pending), calls=[];
  let frozen=false;
  const remote=async(path,method='GET',body)=>{calls.push({path,method});return rpc({path,method,body});};
  const dependencies={storage:{local,session},build:'synthetic-client-build',identity:async()=>({deviceId:initial.deviceId}),remote,
    maintenance:{freeze:async()=>{frozen=true;},finish:async()=>{frozen=false;}},stopPages:async()=>{},pendingSnapshot:async()=>structuredClone(pending),quiesce:async()=>{}};
  let worker=createMigration(dependencies);
  const sender={id:'synthetic',url:'chrome-extension://synthetic/migration.html',tab:{id:1},frameId:0,documentId:'synthetic-document'};
  let result=await worker.handle('start',sender), plan=result.plan;
  while(plan.conflicts.length){
    const conflict=plan.conflicts[0];
    const choice=conflict.choices.find(c=>c.id==='source:0')||conflict.choices.find(c=>c.id==='profile:'+record.id)||conflict.choices.find(c=>c.id==='import');
    assert.ok(choice,JSON.stringify(conflict));
    let previewId,cursor;
    if(choice.requiresPreview){
      do{
        const {preview}=await worker.handle('preview',sender,{planRevision:plan.revision,conflictId:conflict.id,choiceId:choice.id,...(cursor?{cursor}:{})});
        assert.ok(!preview.blocked);cursor=preview.nextCursor;if(preview.complete)previewId=preview.previewId;
      }while(!previewId);
    }
    result=await worker.handle('resolve',sender,{planRevision:plan.revision,conflictId:conflict.id,choiceId:choice.id,previewId});plan=result.plan;
  }
  if(process.argv[4]==='interrupt-saga'){
    await assert.rejects(worker.handle('apply',sender,{planRevision:plan.revision}), /synthetic_after_commit_failure/);
    assert.ok(local.values.profile,'failed apply preserves original');
    worker=createMigration(dependencies);result=await worker.handle('resume',sender);
  }else result=await worker.handle('apply',sender,{planRevision:plan.revision});
  assert.equal(result.status.phase,'ready_to_clean');
  for(let i=0;i<30&&result.status.phase!=='complete';i++)result=await worker.handle('cleanup',sender);
  assert.equal(result.status.phase,'complete');assert.equal(frozen,false);
  assert.equal(local.values.profile,undefined);assert.equal(session.values[key],undefined);assert.equal(session.values.jobsManagementBaseV1,undefined);
  assert.deepEqual(local.values.settings,{premiumSettings:{keep:7}});assert.deepEqual(local.values.configList,[{configName:'Synthetic',premiumSettings:{keep:true}}]);
  for(const [key,value]of Object.entries(operational))assert.deepEqual(local.values[key],value);
  const inspected=await rpc({inspect:true});
  assert.equal(inspected.profiles.length,1);
  const notes=inspected.profiles[0].profile.applicationData.aiNotes;
  for(const text of ['Local synthetic notes','Local context','Config context','Server synthetic context'])assert.ok(notes.includes(text),text);
  assert.equal(inspected.management[key].value[0].response,'Synthetic saved answer');
  assert.deepEqual(inspected.management.settings.value,{premiumSettings:{keep:4}});
  process.stdout.write(JSON.stringify({phase:'complete',requests:calls.length,previewRequests:calls.filter(c=>c.path.includes('/preview?')).length,protectedOperationalKeys:true}));
}finally{
  child.stdin.end();
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});
}
