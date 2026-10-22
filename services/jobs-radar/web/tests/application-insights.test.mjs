import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const output=await build({entryPoints:[new URL('../src/manage/application-insights.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {applicationInsights}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const now=Date.parse('2026-10-22T12:00:00Z'),day=86400000;
const row=(age,stage='applied',progress={},sources=[])=>({date:new Date(now-age*day).toISOString(),status:stage,progress:{stage,...progress},job:{sources}});
test('waiting ages exclude known outcomes and advancement uses recorded evidence',()=>{
 const data=applicationInsights([
  row(2),row(8),row(20),row(40),row(8,'rejected'),row(10,'assessment',{highest_stage:'no_answer',assessment_type:'automatic'}),
  row(11,'rejected',{highest_stage:'interview',ever_advanced:true}),row(-1),{...row(1),date:'invalid'}
 ],now);
 assert.equal(data.count,9);assert.equal(data.advanced,1);assert.deepEqual(data.waiting,[1,1,1,1]);assert.equal(data.unknownDates,2);
});
test('sources use explicit records, count multisource discoveries once and retain unknown provenance',()=>{
 const data=applicationInsights([row(1,'interview',{highest_stage:'interview'},['simplify','jobright','simplify']),row(2,'applied',{},['jobright','simplify']),row(3)],now);
 assert.equal(data.sources.reduce((n,s)=>n+s.count,0),3);
 assert.deepEqual(data.sources.find(s=>s.source==='jobright + simplify'),{source:'jobright + simplify',count:2,advanced:1,waiting:1});
 assert.equal(data.sources.find(s=>s.source==='来源未记录').count,1);
 assert.equal(data.earliest,now-3*day);assert.equal(data.latest,now-day);
});
