import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../src/manage/model.ts',import.meta.url));
const output=(await build({entryPoints:[entry],bundle:true,write:false,format:'iife',globalName:'m',platform:'node'})).outputFiles[0].text;
const model=vm.runInNewContext(output+';m');

const normal=v=>JSON.parse(JSON.stringify(v));
const row={jobTitle:'Engineer',jobLink:'https://example.com/1',companyName:'Example',companyLink:'',date:'2026-09-18T00:00:00Z',status:'applied',profileName:'Newgrad'};
test('application lists cannot be sent through whole-document synchronization',()=>{assert.equal(model.allowed('appliedList'),false);});
test('same record conflict and settings conflict never overwrite the remote document',()=>{assert.throws(()=>model.merge('appliedList',[row],[{...row,status:'offer'}],[{...row,status:'rejected'}]));assert.throws(()=>model.merge('settings',{daily:1},{daily:2},{daily:3}));});
test('duplicate application identities are independently editable',()=>{const rows=[row,row],ids=model.appRows(rows);assert.notEqual(ids[0].key,ids[1].key);const changed=model.changeApplication(rows,ids[1].key,{status:'screen'});assert.equal(changed[0].status,'applied');assert.equal(changed[1].status,'screen');});
test('CSV export round trips quotes, commas and newlines',()=>{const value={...row,jobTitle:'Engineer, "ML"\nResearch'};const csv=model.parseCSV(model.exportCSV([value]));assert.equal(csv[1][0],value.jobTitle);assert.throws(()=>model.parseCSV('"unfinished'));});
test('date buckets retain day week and month thresholds',()=>{assert.equal(model.chartData([row],'2026-09-01','2026-09-18').bucket,'day');assert.equal(model.chartData([row],'2026-01-01','2026-09-18').bucket,'week');assert.equal(model.chartData([row],'2020-01-01','2026-09-18').bucket,'month');assert.equal(model.chartData([row],'2026-09-01','2026-09-18').data.reduce((sum,x)=>sum+x.count,0),1);});
test('original answer keyword extraction and credential exclusion remain intact',()=>{assert.deepEqual(normal(model.questionKeywords('Why do you want to work with us?')),['why','you','want','work','with']);for(const key of ['autofillAccount','password','lastSyncProfile','profile','apiKey'])assert.equal(model.allowed(key),false);assert.equal(model.allowed('jobsResponses:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'),true);assert.equal(model.defaultSettings.autofillSettings.autoSubmit,false);assert.equal(model.defaultSettings.autofillSettings.autoClickNextPage,false);});
