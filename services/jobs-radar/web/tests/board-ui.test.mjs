import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
const entry=new URL('../src/main.tsx',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
const bundle=(await build({entryPoints:[entry],bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles[0].text;
const tick=()=>new Promise(r=>setTimeout(r,20));
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick();}assert(check(),'Board did not reach expected state');}
async function page(statsFail=false,jobState={}){
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const dom=new JSDOM('<body><div id="root"></div></body>',{url:'https://fixture.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window,requests=[];
 w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.CSS={escape:value=>String(value).replace(/[^\w-]/g,c=>'\\'+c),supports:()=>false};
 w.fetch=async(path)=>{
  const u=new URL(path,w.location.href);requests.push(u.pathname+u.search);let value;
  if(u.pathname==='/api/session')value={authenticated:true};
  else if(u.pathname==='/api/extension/status')value={pending:0};
  else if(u.pathname==='/api/filter-counts'){if(statsFail)throw Error('Synthetic statistics failure');value={total:100,newgrad:{total:100,submitted:0},internship:{total:0,submitted:0}};}
  else if(u.pathname==='/api/jobs')value={total:100,groups:{other:100},recent_opened:[],application_counts:{submitted:0},source_health:[],jobs:[{
   id:'fixture-'+u.searchParams.get('page'),company:'Fixture Employer',title:'Fixture Engineer Page '+u.searchParams.get('page'),
   kind:'newgrad',locations:['California'],sources:['simplify'],apply_url:'https://example.test/job',status:'not_started',
   review:null,screening:'pending',review_version:0,application_version:0,fingerprint:'fixture',group:'other',active:true,posted_at:1,added_at:1,...jobState
  }]};
  else throw Error('Unexpected URL '+path);
  return {ok:true,json:async()=>structuredClone(value)};
 };
 w.eval(bundle);
 try{await until(()=>w.document.body.textContent.includes('Fixture Engineer Page 1'));}
 catch(error){const details=JSON.stringify({errors,requests,text:w.document.body.textContent});w.close();throw Error(error.message+' '+details);}
 return {w,dom,requests,errors};
}
test('board keeps jobs usable when filter counts fail without requesting season totals',async()=>{
 const h=await page(true);try{assert(h.w.document.body.textContent.includes('Fixture Employer'));assert(h.w.document.body.textContent.includes('数量暂时不可用'));assert(!h.w.document.body.textContent.includes('申请季累计'));assert(!h.requests.some(path=>path.startsWith('/api/application-overview')));assert.deepEqual(h.errors,[]);}finally{h.dom.window.close();}
});
test('actual board pagination issues only a list request while fresh totals are shared',async()=>{
 const h=await page();try{
  await tick();const before=h.requests.length;
  [...h.w.document.querySelectorAll('button')].find(b=>b.textContent==='下一页').click();
  await until(()=>h.w.document.body.textContent.includes('Fixture Engineer Page 2'));
  assert.equal(h.requests.length-before,1);assert(h.requests.at(-1).startsWith('/api/jobs?'));assert.deepEqual(h.errors,[]);
 }finally{h.dom.window.close();}
});

test('all unsubmitted jobs retain the single Apply action and unsubmitted label',async()=>{
 for(const [status,active,label,state] of [
  ['not_started',true,'申请','未投递'],
  ['in_progress',true,'申请','未投递'],
  ['needs_input',true,'申请','未投递'],
  ['submitted_unconfirmed',true,'申请','未投递'],
  ['submitted',true,'查看岗位','已投递'],
  ['not_started',false,'申请','未投递'],
 ]){
  const h=await page(false,{status,active});try{
   assert.equal(h.w.document.querySelector('a[data-jobs-id]').textContent,label+' ↗');
   assert(h.w.document.querySelector('.application-status').textContent.includes(state));
   assert.equal(h.w.document.querySelector('a[data-jobs-id]').href,'https://example.test/job');
   assert.deepEqual(h.errors,[]);
  }finally{h.dom.window.close();}
 }
});
