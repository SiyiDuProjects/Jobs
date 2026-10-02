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
async function fixture(route='/',authenticated=true,legacy=false,applications,settings){
 const errors=[],requests=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://jobs.test/'+(legacy?'manage/':'')+'#'+(route==='/'?'/applications':route),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.AbortSignal=AbortSignal;w.CSS={supports:()=>false,escape:v=>String(v).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c)};w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};w.Element.prototype.getAnimations=()=>[];
 w.eval(modelBundle+';globalThis.model=model;');const records={};for(const [id,name]of [[ng,'Newgrad'],[intern,'Intern']]){const profile=structuredClone(w.model.defaultProfile);profile.profileName=name;profile.nameData.firstName=name;profile.nameData.lastName='Demo';records[id]={id,profile,last_sync:'v1'};}
 let docs={appliedList:{revision:1,value:[{id:'application-1',version:1,jobTitle:'Software Intern',jobLink:'https://jobs.example/1',companyName:'Example',companyLink:'',date:new Date().toISOString(),status:'applied',profileName:'Intern'}]},['jobsResponses:'+ng]:{revision:1,value:[{key:'source',keywords:['source'],response:'NEWGRAD_RESPONSE',appearances:1,fromAutofill:true}]},['jobsResponses:'+intern]:{revision:1,value:[{key:'source',keywords:['source'],response:'INTERN_RESPONSE',appearances:1,fromAutofill:true}]}};
 if(applications)docs.appliedList.value=applications;
 if(settings)docs.settings={revision:1,value:structuredClone(settings)};
 let failProfile=false;
 w.fetch=async(url,init={})=>{requests.push({url,body:init.body});let data,status=200;const body=init.body?JSON.parse(init.body):null;
  if(url==='/api/session')data={authenticated};
  else if(url.startsWith('/api/jobs?'))data={groups:{},jobs:[],recent_opened:[],application_counts:{submitted:0},total:0,source_health:[]};
  else if(url.startsWith('/api/filter-counts?'))data={newgrad:{total:0,submitted:0},internship:{total:0,submitted:0},total:0};
  else if(url==='/api/manage/state'){if(body){for(const c of body.changes){if((docs[c.key]?.revision||0)!==c.revision){status=409;break;}}if(status===200)for(const c of body.changes)docs[c.key]={value:c.value,revision:c.revision+1};}data=status===409?{error:'Conflict'}:docs;}
  else if(url==='/api/manage/applications'){
    if(!body)data={applications:docs.appliedList.value};
    else {for(const change of body.changes){const index=docs.appliedList.value.findIndex(r=>r.id===change.application_id);if(change.action==='create')docs.appliedList.value.push({...change.value,id:w.crypto.randomUUID(),version:1});else if(index<0||docs.appliedList.value[index].version!==change.expected_version){status=409;data={error:'Application version conflict'};break;}else if(change.action==='delete')docs.appliedList.value.splice(index,1);else docs.appliedList.value[index]={...change.value,version:change.expected_version+1};}data??={ok:true};}
  }
  else if(url.startsWith('/api/manage/profiles')){const id=url.split('/')[4];if(init.method==='GET'&&!id)data=Object.values(records).map(r=>({id:r.id,profileName:r.profile.profileName}));else if(init.method==='GET')data=records[id||ng];else if(['POST','PUT'].includes(init.method)){if(failProfile||(id&&body.expected_sync!==records[id].last_sync)){status=409;data={error:'Profile version conflict'};}else{const pid=id||w.crypto.randomUUID();records[pid]={id:pid,profile:body.profile,last_sync:'v'+requests.length};data={id:pid,last_sync:records[pid].last_sync};}}else throw Error('Unexpected profile method');}
  else throw Error('Unexpected URL '+url);
  return {ok:status===200,status,json:async()=>structuredClone(data)};
 };
 w.eval(bundle);for(let i=0;i<100&&!w.document.body.textContent.includes(authenticated?'已连接 jobs':'批准这个浏览器');i++)await tick();
 return {w,dom,errors,requests,docs,records,setFailProfile:v=>{failProfile=v;}};
}
const findButton=(h,text)=>[...h.w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text);

