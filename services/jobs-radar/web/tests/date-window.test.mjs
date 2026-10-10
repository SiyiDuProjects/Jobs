import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
process.env.TZ='America/Los_Angeles';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/date-window.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {addedRange,normalizeDateWindow,dateWindowLabel}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test('today and last seven local days retain inclusive boundaries across daylight saving',t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-03-09T19:00:00Z')});
 const day=addedRange('2026-03-08');assert.equal(Number(day.added_before)-Number(day.added_since),23*3600);
 const week=addedRange('last7');assert.equal(new Date(Number(week.added_since)*1000).toISOString(),'2026-03-03T08:00:00.000Z');
 assert.equal(new Date(Number(week.added_before)*1000).toISOString(),'2026-03-10T07:00:00.000Z');
 assert.equal(normalizeDateWindow('today'),'today');assert.equal(normalizeDateWindow('last7'),'last7');
 assert.equal(dateWindowLabel('today'),'今天');assert.equal(dateWindowLabel('last7'),'近 7 天');
 t.mock.timers.tick(86400000);
 assert.equal(new Date(Number(addedRange('today').added_since)*1000).toISOString(),'2026-03-10T07:00:00.000Z');
});
test('compact labels retain the year for older and cross-year ranges',t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T19:00:00Z')});
 assert.equal(dateWindowLabel('2026-10-09/2026-10-09'),'10/09');
 assert.equal(dateWindowLabel('2026-09-29/2026-10-02'),'09/29 – 10/02');
 assert.equal(dateWindowLabel('2025-12-30/2026-01-02'),'2025/12/30 – 2026/01/02');
 assert.equal(normalizeDateWindow('2026-10-02/2026-09-29'),'');
 assert.deepEqual(addedRange(''),{});
});
