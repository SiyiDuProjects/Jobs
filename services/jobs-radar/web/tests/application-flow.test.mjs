import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/manage/application-flow.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {applicationFlow}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const row=(id,path)=>({id,status:path.at(-1).stage,jobTitle:id,companyName:id,progress:{chart_path:path,assessment_type:'screened',ever_advanced:path.some(p=>['assessment','interview','phone_screen','offer'].includes(p.stage))}});
test('flow conserves counts and keeps rejection under highest interview stage',()=>{
 const rows=[...Array.from({length:361},(_,i)=>row('waiting-'+i,[{stage:'no_answer'}])),
  ...Array.from({length:10},(_,i)=>row('oa-'+i,[{stage:'assessment'}])),
  row('kikoff',[{stage:'interview',round:1}]),row('aven',[{stage:'phone_screen'},{stage:'rejected'}])];
 const graph=applicationFlow(rows), root=graph.nodes.find(n=>n.parent===null);
 assert.equal(root.count,373);
 assert.equal(graph.links.filter(l=>l.source===root).reduce((sum,l)=>sum+l.target.count,0),373);
 const reject=graph.nodes.find(n=>n.stage==='rejected');
 assert.equal(graph.nodes.find(n=>n.id===reject.parent).label,'Interview');
 assert.equal(graph.nodes.find(n=>n.stage==='interview').count,2);
 assert.deepEqual(reject.ids,['aven']);
 assert.equal(graph.nodes.find(n=>n.stage==='interview').parent,'applications');
 for(const node of graph.nodes)assert(node.y>=0&&node.height>0&&Number.isFinite(node.x));
 for(const link of graph.links)assert(!/NaN|Infinity/.test(link.path));
});
test('each application counts only at its highest stage, independent of rounds',()=>{
 const graph=applicationFlow([row('a',[{stage:'assessment'},{stage:'interview',round:1},{stage:'interview',round:2}]),row('b',[{stage:'assessment'}])]);
 assert.equal(graph.nodes.find(n=>n.stage==='assessment').count,1);
 assert.equal(graph.nodes.find(n=>n.stage==='interview').count,1);
 assert.equal(graph.nodes.filter(n=>n.stage==='interview').length,1);
 assert.deepEqual(applicationFlow([]).nodes,[]);
});
test('offer and rejected OA retain their highest stage without invented intermediate stages',()=>{
 const graph=applicationFlow([row('offer',[{stage:'assessment'},{stage:'interview',round:2},{stage:'offer'},{stage:'offer_declined'}]),row('rejected-oa',[{stage:'assessment'},{stage:'rejected'}])]);
 assert.equal(graph.nodes.some(n=>n.stage==='interview'),false);
 assert.equal(graph.nodes.find(n=>n.stage==='assessment').count,1);
 assert.equal(graph.nodes.find(n=>n.stage==='offer').count,1);
 assert.deepEqual(graph.nodes.find(n=>n.stage==='rejected').ids,['rejected-oa']);
});
test('server-classified automatic and unclassified OA remain in No Answer',()=>{
 const rows=[...Array.from({length:361},(_,i)=>row('waiting-'+i,[{stage:'no_answer'}])),
  ...Array.from({length:9},(_,i)=>{const r=row('unqualified-'+i,[{stage:'no_answer'}]);r.progress.assessment_type=i?'unknown':'automatic';return r;}),
  row('whatnot',[{stage:'assessment'}]),row('kikoff',[{stage:'interview',round:1}]),row('aven',[{stage:'phone_screen'},{stage:'rejected'}])];
 const graph=applicationFlow(rows);
 assert.equal(graph.nodes.find(n=>n.stage==='applications').count,373);
 assert.equal(graph.nodes.find(n=>n.stage==='no_answer').count,370);
 assert.equal(graph.nodes.find(n=>n.stage==='assessment').count,1);
 assert.deepEqual(graph.nodes.find(n=>n.stage==='assessment').ids,['whatnot']);
});
