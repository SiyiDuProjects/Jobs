import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../src/main.tsx',import.meta.url));
const bundle=(await build({entryPoints:[entry],bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles[0].text;
const modelBundle=(await build({entryPoints:[fileURLToPath(new URL('../src/manage/model.ts',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'model',platform:'node',logLevel:'silent'})).outputFiles[0].text;
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
const ng='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',intern='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
async function fixture(route='/',authenticated=true,legacy=false,applications,settings,extra={}){
 const errors=[],requests=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://jobs.test/'+(legacy?'manage/':'')+'#'+(route==='/'?'/applications':route),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.AbortSignal=AbortSignal;w.CSS={supports:()=>false,escape:v=>String(v).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c)};w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};w.Element.prototype.getAnimations=()=>[];
 w.eval(modelBundle+';globalThis.model=model;');const records={};for(const [id,name]of [[ng,'Newgrad'],[intern,'Intern']]){const profile=structuredClone(w.model.defaultProfile);profile.profileName=name;profile.nameData.firstName=name;profile.nameData.lastName='Demo';records[id]={id,profile,last_sync:'v1'};}
 let docs={appliedList:{revision:1,value:[{id:'application-1',version:1,kind:'newgrad',jobTitle:'Software Intern',jobLink:'https://jobs.example/1',companyName:'Example',companyLink:'',date:new Date().toISOString(),status:'applied',profileName:'Intern'}]},['jobsResponses:'+ng]:{revision:1,value:[{key:'source',keywords:['source'],response:'NEWGRAD_RESPONSE',appearances:1,fromAutofill:true}]},['jobsResponses:'+intern]:{revision:1,value:[{key:'source',keywords:['source'],response:'INTERN_RESPONSE',appearances:1,fromAutofill:true}]}};
 if(applications)docs.appliedList.value=applications;
 if(extra.reviews)docs.applicationProgressReview={revision:0,value:extra.reviews};
 for(const [key,value] of Object.entries(extra.savedViews||{}))w.sessionStorage.setItem(key,JSON.stringify(value));
 if(settings)docs.settings={revision:1,value:structuredClone(settings)};
 let failProfile=false;
 w.fetch=async(url,init={})=>{const rawURL=url,params=new URL(url,w.location.href).searchParams;if(url.startsWith('/api/manage/state?'))url='/api/manage/state'+(params.get('applications')==='0'?'?applications=0':'');requests.push({url,rawURL,body:init.body});let data,status=200;const body=init.body?JSON.parse(init.body):null;
  if(url==='/api/session')data={authenticated};
  else if(url.startsWith('/api/jobs?'))data={groups:{},jobs:[],application_counts:{submitted:0},total:0,source_health:[]};
  else if(url.startsWith('/api/filter-counts?'))data={newgrad:{total:0,submitted:0},internship:{total:0,submitted:0},total:0};
  else if(url==='/api/application-overview')data={highest_stage_counts:{newgrad:{no_answer:docs.appliedList.value.filter(r=>r.kind==='newgrad').length},internship:{no_answer:docs.appliedList.value.filter(r=>r.kind==='internship').length}}};
  else if(url.startsWith('/api/application-counts?'))data={today:1,week:1};
  else if(url==='/api/manage/state'||url==='/api/manage/state?applications=0'){if(body){for(const c of body.changes){if((docs[c.key]?.revision||0)!==c.revision){status=409;break;}}if(status===200)for(const c of body.changes)docs[c.key]={value:c.value,revision:c.revision+1};}data=status===409?{error:'Conflict'}:docs;if(status===200&&url.endsWith('applications=0')){const {appliedList,applicationProgressReview,...rest}=data;data=rest;}}
  else if(url==='/api/manage/progress-review'){
    const row=docs.appliedList.value.find(r=>r.id===body.application_id),review=docs.applicationProgressReview.value.find(r=>r.job_id===body.review_id);
    if(!row||row.progress.version!==body.expected_version){status=409;data={error:'Progress version conflict'};}
    else{row.progress={...row.progress,stage:review.stage,version:row.progress.version+1};docs.applicationProgressReview.value=docs.applicationProgressReview.value.filter(r=>r!==review);data={applied:true};}
  }
  else if(url==='/api/manage/applications'){
    if(!body)data={applications:docs.appliedList.value};
    else {for(const change of body.changes){const index=docs.appliedList.value.findIndex(r=>r.id===change.application_id);if(change.action==='create')docs.appliedList.value.push({...change.value,id:w.crypto.randomUUID(),version:1});else if(index<0||docs.appliedList.value[index].version!==change.expected_version){status=409;data={error:'Application version conflict'};break;}else if(change.action==='delete')docs.appliedList.value.splice(index,1);else docs.appliedList.value[index]={...change.value,version:change.expected_version+1};}data??={ok:true};}
  }
  else if(url.startsWith('/api/manage/profiles')){const id=url.split('/')[4];if(init.method==='GET'&&!id)data=Object.values(records).map(r=>({id:r.id,profileName:r.profile.profileName}));else if(init.method==='GET')data=records[id||ng];else if(['POST','PUT'].includes(init.method)){if(failProfile||(id&&body.expected_sync!==records[id].last_sync)){status=409;data={error:'Profile version conflict'};}else{const pid=id||w.crypto.randomUUID();records[pid]={id:pid,profile:body.profile,last_sync:'v'+requests.length};data={id:pid,last_sync:records[pid].last_sync};}}else throw Error('Unexpected profile method');}
  else throw Error('Unexpected URL '+url);
  if(url.startsWith('/api/manage/state')&&!body&&params.has('keys')){const keys=params.get('keys').split(','),revisions=JSON.parse(params.get('since')||'{}');data=Object.fromEntries(Object.entries(data).filter(([key,doc])=>['appliedList','applicationProgressReview'].includes(key)||keys.includes(key)&&revisions[key]!==doc.revision));}
  return {ok:status===200,status,json:async()=>structuredClone(data)};
 };
 w.eval(bundle);const ready=()=>!authenticated?w.document.body.textContent.includes('连接你的 jobs'):route==='/profile/new'?w.document.querySelector('h1')?.textContent==='新建资料':route.startsWith('/profile')?w.document.getElementById('personal'):route.startsWith('/settings')?w.document.querySelectorAll('[role="switch"]').length===2:w.document.body.textContent.includes('今日 ');for(let i=0;i<100&&!ready();i++)await tick();await tick();await tick();
 return {w,dom,errors,requests,docs,records,setFailProfile:v=>{failProfile=v;}};
}
const findButton=(h,text)=>[...h.w.document.querySelectorAll('button, [role=tab]')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text);

async function click(h,text){let button=findButton(h,text);if(!button&&['导出 CSV','手动补录','投递进展图','编辑','更新进展','归类'].includes(text)){const menu=['编辑','更新进展','归类'].includes(text)?h.w.document.querySelector('td button[aria-haspopup]'):findButton(h,'列表更多操作');menu.click();await tick();await tick();button=[...h.w.document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent===text);}assert(button,'button '+text);button.click();await tick();await tick();}
function fill(h,label,value){const labels=[...h.w.document.querySelectorAll('label')],node=labels.find(l=>l.textContent.replace('*','').trim()===label);const input=node?h.w.document.getElementById(node.htmlFor):h.w.document.querySelector(`[aria-label="${label}"]`);assert(input,'field '+label);const proto=input.tagName==='TEXTAREA'?h.w.HTMLTextAreaElement.prototype:h.w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new h.w.Event('input',{bubbles:true}));}
async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await tick();}assert(predicate(),'condition did not become true');}


test('legacy profile route opens the same document without exposing old responses',async()=>{const h=await fixture('/profile',true,true);try{await until(()=>h.w.document.getElementById('personal'));assert.equal(h.w.location.pathname,'/');assert.equal(h.w.location.hash,'#/profile');assert.equal(h.w.document.querySelectorAll('header').length,1);assert(!h.w.document.body.textContent.includes('NEWGRAD_RESPONSE'));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('one employment switch scopes rows, flow, export, counts and trash independently of Profiles',async()=>{
 const base={version:1,jobLink:'https://jobs.example/role',companyName:'Example',companyLink:'',date:new Date().toISOString(),status:'applied',profileName:'Shared Profile'};
 const rows=[{...base,id:'fulltime',kind:'newgrad',jobTitle:'Fulltime engineer'}, {...base,id:'internship',kind:'internship',jobTitle:'Intern engineer'}, {...base,id:'fulltime-other-profile',kind:'newgrad',jobTitle:'Another fulltime',profileName:'Other Profile'}];
 const h=await fixture('/',true,false,rows);
 try {
  await until(()=>h.w.document.body.textContent.includes('Fulltime engineer'));
  assert(h.w.document.body.textContent.includes('Another fulltime'));
  assert(!h.w.document.body.textContent.includes('Intern engineer'));
  assert.equal(h.w.document.querySelectorAll('.job-list-desktop tbody tr').length,2);
  assert(!h.w.document.body.textContent.includes('待核对邮件'));
  await click(h,'投递进展图');await until(()=>findButton(h,'暂无有效推进 · 2'));assert(findButton(h,'暂无有效推进 · 2'));await click(h,'取消');
  assert(!h.w.document.body.textContent.includes('暂无有效推进'));
  await click(h,'实习');
  await until(()=>h.w.document.body.textContent.includes('Intern engineer'));
  assert(!h.w.document.body.textContent.includes('Fulltime engineer'));
  assert(!h.w.document.body.textContent.includes('Another fulltime'));
  assert.equal(h.w.document.querySelectorAll('.job-list-desktop tbody tr').length,1);
  assert(h.requests.some(r=>r.url.startsWith('/api/application-counts?kind=internship&')));
  let exported;
  h.w.URL.createObjectURL=blob=>{exported=blob;return 'blob:test';};h.w.URL.revokeObjectURL=()=>{};
  h.w.HTMLAnchorElement.prototype.click=function(){};
  await click(h,'导出 CSV');
  const csv=await new Promise(resolve=>{const reader=new h.w.FileReader();reader.onload=()=>resolve(reader.result);reader.readAsText(exported);});
  assert.match(csv,/Intern engineer/);assert.doesNotMatch(csv,/Fulltime engineer|Another fulltime/);
  await click(h,'手动补录');fill(h,'岗位名称','New internship');await tick();await click(h,'添加');
  await until(()=>h.docs.appliedList.value.some(r=>r.jobTitle==='New internship'));
  assert.equal(h.docs.appliedList.value.find(r=>r.jobTitle==='New internship').kind,'internship');
  await click(h,'岗位');await until(()=>h.requests.some(r=>r.url.startsWith('/api/jobs?')&&r.url.includes('kind=internship')));
  await click(h,'已删除');await until(()=>h.requests.some(r=>r.url.includes('view=trash')&&r.url.includes('kind=internship')));
  await click(h,'全职');await until(()=>h.requests.some(r=>r.url.includes('view=trash')&&r.url.includes('kind=newgrad')));
  await click(h,'已投递');await until(()=>h.w.document.body.textContent.includes('Fulltime engineer'));
  assert(!h.w.document.body.textContent.includes('Intern engineer'));
  assert.equal(h.requests.filter(r=>r.url==='/api/session').length,1);
  assert.deepEqual(h.errors,[]);
 } finally {h.dom.window.close();}
});
test('create profile preserves the existing profile',async()=>{const h=await fixture('/profile/new');try{const before=structuredClone(h.records[ng]);fill(h,'名','New');fill(h,'姓','Person');fill(h,'资料名称','Another');await tick();await click(h,'创建资料');await until(()=>Object.keys(h.records).length===3);assert.deepEqual(h.records[ng],before);assert(Object.values(h.records).some(r=>r.profile.profileName==='Another'));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('highest-stage chart counts external and rejected applications once within each employment kind',async()=>{
 const base={version:1,jobLink:'',companyName:'Synthetic Employer',companyLink:'',date:new Date().toISOString(),profileName:'Shared'};
 const rows=Array.from({length:11},(_,i)=>{
  const stage=i<3?'interview':'assessment',rejected=i===2||i===3;
  return {...base,id:'synthetic-'+i,kind:i<6?'newgrad':'internship',jobTitle:'Role '+i,status:rejected?'rejected':stage,
   progress:{stage:rejected?'rejected':stage,highest_stage:stage,assessment_type:'owner_confirmed',ever_advanced:true,
    chart_path:[...(i<2?[{stage:'assessment'},{stage:'interview',round:1},{stage:'interview',round:2}]:i===2?[{stage:'interview'}]:[{stage:'assessment'}]),...(rejected?[{stage:'rejected'}]:[])]}};
 });
 const h=await fixture('/',true,false,rows);
 try {
  await click(h,'投递进展图');
  await until(()=>findButton(h,'在线测评 · 3'));
  assert(findButton(h,'面试 · 第 1 轮 · 2'));
  assert(findButton(h,'面试 · 第 2 轮 · 2'));
  assert(findButton(h,'面试 · 1'));
  assert(h.w.document.body.textContent.includes('共 6 条'));
  await click(h,'面试 · 第 2 轮 · 2');
  assert(h.w.document.body.textContent.includes('Role 0'));
  assert(h.w.document.body.textContent.includes('Role 1'));
  assert(!h.w.document.body.textContent.includes('Role 2'));
  await click(h,'投递进展图');await click(h,'在线测评 · 3');
  assert(h.w.document.body.textContent.includes('Role 3'));
  assert(!h.w.document.body.textContent.includes('Role 0'));
  await click(h,'实习');
  await click(h,'投递进展图');await until(()=>findButton(h,'在线测评 · 5'));
  assert(!findButton(h,'面试 · 第 2 轮 · 2'));
  assert(h.w.document.body.textContent.includes('共 5 条'));
  assert.deepEqual(h.errors,[]);
 } finally {h.dom.window.close();}
});
test('settings keep only navigation switches and preserve old private configuration',async()=>{const settings={autofillSettings:{autoSubmit:false},premiumSettings:{responseContext:'Unmigrated synthetic context'}};const h=await fixture('/settings',true,false,undefined,settings);try{await until(()=>h.w.document.querySelectorAll('[role="switch"]').length===2);h.w.document.querySelector('[role="switch"]').click();await until(()=>h.docs.settings.value.autofillSettings.autoClickNextPage===true);assert.equal(h.docs.settings.value.autofillSettings.autoSubmit,false);assert.equal(h.docs.settings.value.autofillSettings.saveApplications,true);assert.equal(h.docs.settings.value.autofillSettings.saveResponses,true);assert.equal(h.docs.settings.value.premiumSettings.responseContext,settings.premiumSettings.responseContext);assert.doesNotMatch(h.w.document.body.textContent,/Daily|Configuration|AI 回答|Workday 自动填写技能/);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('unauthenticated page never reads private documents',async()=>{const h=await fixture('/',false);try{assert.equal(h.requests.length,1);assert.match(h.w.document.body.textContent,/有服务器访问权限的助手/);}finally{h.dom.window.close();}});
test('editing one application retains its Profile and uses row mutation',async()=>{const h=await fixture();try{await click(h,'编辑');fill(h,'岗位名称','Edited Intern');await tick();await click(h,'保存');await until(()=>h.docs.appliedList.value[0].jobTitle==='Edited Intern');assert.equal(h.docs.appliedList.value[0].profileName,'Intern');assert(h.requests.some(r=>r.url==='/api/manage/applications'));assert(!h.requests.some(r=>r.url==='/api/manage/state'&&r.body&&JSON.parse(r.body).changes.some(c=>c.key==='appliedList')));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('inline Profile edit saves bound revision and preserves attachments',async()=>{const h=await fixture('/profile');try{await until(()=>h.w.document.getElementById('personal'));await click(h,'个人');fill(h,'名','Changed');await tick();await click(h,'保存更改');await until(()=>h.records[ng].profile.nameData.firstName==='Changed');const write=h.requests.find(r=>r.url==='/api/manage/profiles/'+ng&&r.body);assert.equal(JSON.parse(write.body).expected_sync,'v1');assert.deepEqual(h.records[ng].profile.resumeData,{resumeBase64:'',fileName:'',fileSize:0,dateUploaded:''});assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('failed inline save retains draft and blocks navigation until retry succeeds',async()=>{const h=await fixture('/profile');try{await until(()=>h.w.document.getElementById('personal'));await click(h,'个人');h.setFailProfile(true);fill(h,'名','Keep my draft');await tick();assert(findButton(h,'设置').disabled);await click(h,'保存更改');await until(()=>h.w.document.body.textContent.includes('Profile version conflict'));assert([...h.w.document.querySelectorAll('input')].some(i=>i.value==='Keep my draft'));const unsaved=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(unsaved);assert(unsaved.defaultPrevented);h.setFailProfile(false);await click(h,'保存更改');await until(()=>h.records[ng].profile.nameData.firstName==='Keep my draft');await tick();const saved=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(saved);assert(!saved.defaultPrevented);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});

test('top-level kind is the only Profile selector and switching never rewrites its correspondence',async()=>{
 const h=await fixture('/profile');
 try {
  await until(()=>h.w.document.querySelector('h1')?.textContent==='全职资料（Newgrad）');
  assert(!h.w.document.querySelector('[aria-label="当前资料"]'));
  const bindingWrites=()=>h.requests.filter(r=>r.body&&r.url.startsWith('/api/manage/state')&&JSON.parse(r.body).changes.some(c=>c.key==='jobsKindProfiles')).length;
  assert.equal(bindingWrites(),1,'name defaults are materialized once');
  const original=structuredClone(h.docs.jobsKindProfiles.value);
  await click(h,'实习');await until(()=>h.w.document.querySelector('h1')?.textContent==='实习资料（Intern）');
  await click(h,'全职');await until(()=>h.w.document.querySelector('h1')?.textContent==='全职资料（Newgrad）');
  assert.deepEqual(h.docs.jobsKindProfiles.value,original);assert.equal(bindingWrites(),1);
  await click(h,'更多');await until(()=>h.w.document.querySelector('[role="menu"]'));
  const items=[...h.w.document.querySelectorAll('[role="menuitem"]')].map(n=>n.textContent);
  for(const label of ['新建资料','重命名','删除资料'])assert(items.includes(label));
  assert.deepEqual(h.errors,[]);
 } finally {h.dom.window.close();}
});

async function choose(h,label,text){
 const button=h.w.document.querySelector(`button[aria-label="${label}"]`)||[...h.w.document.querySelectorAll('button')].find(b=>b.getAttribute('aria-labelledby')?.split(' ').some(id=>h.w.document.getElementById(id)?.textContent===label));
 assert(button,'select '+label);button.click();await tick();
 const option=[...h.w.document.querySelectorAll('[role=option]')].find(n=>n.textContent.trim()===text);assert(option,'option '+text);option.click();await tick();await tick();
}

test('new Profile blocks navigation and unloading until saved or explicitly discarded',async()=>{
 const h=await fixture('/profile/new');
 try {
  fill(h,'资料名称','Unsaved profile');await tick();
  assert(findButton(h,'设置').disabled);
  const before=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(before);assert(before.defaultPrevented);
  h.w.location.hash='/settings';await until(()=>h.w.location.hash==='#/profile/new');
  assert([...h.w.document.querySelectorAll('input')].some(i=>i.value==='Unsaved profile'));
  await click(h,'放弃并返回');await until(()=>h.w.location.hash==='#/settings');
  const after=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(after);assert(!after.defaultPrevented);
  assert.equal(Object.keys(h.records).length,2);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('unknown applications remain reachable and classification preserves the record with version checking',async()=>{
 const unknown={id:'unknown-1',version:7,kind:'unknown',jobTitle:'Unclassified engineer',jobLink:'https://jobs.example/unknown',companyName:'Example',companyLink:'',date:new Date().toISOString(),status:'interview',profileName:'Historical Profile'};
 const h=await fixture('/',true,false,[unknown]);
 try {
  assert(!h.w.document.querySelector('.job-list-desktop').textContent.includes('Unclassified engineer'));
  await click(h,'未分类 · 1');await until(()=>h.w.document.querySelector('.job-list-desktop').textContent.includes('Unclassified engineer'));
  await click(h,'归类');await click(h,'保存分类');assert(h.w.document.body.textContent.includes('请选择全职或实习'));
  await choose(h,'岗位类型','实习');await click(h,'保存分类');await until(()=>h.docs.appliedList.value[0].kind==='internship');
  const request=h.requests.find(r=>r.url==='/api/manage/applications'&&r.body);const change=JSON.parse(request.body).changes[0];
  assert.equal(change.expected_version,7);assert.equal(change.value.profileName,'Historical Profile');assert.equal(change.value.status,'interview');
  await click(h,'实习');await until(()=>h.w.document.querySelector('.job-list-desktop').textContent.includes('Unclassified engineer'));
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('applied controls restore independently by employment kind after navigation and reload state',async()=>{
 const base={version:1,jobLink:'',companyName:'Company',companyLink:'',date:'2026-10-20T12:00:00Z',status:'interview',profileName:'Shared'};
 const rows=[...Array.from({length:40},(_,i)=>({...base,id:'ng-'+i,kind:'newgrad',jobTitle:'Engineer '+String(i).padStart(2,'0')})),{...base,id:'intern-1',kind:'internship',jobTitle:'Intern role'}];
 const saved={'jobs:view:applied:newgrad':{query:'Engineer',status:'interview',from:'2026-10-01',to:'2026-10-22',page:2}};
 const h=await fixture('/',true,false,rows,undefined,{savedViews:saved});
 try {
  await until(()=>h.w.document.body.textContent.includes('Engineer 30'));
  assert(!h.w.document.querySelector('.job-list-desktop').textContent.includes('Engineer 00'));
  assert.equal(h.w.document.querySelector('[aria-label="搜索投递"]').value,'Engineer');
  await click(h,'实习');await until(()=>h.w.document.body.textContent.includes('Intern role'));
  assert.equal(h.w.document.querySelector('[aria-label="搜索投递"]').value,'');
  await click(h,'全职');await until(()=>h.w.document.body.textContent.includes('Engineer 30'));
  await click(h,'设置');await until(()=>h.w.location.hash==='#/settings');
  h.w.location.hash='/applied';await until(()=>h.w.document.body.textContent.includes('Engineer 30'));
  const persisted=JSON.parse(h.w.sessionStorage.getItem('jobs:view:applied:newgrad'));
  assert.equal(persisted.status,'interview');assert.equal(persisted.from,'2026-10-01');assert.equal(persisted.to,'2026-10-22');assert.equal(persisted.page,2);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('pending recruiting review requires an explicit application and sends the current progress version',async()=>{
 const row={id:'review-target',version:2,kind:'newgrad',jobTitle:'Engineer',jobLink:'',companyName:'Example',companyLink:'',date:'2026-10-20T12:00:00Z',status:'applied',profileName:'Shared',progress:{stage:'applied',version:4}};
 const review={job_id:'email:synthetic-message',message_id:'synthetic-message',received_at:1792600000,companyName:'Example',stage:'interview',label:'面试',summary:'Please choose an interview slot',candidates:[{id:row.id,companyName:row.companyName,jobTitle:row.jobTitle,jobLink:''}],email_url:'https://mail.google.com/mail/u/test/#all/synthetic-message'};
 const h=await fixture('/',true,false,[row],undefined,{reviews:[review]});
 try{
  await click(h,'待确认进展 · 1');await click(h,'核对');
  assert.equal(h.w.document.querySelector('a[href*="synthetic-message"]').getAttribute('href'),review.email_url);
  await click(h,'确认对应申请');assert(h.w.document.body.textContent.includes('请选择这封邮件对应的申请'));assert(!h.requests.some(r=>r.url==='/api/manage/progress-review'));
  await choose(h,'对应申请','Example · Engineer（全职，10/20）');
  await click(h,'确认对应申请');await until(()=>h.docs.applicationProgressReview.value.length===0);
  const body=JSON.parse(h.requests.find(r=>r.url==='/api/manage/progress-review').body);
  assert.equal(body.review_id,review.job_id);assert.equal(body.application_id,row.id);assert.equal(body.expected_version,4);assert(body.idempotency_key);
  assert(!findButton(h,'待确认进展 · 1'));assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('a delayed copy cannot overwrite a newer new-Profile draft',async()=>{
 const h=await fixture('/profile/new');
 try{
  await choose(h,'复制已有资料','Newgrad');
  let release,entered;const ready=new Promise(r=>entered=r),response=new Promise(r=>release=r),fetch=h.w.fetch;
  h.w.fetch=async(url,init)=>{if(url==='/api/manage/profiles/'+ng&&init.method==='GET'){entered();await response;}return fetch(url,init);};
  await click(h,'复制');await ready;
  fill(h,'资料名称','Keep newer draft');await tick();
  release();await tick();await tick();
  assert([...h.w.document.querySelectorAll('input')].some(i=>i.value==='Keep newer draft'));
  assert(![...h.w.document.querySelectorAll('input')].some(i=>i.value==='Newgrad 副本'));
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});
