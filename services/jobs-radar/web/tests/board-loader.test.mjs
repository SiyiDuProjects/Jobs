import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {transform} from 'esbuild';
const source=await fs.readFile(new URL('../src/board-loader.ts',import.meta.url),'utf8');
const {code}=await transform(source,{loader:'ts',format:'esm'});
const {createBoardLoader}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const params=new URLSearchParams('kind=newgrad&page=1&page_size=50&view=jobs&status=recent');
test('new filters abort obsolete requests and cancellation aborts the active list',async()=>{
 const calls=[];
 const loader=createBoardLoader(async(path,options)=>{calls.push({path,options});return {path};});
 await loader.jobs(params);
 const next=new URLSearchParams(params);next.set('page','2');
 await loader.jobs(next);
 assert.equal(calls.length,2);assert(calls[0].options.signal.aborted);assert(!calls[1].options.signal.aborted);
 assert(calls[1].path.includes('page=2'));loader.cancel();assert(calls[1].options.signal.aborted);
});
