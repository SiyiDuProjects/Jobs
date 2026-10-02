import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('..',import.meta.url));
const bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {Profile} from './src/manage/Profile';import {store} from './src/manage/store';import {defaultProfile,blankEducation} from './src/manage/model';globalThis.fixture={store,defaultProfile,blankEducation,render:()=>createRoot(document.getElementById('root')).render(<Profile/>)};`,resolveDir:dir,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles[0].text;
const tick=()=>new Promise(r=>setTimeout(r,35));
async function until(p){for(let i=0;i<70&&!p();i++)await tick();assert(p(),'condition did not become true');}
async function fixture(){
 const errors=[],writes=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',e=>errors.push(String(e)));
 const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://fixture.invalid/#/profile',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.structuredClone=structuredClone;w.AbortSignal=AbortSignal;w.CSS={supports:()=>false,escape:v=>String(v)};w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};w.Element.prototype.getAnimations=()=>[];
 w.eval(bundle);const {store,defaultProfile,blankEducation}=w.fixture;
 const profile=structuredClone(defaultProfile);profile.profileName='Newgrad';profile.educationData=[{...blankEducation,school:'Example University',endDate:'2027-05',currentlyAttending:true}];
 const record={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',last_sync:'v1',profile};let fail=false;
 store.state={...store.state,loading:false,authenticated:true,current:record,profiles:[{id:record.id,profileName:'Newgrad'}]};
 w.TextEncoder=TextEncoder;
 w.fetch=async(url,init)=>{assert(url.startsWith('/api/manage/profiles'));const req=init.body?JSON.parse(init.body):{};let value,status=200;if(init.method==='PUT'){writes.push({id:record.id,...req});if(fail){status=409;value={error:'Profile version conflict'};}else value={id:record.id,last_sync:'v'+(writes.length+1)};}else value=[{id:record.id,profileName:'Newgrad'}];return{ok:status===200,status,json:async()=>value};};
 w.fixture.render();await until(()=>w.document.body.textContent.includes('编辑申请资料'));
 return{w,dom,errors,writes,store,fail:()=>{fail=true;}};
}
async function click(h,text){const b=[...h.w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text);assert(b,'button '+text);b.click();await tick();await tick();}
function input(h,label){const l=[...h.w.document.querySelectorAll('label')].find(l=>l.textContent.replace('*','').trim()===label);return l&&h.w.document.getElementById(l.htmlFor);}
async function fill(h,label,value){const i=input(h,label);assert(i,'input '+label);const proto=i.tagName==='TEXTAREA'?h.w.HTMLTextAreaElement.prototype:h.w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(i,value);i.dispatchEvent(new h.w.Event('input',{bubbles:true}));await tick();}
async function choose(h,label,text){const b=h.w.document.querySelector(`button[aria-label="${label}"]`)||[...h.w.document.querySelectorAll('button')].find(b=>b.getAttribute('aria-labelledby')?.split(' ').some(id=>h.w.document.getElementById(id)?.textContent===label));assert(b,'select '+label);b.click();await tick();const item=[...h.w.document.querySelectorAll('[role="option"]')].find(x=>x.textContent.trim()===text);assert(item,'option '+text);item.click();await tick();await tick();}

test('new details save per profile, preserve old fields and distinguish false from unknown',async()=>{const h=await fixture();try{
 const previous=structuredClone(h.store.state.current.profile);await click(h,'编辑申请资料');
 await fill(h,'最早到岗日期','2027-06-01');await fill(h,'签证／身份类型','User confirmed status');await fill(h,'AI 补充说明','Confirmed location preferences.');
 await choose(h,'现在需要赞助','否');await choose(h,'未来需要赞助','是');await choose(h,'未来需要赞助','未填写');
 await click(h,'Save');await until(()=>h.writes.length===1&&!h.w.document.querySelector('[role="dialog"]'));
 const saved=h.writes[0];assert.equal(saved.id,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');assert.equal(saved.expected_sync,'v1');
 assert.deepEqual(saved.profile.applicationData,{earliestStartDate:'2027-06-01',visaStatus:'User confirmed status',aiNotes:'Confirmed location preferences.',sponsorshipNow:false});
 const {applicationData,...old}=saved.profile;assert.deepEqual(old,previous);assert.deepEqual(h.errors,[]);
 await click(h,'编辑申请资料');assert.equal(input(h,'最早到岗日期').value,'2027-06-01');
}finally{h.dom.window.close();}});

test('education retains month while attending and keeps optional exact day consistent',async()=>{const h=await fixture();try{
 await click(h,'Edit');assert.equal(input(h,'Graduation month').value,'2027-05');
 await fill(h,'Exact graduation date (optional)','2027-06-17');assert.equal(input(h,'Graduation month').value,'2027-06');
 await fill(h,'Exact graduation date (optional)','');assert.equal(input(h,'Graduation month').value,'2027-06');
 await fill(h,'Exact graduation date (optional)','2027-06-18');await fill(h,'Graduation month','2027-07');assert.equal(input(h,'Exact graduation date (optional)').value,'');
 await fill(h,'Exact graduation date (optional)','2027-07-19');await click(h,'Save');await until(()=>h.writes.length===1);
 const e=h.writes[0].profile.educationData[0];assert.equal(e.endDate,'2027-07');assert.equal(e.graduationDate,'2027-07-19');assert.equal(e.currentlyAttending,true);assert.deepEqual(h.errors,[]);
}finally{h.dom.window.close();}});

test('work preferences preserve explicit false and remain editable per profile',async()=>{const h=await fixture();try{
 await click(h,'编辑申请资料');
 await choose(h,'愿意搬迁','是');await choose(h,'愿意到办公室工作','是');
 await choose(h,'愿意出差或为面试出行','是');await choose(h,'存在需披露的关系人任职','否');
 await click(h,'Save');await until(()=>h.writes.length===1&&!h.w.document.querySelector('[role="dialog"]'));
 assert.deepEqual(h.writes[0].profile.applicationData,{willingToRelocate:true,willingToWorkOnsite:true,willingToTravel:true,hasRelatedPeopleAtWork:false});
 await click(h,'编辑申请资料');await choose(h,'愿意搬迁','未填写');
 await click(h,'Save');await until(()=>h.writes.length===2);
 assert.equal(h.writes[1].profile.applicationData.willingToRelocate,undefined);
 assert.equal(h.writes[1].profile.applicationData.hasRelatedPeopleAtWork,false);assert.deepEqual(h.errors,[]);
}finally{h.dom.window.close();}});

test('weekly hours stay unset until chosen and can be saved, reopened and cleared without changing dates or notes',async()=>{const h=await fixture();try{
 assert.equal(h.store.state.current.profile.applicationData?.weeklyHours,undefined);
 await click(h,'编辑申请资料');await fill(h,'最早到岗日期','2027-06-01');
 await fill(h,'AI 补充说明','Available for an internship June 1 through August 31, 2027.');
 await choose(h,'每周可工作时长','30 小时／周');await click(h,'Save');
 await until(()=>h.writes.length===1&&!h.w.document.querySelector('[role="dialog"]'));
 assert.equal(h.writes[0].profile.applicationData.weeklyHours,'30');
 assert(h.w.document.body.textContent.includes('30 小时／周'));
 await click(h,'编辑申请资料');await choose(h,'每周可工作时长','未填写');await click(h,'Save');
 await until(()=>h.writes.length===2&&!h.w.document.querySelector('[role="dialog"]'));
 assert.equal(h.writes[1].profile.applicationData.weeklyHours,undefined);
 assert.equal(h.writes[1].profile.applicationData.earliestStartDate,'2027-06-01');
 assert.equal(h.writes[1].profile.applicationData.aiNotes,h.writes[0].profile.applicationData.aiNotes);
 assert.deepEqual(h.errors,[]);
}finally{h.dom.window.close();}});

test('salary requires unambiguous units and failed save preserves the draft',async()=>{const h=await fixture();try{
 await click(h,'编辑申请资料');await choose(h,'薪资要求','指定金额或范围');await fill(h,'期望金额／下限','90000');await click(h,'Save');
 assert.equal(h.writes.length,0);assert.match(h.w.document.body.textContent,/三位币种代码/);
 await fill(h,'币种（如 USD）','usd');await choose(h,'计薪方式','年基本工资');h.fail();await click(h,'Save');
 await until(()=>h.w.document.body.textContent.includes('Profile version conflict'));assert(h.w.document.querySelector('[role="dialog"]'));assert.equal(input(h,'期望金额／下限').value,'90000');assert.equal(h.writes[0].profile.applicationData.salaryCurrency,'USD');assert.deepEqual(h.errors,[]);
}finally{h.dom.window.close();}});
