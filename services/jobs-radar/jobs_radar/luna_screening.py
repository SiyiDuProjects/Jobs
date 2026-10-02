"""Bounded company/title screening using the existing durable queue and fences."""
import hashlib
import json
import os
import secrets
import time
from pathlib import Path

import httpx

from .board import Board
from .screening_progress import ScreeningProgress

MODEL = 'gpt-6-luna'
from .screening_policy import POLICY, PROMPT

SCHEMA = {'type':'object','properties':{'jobs':{'type':'array','items':{
    'type':'object','properties':{'id':{'type':'string'},'decision':{'type':'string','enum':['keep','trash']},
                                'reason':{'type':'string'},'evidence_quote':{'type':'string'}},
    'required':['id','decision','reason','evidence_quote'],'additionalProperties':False,
}}},'required':['jobs'],'additionalProperties':False}


def public_input(row):
    return {'id':row['id'],'kind':row['kind'],'company':row['company'],'title':row['title'],
            'sources':[{k:s.get(k,'') for k in ('company','title','repository','category','source_category','section')}
                       for s in row['all_sources']]}


def classify(client, rows):
    response = client.post('https://api.openai.com/v1/responses', json={
        'model':MODEL,'store':False,'instructions':PROMPT,
        'input':json.dumps([public_input(row) for row in rows],ensure_ascii=False),
        'reasoning':{'effort':'low'},'max_output_tokens':8192,
        'text':{'format':{'type':'json_schema','name':'job_screening','strict':True,'schema':SCHEMA}},
    })
    # Never log a response body, request headers, or arbitrary provider exceptions.
    if response.status_code != 200:
        raise ValueError('Luna HTTP ' + str(response.status_code))
    data = response.json()
    if data.get('status') != 'completed':
        raise ValueError('Luna response incomplete')
    content = ''.join(part.get('text','') for output in data.get('output',[]) for part in output.get('content',[])
                      if part.get('type') == 'output_text')
    decisions = json.loads(content)['jobs']
    ids = [item['id'] for item in decisions]
    if len(ids)!=len(rows) or len(set(ids))!=len(rows) or set(ids)!={r['id'] for r in rows}:
        raise ValueError('Luna job coverage mismatch')
    lookup={r['id']:r for r in rows}
    for item in decisions:
        if item['decision'] not in {'keep','trash'} or not item['reason'].strip() or len(item['reason'])>1200:
            raise ValueError('Luna decision invalid')
        quote=item['evidence_quote'].strip()
        if not quote or not any(quote in source.get('title','') for source in lookup[item['id']]['all_sources']):
            raise ValueError('Luna evidence does not match the source title')
    return decisions, data.get('usage',{})


def api_key():
    key=os.environ.get('OPENAI_API_KEY','')
    if not key and os.environ.get('OPENAI_API_KEY_FILE'):
        key=Path(os.environ['OPENAI_API_KEY_FILE']).read_text(encoding='utf-8').strip()
    if not key:
        raise ValueError('Luna credential not configured')
    return key


def run(store, max_batches=20, batch_size=20, client=None):
    if not 1<=max_batches<=100 or not 1<=batch_size<=30:
        raise ValueError('Invalid screening batch limit')
    owner=secrets.token_hex(12)
    now=time.time()
    with store.connect(True) as c:
        lock=c.execute("SELECT * FROM locks WHERE name='luna-screening'").fetchone()
        if lock and lock['expires']>now:
            return {'status':'already_running'}
        c.execute("INSERT INTO locks VALUES('luna-screening',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires",(owner,now+180))
    owned_client=client is None
    counts={'keep':0,'trash':0,'changed':0}
    try:
        if owned_client:
            client=httpx.Client(timeout=90,trust_env=False,headers={'Authorization':'Bearer '+api_key()})
        progress=ScreeningProgress(store)
        batch=progress.manage('begin')
        board=Board(store)
        for _ in range(max_batches):
            with store.connect(True) as c:
                changed=c.execute("UPDATE locks SET expires=? WHERE name='luna-screening' AND owner=?",(time.time()+180,owner)).rowcount
                if changed!=1:raise ValueError('Screening lock lost')
            rows=[]
            for kind in ('newgrad','internship'):
                if len(rows)<batch_size:
                    rows.extend(board.queue(kind,limit=batch_size-len(rows),run_id=batch['id'])['jobs'])
            if not rows:break
            decisions,usage=classify(client,rows)
            lookup={r['id']:r for r in rows}
            with store.connect(True) as c:
                c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('luna_usage',?,?,?)",
                          (MODEL,time.time(),json.dumps({'run_id':batch['id'],'policy':POLICY,'jobs':len(rows),'usage':usage})))
            for item in decisions:
                row=lookup[item['id']]
                source=next(s for s in row['all_sources'] if item['evidence_quote'].strip() in s.get('title',''))
                evidence=[{'url':source.get('source_url') or source.get('apply_url'),
                           'quote':item['evidence_quote'].strip(),'observed_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}]
                key=hashlib.sha256(json.dumps([POLICY,batch['id'],row['id'],row['kind'],row['fingerprint'],row['review_version'],item],sort_keys=True).encode()).hexdigest()
                try:
                    board.review(row['id'],row['kind'],item['decision'],'off_target_role' if item['decision']=='trash' else 'eligible',
                                 item['reason'],evidence,row['fingerprint'],row['review_version'],key,actor=MODEL)
                    counts[item['decision']]+=1
                except ValueError:
                    # A concurrent change/manual keep/application stays protected and is retried from fresh queue state.
                    counts['changed']+=1
            print(json.dumps({'screening':'luna','run_id':batch['id'],**counts}),flush=True)
        final=progress.manage('complete',batch['id'])
        return {'status':final['status'],'run_id':batch['id'],'remaining':final['remaining'],**counts}
    finally:
        if owned_client and client is not None:client.close()
        with store.connect(True) as c:
            c.execute("DELETE FROM locks WHERE name='luna-screening' AND owner=?",(owner,))