test('legacy management deep links resolve into the shared jobs website',async()=>{const h=await fixture('/profile',true,true);try{await until(()=>h.w.document.body.textContent.includes('NEWGRAD_RESPONSE'));assert.equal(h.w.location.pathname,'/');assert.equal(h.w.location.hash,'#/profile');assert.equal(h.w.document.querySelectorAll('header').length,1);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
async function click(h,text){const button=findButton(h,text);assert(button,'button '+text);button.click();await tick();await tick();}
function fill(h,label,value){const labels=[...h.w.document.querySelectorAll('label')],node=labels.find(l=>l.textContent.replace('*','').trim()===label);const input=node?h.w.document.getElementById(node.htmlFor):h.w.document.querySelector(`[aria-label="${label}"]`);assert(input,'field '+label);const proto=input.tagName==='TEXTAREA'?h.w.HTMLTextAreaElement.prototype:h.w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new h.w.Event('input',{bubbles:true}));}
async function until(predicate){for(let i=0;i<60;i++){if(predicate())return;await tick();}assert(predicate(),'condition did not become true');}

test('jobs and management share one navigation, session and document',async()=>{const h=await fixture();try{const root=h.w.document.getElementById('root');assert.equal(h.w.document.querySelectorAll('header').length,1);await click(h,'岗位列表');await until(()=>h.w.document.body.textContent.includes('当前筛选下没有岗位'));assert(h.requests.some(r=>r.url.startsWith('/api/jobs?')));await click(h,'投递记录');await until(()=>h.w.document.body.textContent.includes('Software Intern'));await click(h,'个人资料');await until(()=>h.w.document.body.textContent.includes('NEWGRAD_RESPONSE'));assert.equal(h.w.document.getElementById('root'),root);assert.equal(h.requests.filter(r=>r.url==='/api/session').length,1);assert.equal(h.w.location.pathname,'/');assert.equal(h.w.document.querySelectorAll('header').length,1);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});

test('manual profile creation creates a new server record without changing the selected profile',async()=>{const h=await fixture('/profile/new');try{const before=structuredClone(h.records[ng]);await click(h,'Create Manually');fill(h,'First Name','New');fill(h,'Last Name','Person');await tick();for(let i=0;i<5;i++)await click(h,'Next');fill(h,'Profile Name','Another');await tick();await click(h,'Finish');await until(()=>Object.keys(h.records).length===3);assert.deepEqual(h.records[ng],before);const added=Object.values(h.records).find(r=>r.profile.profileName==='Another');assert.equal(added.profile.nameData.firstName,'New');assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});

test('AI settings guide facts to the selected Profile while preserving unreviewed old context',async()=>{
 const settings={autofillSettings:{autoSubmit:false},premiumSettings:{responseContext:'Unmigrated synthetic context'}};
 const h=await fixture('/settings/premium',true,false,undefined,settings);
 try{await until(()=>h.w.document.body.textContent.includes('旧版补充内容已保留'));
  assert.equal(h.w.document.querySelector('textarea'),null);
  assert.deepEqual(h.docs.settings.value,settings);
  assert(!h.requests.some(r=>r.url==='/api/manage/state'&&r.body));
  const link=[...h.w.document.querySelectorAll('a')].find(a=>a.getAttribute('href')==='#/profile');assert(link);link.click();
  await until(()=>h.w.document.body.textContent.includes('NEWGRAD_RESPONSE'));
  assert.deepEqual(h.docs.settings.value,settings);assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});
test('integrated HeroUI Pro management renders without the extension runtime',async()=>{const h=await fixture();try{await until(()=>h.w.document.body.textContent.includes('Software Intern'));assert.deepEqual(h.errors,[]);assert.equal(h.w.chrome,undefined);assert.match(h.w.document.body.textContent,/Monthly Applications/);assert(h.w.document.querySelector('table'));assert(h.requests.every(r=>r.url.startsWith('/api/')));}finally{h.dom.window.close();}});
test('unauthenticated management never fetches private documents',async()=>{const h=await fixture('/',false);try{assert.equal(h.requests.length,1);assert.match(h.w.document.body.textContent,/批准这个浏览器/);}finally{h.dom.window.close();}});
for(const [route,text]of [['/profile','NEWGRAD_RESPONSE'],['/profile/new','Create Manually'],['/settings/autofill','Autofill Options'],['/settings/premium','AI 补充说明'],['/settings/subscription','Luna']])test('native route '+route,async()=>{const h=await fixture(route);try{await until(()=>h.w.document.body.textContent.includes(text));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('settings switch preserves other settings and saves on the server',async()=>{const h=await fixture('/settings/autofill');try{const checkbox=h.w.document.querySelector('[role="switch"]');assert(checkbox);checkbox.click();await until(()=>h.docs.settings?.value.autofillSettings.saveApplications===false);assert.equal(h.docs.settings.value.autofillSettings.autoSubmit,false);assert.equal(h.docs.settings.value.autofillSettings.saveResponses,true);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('application update opens original fields and saves only the selected record',async()=>{const h=await fixture();try{await click(h,'Actions for Software Intern');const update=[...h.w.document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent==='Update');assert(update);update.click();await tick();fill(h,'Job Title','Edited Intern');await tick();await click(h,'Update');await until(()=>h.docs.appliedList.value[0].jobTitle==='Edited Intern');assert.equal(h.docs.appliedList.value[0].profileName,'Intern');assert.equal(h.docs.appliedList.value[0].status,'applied');assert(h.requests.some(r=>r.url==='/api/manage/applications'));assert(!h.requests.some(r=>r.url==='/api/manage/state'&&r.body&&JSON.parse(r.body).changes.some(c=>c.key==='appliedList')));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('profile editor preserves resume and saves original schema with expected version',async()=>{const h=await fixture('/profile');try{await click(h,'Edit Personal Details');fill(h,'First Name','Changed');await tick();await click(h,'Save');await until(()=>h.records[ng].profile.nameData.firstName==='Changed');const write=h.requests.find(r=>r.url==='/api/manage/profiles/'+ng&&r.body);assert.equal(JSON.parse(write.body).expected_sync,'v1');assert.deepEqual(h.records[ng].profile.resumeData,{resumeBase64:'',fileName:'',fileSize:0,dateUploaded:''});assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('failed profile save keeps the editor and draft for retry',async()=>{const h=await fixture('/profile');try{h.setFailProfile(true);await click(h,'Edit Personal Details');fill(h,'First Name','Keep my draft');await tick();await click(h,'Save');await until(()=>h.w.document.body.textContent.includes('Profile version conflict'));assert(h.w.document.querySelector('[role="dialog"]'));assert.equal(h.records[ng].profile.nameData.firstName,'Newgrad');assert([...h.w.document.querySelectorAll('input')].some(i=>i.value==='Keep my draft'));const unsaved=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(unsaved);assert(unsaved.defaultPrevented);assert(findButton(h,'重试未保存更改'));h.setFailProfile(false);await click(h,'Save');await until(()=>h.records[ng].profile.nameData.firstName==='Keep my draft');const saved=new h.w.Event('beforeunload',{cancelable:true});h.w.dispatchEvent(saved);assert(!saved.defaultPrevented);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('editing an existing short saved response remains supported',async()=>{const h=await fixture('/profile');try{await click(h,'NEWGRAD_RESPONSE');fill(h,'Response','Revised answer');await tick();await click(h,'Update');await until(()=>h.docs['jobsResponses:'+ng].value[0].response==='Revised answer');assert.equal(h.docs['jobsResponses:'+intern].value[0].response,'INTERN_RESPONSE');assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('application deletion requires its confirmation dialog',async()=>{const h=await fixture();try{await click(h,'Manage');const button=[...h.w.document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent==='Delete All');button.click();await tick();assert.match(h.w.document.body.textContent,/cannot be undone/);assert.equal(h.docs.appliedList.value.length,1);await click(h,'Cancel');assert.equal(h.docs.appliedList.value.length,1);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});
test('board uses Pro Kanban without writing while rendering',async()=>{const h=await fixture();try{await click(h,'Board');assert.deepEqual(h.errors,[]);await until(()=>h.w.document.body.textContent.includes('Nothing here yet.'));await tick();assert.equal(h.requests.filter(r=>r.url==='/api/manage/state'&&r.body).length,0);assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}});

test('application flow filters confirmed history in list and board without writing',async()=>{
 const rows=[{id:'direct',companyName:'Direct Co',status:'interview',progress:{stage:'interview',round:1,chart_path:[{stage:'interview',round:1}]}},{id:'rejected',companyName:'Screened Co',status:'rejected',progress:{stage:'rejected',ever_advanced:true,display_stage:'rejected',chart_path:[{stage:'phone_screen'},{stage:'rejected'}]}}].map(r=>({...r,jobTitle:'Engineer',jobLink:'https://example.com/'+r.id,companyLink:'',date:new Date().toISOString(),profileName:'Newgrad'}));
 const h=await fixture('/',true,false,rows);
 try{
  await until(()=>h.w.document.querySelector('svg[aria-label="申请流向图，共 2 条记录"]'));
  const node=h.w.document.querySelector('[role="button"][aria-label="Screening：1 条申请，点击查看"]');assert(node);
  node.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
  assert.match(h.w.document.querySelector('table').textContent,/Screened Co/);
  assert.doesNotMatch(h.w.document.querySelector('table').textContent,/Direct Co/);
  await click(h,'Board');assert.match(h.w.document.body.textContent,/当前查看：Screening/);
  await click(h,'清除节点筛选');assert.match(h.w.document.body.textContent,/Direct Co/);
  await click(h,'投递趋势');assert.equal(h.w.document.querySelector('.application-flow-svg'),null);
  await click(h,'申请流向');assert(h.w.document.querySelector('.application-flow-svg'));
  assert.equal(h.requests.filter(r=>r.url==='/api/manage/state'&&r.body).length,0);assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});
