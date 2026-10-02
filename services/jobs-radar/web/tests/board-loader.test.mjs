import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {transform} from 'esbuild';
const source=await fs.readFile(new URL('../src/board-loader.ts',import.meta.url),'utf8');
const {code}=await transform(source,{loader:'ts',format:'esm'});
const {createBoardLoader}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const params=new URLSearchParams('kind=newgrad&page=1&page_size=50&view=jobs&status=recent');
test('page and kind changes share in-flight totals; mutations and TTL force fresh statistics',async()=>{
 const calls=[];let now=0;
 const loader=createBoardLoader(async(path,options)=>{calls.push({path,options});return {path};},()=>now);
 await Promise.all([loader.jobs(params),loader.counts(params)]);assert.equal(calls.length,2);
 const next=new URLSearchParams(params);next.set('page','2');next.set('kind','internship');
 await Promise.all([loader.jobs(next),loader.counts(next)]);assert.equal(calls.length,3,'only the next list needs a new request');
 assert(calls[0].options.signal.aborted);
 loader.invalidate();await Promise.all([loader.counts(next)]);assert.equal(calls.length,4);
 now=60001;await Promise.all([loader.counts(next)]);assert.equal(calls.length,5);
});
test('statistics errors do not block the list or poison subsequent retries',async()=>{
 let fail=true,calls=0;
 const loader=createBoardLoader(async path=>{if(path.startsWith('/api/jobs'))return {jobs:['Ready']};calls++;if(fail)throw Error('Stats offline');return {total:9};});
 const stats=loader.counts(params);await assert.rejects(stats,/Stats offline/);
 assert.deepEqual(await loader.jobs(params),{jobs:['Ready']});
 fail=false;assert.deepEqual(await loader.counts(params),{total:9});assert.equal(calls,2);
});
test('slow totals are deduplicated and do not delay the next list',async()=>{
 let release,calls=0;const pending=new Promise(r=>release=r);
 const loader=createBoardLoader(async path=>{if(path.startsWith('/api/jobs'))return {jobs:['Ready']};calls++;return pending;});
 const one=loader.counts(params),two=loader.counts(new URLSearchParams(params));
 assert.equal(one,two);assert.equal(calls,1);
 assert.deepEqual(await loader.jobs(params),{jobs:['Ready']});release({total:8});await one;
});
