import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
const entry=new URL('../src/main.tsx',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
const bundle=(await build({entryPoints:[entry],bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles[0].text;
const tick=()=>new Promise(r=>setTimeout(r,20));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert(check(),'Board did not reach expected state');}
async function page(actionFailures=0,jobState={},saved={},applications=[]){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const dom=new JSDOM('<body><div id="root"></div></body>',{url:'https://fixture.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window,requests=[],actions=[];
 jobState={...jobState};
 const NativeDate=w.Date;w.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:["2026-10-10T19:00:00Z"]));}static now(){return new NativeDate("2026-10-10T19:00:00Z").getTime();}};
 w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 w.HTMLElement.prototype.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.getAnimations=()=>[];
 w.CSS={escape:value=>String(value).replace(/[^\w-]/g,c=>'\\'+c),supports:()=>false};
 w.fetch=async(path,options={})=>{
  const u=new URL(path,w.location.href);requests.push(u.pathname+u.search);let value;
  if(u.pathname==='/api/session')value={authenticated:true};
  else if(u.pathname==='/api/manage/state')value=u.searchParams.get('applications')==='0'?{}:{appliedList:{value:applications,revision:0}};
  else if(u.pathname==='/api/application-overview')value={highest_stage_counts:{newgrad:{no_answer:applications.length}}};
  else if(u.pathname==='/api/application-counts')value={today:2,week:5};
  else if(u.pathname==='/api/manage/profiles')value=[];
  else if(u.pathname==='/api/manage/progress')value={applications:[{history:[]}]};
  else if(u.pathname==='/api/extension/status')value={pending:0};
  else if(u.pathname==='/api/actions'){
   const payload=JSON.parse(options.body);actions.push(payload);
   if(actionFailures-->0)throw Error('Synthetic action failure');
   assert.equal(payload.job_id,'fixture-1');assert.equal(payload.version,jobState.application_version||0);
   assert(['submitted','undo_submitted'].includes(payload.action));
   jobState={...jobState,status:payload.action==='submitted'?'submitted':'not_started',can_undo_submission:payload.action==='submitted',application_version:payload.version+1};
   value={version:jobState.application_version};
  }
  else if(u.pathname==='/api/jobs')value={total:100,groups:{other:100},application_counts:{submitted:0},source_health:[],jobs:[{
   id:'fixture-'+u.searchParams.get('page'),company:'Fixture Employer',title:'Fixture Engineer Page '+u.searchParams.get('page'),
   kind:'newgrad',locations:['California'],sources:['simplify'],apply_url:'https://example.test/job',status:'not_started',
   review:null,screening:'pending',review_version:0,application_version:0,fingerprint:'fixture',group:'other',active:true,posted_at:1,added_at:1,...jobState
  }]};
  else throw Error('Unexpected URL '+path);
  return {ok:true,json:async()=>structuredClone(value)};
 };
 for(const [key,value] of Object.entries(saved))w.localStorage.setItem(key,JSON.stringify(value));
 w.eval(bundle);
 try{await until(()=>w.document.body.textContent.includes('Fixture Engineer Page 1'));}
 catch(error){const details=JSON.stringify({errors,requests,text:w.document.body.textContent});w.close();throw Error(error.message+' '+details);}
 return {w,dom,requests,errors,actions};
}
async function toolbarAction(h,label){
 h.w.document.querySelector('[aria-label="列表更多操作"]').click();
 await until(()=>[...h.w.document.querySelectorAll('[role=menuitem]')].some(n=>n.textContent.startsWith(label)));
 [...h.w.document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent.startsWith(label)).click();
}
async function menuAction(h,label){
 const trigger=h.w.document.querySelector('td button[aria-haspopup]');
 trigger.click();
 const item=()=>[...h.w.document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent===label);
 await until(()=>item()&&item().getAttribute('aria-disabled')!=='true');
 item().click();await until(()=>!h.w.document.querySelector('[role="menu"]'));
}
test('view tabs read a count summary once without loading application history',async()=>{
 const h=await page();try{
  await tick();assert(h.w.document.body.textContent.includes('Fixture Employer'));
  assert(!h.requests.some(path=>path.startsWith('/api/filter-counts')||path==='/api/manage/state'));
  assert.equal(h.requests.filter(path=>path==='/api/application-overview').length,1);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});
test('board pagination issues only a list request',async()=>{
 const h=await page();try{
  await tick();const before=h.requests.length;
  [...h.w.document.querySelectorAll('button')].find(b=>b.textContent==='下一页').click();
  await until(()=>h.w.document.body.textContent.includes('Fixture Engineer Page 2'));
  assert.equal(h.requests.length-before,1);assert(h.requests.at(-1).startsWith('/api/jobs?'));assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('rows expose only exceptional states and the Apply action',async()=>{
 for(const [status,active,label,state] of [
  ['not_started',true,'投递','待初筛'],
  ['in_progress',true,'投递','待初筛'],
  ['needs_input',true,'投递','待初筛'],
  ['submitted_unconfirmed',true,'投递','待初筛'],
  ['submitted',true,null,'已投递'],
  ['not_started',false,'投递','待初筛'],
 ]){
  const h=await page(0,{status,active});try{
   assert.equal(h.w.document.querySelector('a[data-jobs-id]')?.textContent || null,label);
   assert(!h.w.document.querySelector('tbody').textContent.includes('未投递'));
   assert(!h.w.document.querySelector('tbody').textContent.includes('标记已投递'));
   assert([...h.w.document.querySelectorAll('td')].some(cell => cell.textContent.includes(state)));
   if(label)assert.equal(h.w.document.querySelector('a[data-jobs-id]').href,'https://example.test/job');
   assert.deepEqual(h.errors,[]);
  }finally{h.dom.window.close();}
 }
});

const lastJobs=h=>new URL(h.requests.filter(p=>p.startsWith('/api/jobs?')&&p.includes('page_size=50')).at(-1),'https://fixture.test').searchParams;
const toggle=h=>[...h.w.document.querySelectorAll('button[aria-pressed]')].filter(n=>['地区','公司'].includes(n.textContent));
test('region and employer switches have independent defaults and remember both kinds',async()=>{
 const h=await page();try{
  assert.equal(lastJobs(h).get('status'),'unsubmitted');
  assert.equal(lastJobs(h).get('region'),'focus_remote');
  assert.equal(lastJobs(h).get('company_newgrad'),'');
  assert.equal(lastJobs(h).get('company_internship'),'1');
  assert.equal(toggle(h).length,2);
  toggle(h)[1].click();await until(()=>lastJobs(h).get('company_newgrad')==='1');
  assert.equal(lastJobs(h).get('region'),'focus_remote');
  toggle(h)[0].click();await until(()=>lastJobs(h).get('region')==='');
  assert.equal(lastJobs(h).get('company_newgrad'),'1');
  const intern=[...h.w.document.querySelectorAll('[role="tab"],button')].find(n=>n.textContent==='实习');
  assert(intern);intern.click();await until(()=>lastJobs(h).get('kind')==='internship');
  assert.equal(lastJobs(h).get('company_internship'),'1');
  await until(()=>toggle(h).length===2);
  toggle(h)[1].click();await until(()=>lastJobs(h).get('company_internship')==='');
  assert.equal(lastJobs(h).get('company_newgrad'),'');
  assert.equal(lastJobs(h).get('region'),'focus_remote');
  [...h.w.document.querySelectorAll('button')].find(n=>n.textContent==='全职').click();
  await until(()=>lastJobs(h).get('kind')==='newgrad');
  assert.equal(lastJobs(h).get('region'),'');
  assert.equal(lastJobs(h).get('company_newgrad'),'1');
  assert(!h.w.document.body.textContent.includes('精简筛选'));
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});
test('legacy preferences preserve explicit exclusions and strict regions during migration',async()=>{
 const h=await page(0,{}, {'radar-filters-shared-v5':{region:'ca',compact:false,intern_companies:'1',exclude_companies:'Custom Employer',status:'submitted'}});
 try{
  const p=lastJobs(h);assert.equal(p.get('region'),'ca');assert.equal(p.get('exclude_companies'),'Custom Employer');
  assert.equal(p.get('status'),'unsubmitted');assert.equal(p.get('company_newgrad'),'');assert.equal(p.get('company_internship'),'1');
  assert(!p.has('compact'));assert(!p.has('intern_companies'));
  assert(!h.w.document.body.textContent.includes('仅加州，不使用公司豁免'));
  assert(!h.requests.some(p=>p.startsWith('/api/filter-counts')));
 }finally{h.dom.window.close();}
});


test('job submission badges and application progress stay on their respective pages',async()=>{
 const app={kind:'newgrad',id:'app-1',job_id:'fixture-1',version:1,jobTitle:'Engineer',companyName:'Fixture Employer',jobLink:'https://example.test/job',companyLink:'',date:new Date().toISOString(),profileName:'Newgrad',status:'interview',progress:{label:'Interview · Round 2',display_stage:'interview',stage:'interview',version:1}};
 const h=await page(0,{status:'submitted'}, {}, [app]);
 try {
  await tick();
  const badge=h.w.document.querySelector('tbody .text-success');
  assert(badge?.textContent.includes('已投递'));
  assert(!h.w.document.body.textContent.includes('面试 · 第 2 轮'));
  assert(!h.requests.includes('/api/manage/state'),'the jobs page does not load application history');
  assert(h.w.document.body.textContent.includes('今日 2 · 本周 5'));
  h.w.location.hash='/applications';
  await until(()=>h.w.document.body.textContent.includes('面试 · 第 2 轮'));
  await menuAction(h,'更新进展');
  await until(()=>h.w.document.body.textContent.includes('投递进展'));
  assert(h.requests.some(url=>url.startsWith('/api/manage/progress?')));
  assert.deepEqual(h.errors,[]);
 } finally {h.dom.window.close();}
});

test('Applied displays the server submission label separately from recruiting progress',async()=>{
 const applications=['已尝试提交','网站已确认','提交后报错，待核实'].map((label,i)=>({kind:'newgrad',id:'app-'+i,jobTitle:'Engineer '+i,companyName:'Fixture',jobLink:'https://example.test/'+i,companyLink:'',date:'2026-10-10T12:00:00Z',profileName:'Synthetic',status:'applied',submission:{label,submitted:true,confirmed:i===1,attempted_at:1,confirmed_at:i===1?2:null,error:i===2?'Synthetic validation':null}}));
 const h=await page(0,{}, {}, applications);
 try {
  h.w.location.hash='/applications';
  await until(()=>h.w.document.body.textContent.includes('Engineer 0'));
  for(const row of applications)assert(h.w.document.querySelector('tbody').textContent.includes(row.submission.label));
  assert(h.w.document.body.textContent.includes('等待回复'));
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});


test('opening jobs makes no tracking requests; row marking and undo still work',async()=>{
 const h=await page();try{
  await tick();const before=h.requests.length,link=h.w.document.querySelector('a[data-jobs-id]');
  for(const [type,button] of [['click',0],['auxclick',1]]){
   link.addEventListener(type,e=>e.preventDefault(),{once:true});
   link.dispatchEvent(new h.w.MouseEvent(type,{bubbles:true,cancelable:true,button}));
  }
  await tick();assert.equal(h.requests.length,before);
  assert(!h.w.document.querySelector('[aria-label="刚打开的岗位"]'));
  await menuAction(h,'标记已投递');
  await until(()=>h.w.document.querySelector('tbody .text-success'));
  assert.equal(h.actions.length,1);assert.equal(h.actions[0].action,'submitted');
  await menuAction(h,'撤销');await until(()=>h.w.document.querySelector('a[data-jobs-id]'));
  assert.deepEqual(h.actions.map(p=>[p.action,p.version]),[['submitted',0],['undo_submitted',1]]);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('failed manual marking remains retryable with the same idempotency key',async()=>{
 const h=await page(1);try{
  await menuAction(h,'标记已投递');await until(()=>h.w.document.querySelector('[role="alert"]')?.textContent.includes('Synthetic action failure'));
  await menuAction(h,'标记已投递');await until(()=>h.actions.length===2&&h.w.document.querySelector('tbody .text-success'));
  assert.equal(h.actions[0].key,h.actions[1].key);assert.equal(h.actions[1].version,0);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('simplified filters preserve exclusions and clear retired hidden criteria',async()=>{
 const h=await page(0,{}, {'radar-filters-shared-v7':{exclude_companies:'TikTok',company_newgrad:'1',region:'focus_remote',status:'submitted',group:'faang',screening:'keep',category:'engineering',location:'CA'}});
 try{
  const p=lastJobs(h);assert.equal(p.get('exclude_companies'),'TikTok');assert.equal(p.get('company_newgrad'),'1');
  for(const name of ['group','screening','category','location','roles','exclude_titles'])assert(!p.has(name));
  assert.equal(p.get('status'),'unsubmitted');
  const button=label=>[...h.w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
  assert(!button('仅看未投递'));
  assert(!button('筛选设置'));assert(!h.w.document.body.textContent.includes('FAANG+ 或精选公司'));
  await toolbarAction(h,'排除公司');await until(()=>h.w.document.querySelector('[role="dialog"] input'));
  assert.equal(h.w.document.querySelector('[role="dialog"] input').value,'TikTok');
  button('清空').click();button('取消').click();await until(()=>!h.w.document.querySelector('[role="dialog"]'));
  assert.equal(lastJobs(h).get('exclude_companies'),'TikTok');
  await toolbarAction(h,'排除公司');await until(()=>h.w.document.querySelector('[role="dialog"] input'));
  button('清空').click();await until(()=>h.w.document.querySelector('[role="dialog"] input').value==='');button('保存').click();await until(()=>lastJobs(h).get('exclude_companies')==='');
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('list dates always show first collection while publication stays in details',async()=>{
 const job={added_at:new Date(2026,9,10,12).getTime()/1000,posted_at:new Date(2026,7,6,12).getTime()/1000};
 for(const added_date of ['', '2026-10-09/2026-10-11']){
  const h=await page(0,job,{'radar-filters-shared-v9':{added_date}});
  try{
   assert([...h.w.document.querySelectorAll('th')].some(n=>n.textContent==='收录日期'));
   assert([...h.w.document.querySelectorAll('.job-date')].every(n=>n.textContent==='10/10'));
   assert(!h.w.document.querySelector('.job-list').textContent.includes('8/6'));
   await menuAction(h,'查看详情');
   await until(()=>h.w.document.querySelector('[role="dialog"] dl'));
   const dates=[...h.w.document.querySelectorAll('[role="dialog"] dt')];
   assert.equal(dates.find(n=>n.textContent==='收录日期').nextElementSibling.textContent,'10/10');
   assert.equal(dates.find(n=>n.textContent==='发布日期').nextElementSibling.textContent,'8/6');
   assert.deepEqual(h.errors,[]);
  }finally{h.dom.window.close();}
 }
});

test('date shortcuts and same-grid cross-month selection work',async()=>{
 const h=await page(0,{}, {'radar-filters-shared-v8':{added_date:'2026-10-09/2026-10-09'}});
 try {
  const trigger=()=>h.w.document.querySelector('button[aria-label^="收录时间："]');
  const button=label=>[...h.w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
  trigger().click();await until(()=>button('近 7 天'));
  button('今天').click();await until(()=>trigger().textContent.includes('今天'));
  assert.equal(Number(lastJobs(h).get('added_before'))-Number(lastJobs(h).get('added_since')),86400);
  trigger().click();await until(()=>button('近 7 天'));button('近 7 天').click();
  await until(()=>trigger().textContent.includes('近 7 天'));
  assert.equal(Number(lastJobs(h).get('added_before'))-Number(lastJobs(h).get('added_since')),7*86400);
  trigger().click();await until(()=>button('全部时间'));button('全部时间').click();
  await until(()=>!lastJobs(h).has('added_since'));
  trigger().click();
  const dateButton=(month,day)=>[...h.w.document.querySelectorAll('button,[role="button"]')].find(b=>b.getAttribute('aria-label')?.includes(`2026年${month}月${day}日`));
  await until(()=>dateButton(9,29));assert(!dateButton(9,29).disabled);
  assert(dateButton(11,1).disabled,'future padding dates remain disabled');
  dateButton(9,29).click();
  await tick();assert(dateButton(10,2),'October stays visible after selecting September 29');
  dateButton(10,2).click();await until(()=>trigger().textContent.includes('09/29 – 10/02'));
  assert.equal(new h.w.Date(Number(lastJobs(h).get('added_since'))*1000).getDate(),29);
  assert.equal(new h.w.Date(Number(lastJobs(h).get('added_before'))*1000).getDate(),3);
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});


test('a visible next-month date can finish a range without navigating',async()=>{
 const h=await page(0,{}, {'radar-filters-shared-v8':{added_date:'2026-09-29/2026-09-29'}});
 try {
  const trigger=()=>h.w.document.querySelector('button[aria-label^="收录时间："]');
  trigger().click();
  const day=(month,date)=>[...h.w.document.querySelectorAll('button,[role="button"]')].find(b=>b.getAttribute('aria-label')?.includes(`2026年${month}月${date}日`));
  await until(()=>day(9,28));day(9,28).click();await tick();
  assert(!day(10,2).disabled);day(10,2).click();
  await until(()=>trigger().textContent.includes('09/28 – 10/02'));
  assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});


test('jobs always requests unsubmitted across kind changes while trash remains unrestricted',async()=>{
 const h=await page(0,{}, {'radar-filters-shared-v9':{status:'recent',added_date:'last7',exclude_companies:'Preserved',text:'discard'}});
 try {
  assert.equal(lastJobs(h).get('status'),'unsubmitted');
  assert.equal(lastJobs(h).get('text'),'');
  assert(!h.w.document.body.textContent.includes('仅看未投递'));
  const button=label=>[...h.w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
  button('实习').click();await until(()=>lastJobs(h).get('kind')==='internship');
  assert.equal(lastJobs(h).get('status'),'unsubmitted');
  assert.equal(lastJobs(h).get('exclude_companies'),'Preserved');
  assert(!('status' in JSON.parse(h.w.localStorage.getItem('radar-filters-shared-v9'))));
  button('已删除').click();await until(()=>lastJobs(h).get('view')==='trash');
  assert.equal(lastJobs(h).get('status'),'');
  const jobsRequests=h.requests.filter(p=>p.startsWith('/api/jobs?')).map(p=>new URL(p,'https://fixture.test').searchParams).filter(p=>p.get('view')==='jobs');
  assert(jobsRequests.every(p=>p.get('status')==='unsubmitted'));
  assert.deepEqual(h.errors,[]);
 } finally {h.dom.window.close();}
});
