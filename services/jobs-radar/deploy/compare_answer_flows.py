"""Private real-provider comparison. Source DB is read-only; neither service nor Profiles change."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import zlib
from jobs_radar.answers import Answers
from jobs_radar.ai_answers import INSTRUCTIONS, PROMPT_VERSION
from jobs_radar.field_answers import fields_input
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.management import Management
from jobs_radar.saved_answers import normalized, timestamp, company_key, request_context
from jobs_radar.profile_text import ENUM_TEXT
from verify_reported_questions import CAPTURES, URLS, as_field, expected as reported_expected


def private_save(path, value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f: json.dump(value,f,ensure_ascii=False,indent=2)


def readable(field,value):
    options={v['value']:v['label'] for v in field['options']}
    if isinstance(value,list): return [options.get(v,v) for v in value]
    return options.get(value,value)


def gold_for(records, field, context, version):
    hits=[]
    for row in records:
        if not isinstance(row,dict) or row.get('origin')!='person' or normalized(row.get('question',''))!=normalized(field['question']): continue
        source=row.get('context') or {}
        if not isinstance(source,dict): continue
        if not context['companyKey'] or company_key(row.get('jobKey') or source.get('jobKey',''))!=context['companyKey']: continue
        date=timestamp(source.get('capturedAt'))
        if not date or date <= timestamp(version): continue
        if source.get('country','')!=context['country']: continue
        value=row.get('response')
        if field['options'] and value not in [o['label'] for o in field['options']]: continue
        hits.append((date,value))
    return max(hits,key=lambda v:v[0])[1] if hits else None


def answer_code_hash():
    root=Path(__file__).resolve().parents[1]/'jobs_radar'
    return hashlib.sha256(b''.join(p.name.encode()+p.read_bytes() for p in sorted(root.iterdir()) if p.is_file() and p.suffix in {'.py','.json'})).hexdigest()


async def run(args):
    source=sqlite3.connect(Path(args.database).resolve().as_uri()+'?mode=ro',uri=True)
    captures={ident:name for name,ident in CAPTURES.items()}
    pages=[(ident,json.loads(zlib.decompress(raw))) for ident,raw in source.execute('SELECT id,payload FROM corpus_pages ORDER BY created')]
    missing=set(CAPTURES.values())-{ident for ident,_ in pages}
    if missing: raise ValueError('Reported captures are missing')
    profiles=list(source.execute("SELECT id,last_sync,profile FROM owner_profiles WHERE deleted=0 AND json_extract(profile,'$.profileName') IN ('Intern','Newgrad')"))
    if len(profiles)!=2: raise ValueError('Exactly the two authorized Profiles are required')
    if getattr(args,'profile_name',None): profiles=[r for r in profiles if json.loads(r[2])['profileName']==args.profile_name]
    if args.reported_only: pages=[(ident,page) for ident,page in pages if ident in captures]
    baseline=json.loads(Path(args.reuse_legacy).read_text()) if getattr(args,'reuse_legacy',None) else None
    def identity(pid,version,page,field):
        return json.dumps([pid,version,page,field],sort_keys=True,ensure_ascii=False)
    reused={identity(r['profileId'],r['profileVersion'],r['corpusId'],r['field']):r['legacy'] for r in baseline['results']} if baseline else {}
    if baseline and not baseline.get('summary'): raise ValueError('Baseline comparison is not complete')
    resume=json.loads(Path(args.resume).read_text()) if getattr(args,'resume',None) else None
    if resume and (resume.get('answerCodeHash')!=answer_code_hash() or resume.get('promptHash')!=hashlib.sha256(INSTRUCTIONS.encode()).hexdigest()):
        raise ValueError('Completed answers must match this exact engine revision')
    completed={identity(r['profileId'],r['profileVersion'],r['corpusId'],r['field']):r for r in resume['results']} if resume else {}
    results=[];skipped=[];failures=[]; calls={'legacy':0,'simple':0}
    report={'answerCodeHash':answer_code_hash(),'resumed':bool(resume),'realProvider':True,'realATSWrite':False,'profilesModified':False,'promptVersion':PROMPT_VERSION,'promptHash':hashlib.sha256(INSTRUCTIONS.encode()).hexdigest(),'pages':len(pages),'evaluationScope':'server_supplement_only','localRulesIncluded':False,'reusedLegacy':bool(baseline),'results':results,'captureGaps':skipped,'failures':failures}
    with tempfile.TemporaryDirectory(prefix='jobs-answer-comparison-') as temp:
        engines={}
        for flow in calls:
            db=Path(temp)/(flow+'.sqlite')
            store=Store(db); Profiles(store); Management(store)
            with store.connect(True) as c:
                for pid,version,raw in profiles:
                    c.execute('INSERT INTO owner_profiles(id,profile,last_sync,deleted) VALUES(?,?,?,0)',(pid,raw,version))
                    doc=source.execute('SELECT value,revision FROM management_documents WHERE key=?',('jobsResponses:'+pid,)).fetchone()
                    if doc: c.execute('INSERT INTO management_documents(key,value,revision) VALUES(?,?,?)',('jobsResponses:'+pid,doc[0],doc[1]))
            engines[flow]=(store,Answers(store,flow=flow))
        seen=set()
        for pid,version,raw_profile in profiles:
            profile=json.loads(raw_profile)
            record=source.execute('SELECT value FROM management_documents WHERE key=?',('jobsResponses:'+pid,)).fetchone()
            records=json.loads(record[0]) if record else []
            for ident,page in pages:
                known=captures.get(ident)
                url=URLS.get(known,'')
                context=request_context({'jobUrl':url,'jobCountry':'US' if known else ''})
                fields=[]
                for raw in page['fields']:
                    f=as_field(raw)
                    try: fields_input({'fields':[f]})
                    except ValueError as error:
                        skipped.append({'page':ident,'fieldId':f['fieldId'],'reason':str(error)});continue
                    key=json.dumps([pid,{k:v for k,v in f.items() if k!='fieldId'},url,page['company']],sort_keys=True)
                    if key in seen: continue
                    seen.add(key); fields.append(f)
                for start in range(0,len(fields),20):
                    batch=fields[start:start+20];responses={}
                    payload=dict(profileId=pid,profileVersion=version,answerProtocol=3,fields=batch,jobUrl=url,jobCountry=context['country'],additionalContext='Captured platform: '+page['platform']+'; company context: '+page['company'],jobTitle=page.get('step',''))
                    for flow,(store,engine) in engines.items():
                        responses[flow]={}
                        for f in batch:
                            key=identity(pid,version,ident,f)
                            if key in completed: responses[flow][f['fieldId']]=completed[key][flow]
                            elif flow=='legacy' and key in reused: responses[flow][f['fieldId']]=reused[key]
                        pending=[f for f in batch if f['fieldId'] not in responses[flow]]
                        if not pending: continue
                        # Isolated evaluation budget, never the live service rate counter.
                        with store.connect(True) as c:
                            if c.execute("SELECT 1 FROM sqlite_master WHERE name='answer_requests'").fetchone(): c.execute('DELETE FROM answer_requests')
                        try:
                            response=await engine.generate({**payload,'fields':pending})
                            responses[flow].update({r['fieldId']:r for r in response['answers']})
                            calls[flow]+=response['answerUsage']['modelCalls']
                        except Exception as error:
                            failures.append({'page':ident,'flow':flow,'errorType':type(error).__name__})
                            responses[flow]={}
                    for f in batch:
                        pair={flow:responses[flow].get(f['fieldId'],{'kind':'unknown','value':None,'reasonZh':'调用失败'}) for flow in calls}
                        expected=gold_for(records,f,context,version)
                        gold_source='recent_person_answer' if expected is not None else None
                        if expected is None and known:
                            expected=reported_expected(f,profile)
                            if expected is not None: gold_source='reported_failure_profile_fact'
                        results.append(dict(page=known or ident,corpusId=ident,profileId=pid,profileVersion=version,profileName=profile['profileName'],contextComplete=bool(known),field=f,**pair,gold=expected,goldSource=gold_source))
                    private_save(args.output,report)
                    print(json.dumps({'checked':len(results),'providerCalls':calls,'captureGaps':len(skipped)}),flush=True)
    metrics={}
    for flow in calls:
        metrics[flow]={'unknown':sum(r[flow]['kind']=='unknown' for r in results),'wrongGold':sum(r['gold'] is not None and r[flow]['value'] is not None and readable(r['field'],r[flow]['value'])!=r['gold'] for r in results),'unansweredGold':sum(r['gold'] is not None and r[flow]['value'] is None for r in results),'invalidOptions':0,'internalValues':0,'chineseMissing':0}
        for r in results:
            row=r[flow]; value=row.get('value'); options=r['field']['options']
            if value is not None and options:
                values=value if isinstance(value,list) else [value]
                metrics[flow]['invalidOptions']+=int(any(v not in [o['value'] for o in options] for v in values))
            metrics[flow]['internalValues']+=int(not options and isinstance(value,str) and value in ENUM_TEXT and '_' in value)
            metrics[flow]['chineseMissing']+=int(not row.get('questionZh') or not row.get('reasonZh'))
    changed=[i for i,r in enumerate(results) if (r['legacy']['kind'],r['legacy']['value'])!=(r['simple']['kind'],r['simple']['value'])]
    unchanged=[i for i in range(len(results)) if i not in changed]
    report.update(summary={'questions':len(results),'goldCount':sum(r['gold'] is not None for r in results),'metrics':metrics,'providerCalls':calls,'contextIncomplete':sum(not r['contextComplete'] for r in results),'captureGaps':len(skipped),'failures':len(failures)},changed=changed,unchangedSample=random.Random(20261010).sample(unchanged,min(30,len(unchanged))),limitations=['Captured pages do not retain full job URLs/context except the four reported pages.','Correction events retain no answer value, so cannot automatically become gold.','Model caches are never gold; unlabelled facts require owner review.','This compares server supplements only; extension local rules and complete live form context are not replayed.','Redacted placeholders in captures are evidence gaps, not valid personal answers.'])
    private_save(args.output,report)
    print(json.dumps(report['summary']),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--database',required=True);p.add_argument('--output',required=True);p.add_argument('--live',action='store_true',required=True);p.add_argument('--reported-only',action='store_true');p.add_argument('--profile-name',choices=['Intern','Newgrad'],help='Run one authorized Profile for independent parallel comparison');p.add_argument('--reuse-legacy',help='Reuse a completed baseline against exactly the same snapshot');p.add_argument('--resume',help='Reuse completed fields from the exact engine revision')
    asyncio.run(run(p.parse_args()))
