import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[new URL('../src/board-filters.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {readBoardFilters,saveBoardFilters,sharedFilterKey,kindFilterKey}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function storage(values={}) {const data=new Map(Object.entries(values).map(([k,v])=>[k,JSON.stringify(v)]));return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),data};}
const old='radar-filters-shared-v8';
test('migration preserves each kind and unions exclusions without overwriting either legacy record',()=>{
 const records={
  [old+':newgrad']:{region:'ca',company_newgrad:'1',added_date:'today',status:'recent',exclude_companies:'Acme, Example',text:'discard',page:4},
  [old+':internship']:{region:'',company_internship:'',added_date:'last7',status:'unsubmitted',exclude_companies:'acme, Intern Co'},
 };
 const s=storage(records),ng=readBoardFilters(s,'newgrad');
 assert.equal(ng.region,'ca');assert.equal(ng.company_newgrad,'1');assert.equal(ng.status,'unsubmitted');assert.equal(ng.added_date,'today');
 assert.equal(ng.text,'');assert.equal(ng.page,1);assert.equal(ng.exclude_companies.toLowerCase(),'acme, example, intern co');
 const intern=readBoardFilters(s,'internship');
 assert.equal(intern.region,'');assert.equal(intern.company_internship,'');assert.equal(intern.added_date,'today');assert.equal(intern.status,'unsubmitted');
 for(const [key,value]of Object.entries(records))assert.deepEqual(JSON.parse(s.getItem(key)),value);
 saveBoardFilters(s,'newgrad',{...ng,region:'',status:'unsubmitted',added_date:'last7',exclude_companies:'',text:'temporary',page:8});
 const after=readBoardFilters(s,'internship');
 assert.equal(after.region,'');assert.equal(after.status,'unsubmitted');assert.equal(after.added_date,'last7');assert.equal(after.exclude_companies,'');
 assert.deepEqual(Object.keys(JSON.parse(s.getItem(kindFilterKey('newgrad')))).sort(),['company_newgrad','region']);
 assert.deepEqual(Object.keys(JSON.parse(s.getItem(sharedFilterKey))).sort(),['added_date','exclude_companies','status']);
});
test('first migration follows current kind and persisted v9 choices always win on later reads',()=>{
 const s=storage({[old+':newgrad']:{added_date:'today'},[old+':internship']:{added_date:'last7',region:'ca_remote',company_internship:''}});
 assert.equal(readBoardFilters(s,'internship').added_date,'last7');assert.equal(readBoardFilters(s,'newgrad').added_date,'last7');
 s.setItem(old+':internship',JSON.stringify({added_date:'today'}));
 assert.equal(readBoardFilters(s,'newgrad').added_date,'last7');
});
test('malformed newest storage falls back to older explicit choices and ignores retired filters',()=>{
 const s=storage({'radar-filters-shared-v5':{compact:false,company_newgrad:'1',exclude_companies:'Legacy',status:'submitted',group:'hidden'}});
 s.setItem(old, '{broken');
 const f=readBoardFilters(s,'newgrad');assert.equal(f.region,'');assert.equal(f.company_newgrad,'1');assert.equal(f.exclude_companies,'Legacy');assert.equal(f.status,'unsubmitted');assert(!('group'in f));
});
