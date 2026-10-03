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


class ScreeningError(ValueError):
    """Only code-owned, bounded metadata may cross the scheduler log boundary."""
    def __init__(self, code, *, http_status=None, provider_code=None):
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.provider_code = provider_code
        self.stage = 'provider'


ERROR_CODES = frozenset({
    'provider_http', 'provider_transport', 'provider_json', 'provider_incomplete',
    'provider_shape', 'job_coverage', 'decision_invalid', 'evidence_mismatch',
    'credential_missing', 'batch_limit', 'lock_lost', 'unexpected',
})
STAGES = frozenset({'credentials', 'progress', 'queue', 'provider', 'review', 'complete', 'lock'})
PROVIDER_CODES = frozenset({
    'insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'model_not_found',
    'unsupported_value', 'unsupported_parameter', 'invalid_json_schema', 'invalid_request_error',
    'permission_denied', 'server_error', 'max_output_tokens', 'content_filter',
})


def failure_summary(exc):
    # Never serialize exception text, headers, request/response bodies or arbitrary attributes.
    result = {'screening': 'failed', 'error_type': 'ValueError' if isinstance(exc, ValueError) else 'Exception',
              'error_code': 'unexpected', 'stage': 'unknown'}
    if isinstance(exc, ScreeningError):
        if isinstance(exc.code,str) and exc.code in ERROR_CODES: result['error_code'] = exc.code
        if isinstance(exc.stage,str) and exc.stage in STAGES: result['stage'] = exc.stage
        if type(exc.http_status) is int and 100 <= exc.http_status <= 599:
            result['http_status'] = exc.http_status
        if isinstance(exc.provider_code,str) and exc.provider_code in PROVIDER_CODES:
            result['provider_code'] = exc.provider_code
    return result


def public_input(row):
    return {'id':row['id'],'kind':row['kind'],'company':row['company'],'title':row['title'],
            'sources':[{k:s.get(k,'') for k in ('company','title','repository','category','source_category','section')}
                       for s in row['all_sources']]}


def classify(client, rows):
    try:
        response = client.post('https://api.openai.com/v1/responses', json={
        'model':MODEL,'store':False,'instructions':PROMPT,
        'input':json.dumps([public_input(row) for row in rows],ensure_ascii=False),
        'reasoning':{'effort':'low'},'max_output_tokens':8192,
        'text':{'format':{'type':'json_schema','name':'job_screening','strict':True,'schema':SCHEMA}},
        })
    except httpx.RequestError as exc:
        raise ScreeningError('provider_transport') from exc
    # Never log a response body, request headers, or arbitrary provider exceptions.
    if response.status_code != 200:
        provider_code = None
        try:
            error = response.json().get('error', {})
            candidate = error.get('code') if isinstance(error, dict) else None
            if isinstance(candidate, str) and candidate in PROVIDER_CODES: provider_code = candidate
        except (ValueError, AttributeError): pass
        raise ScreeningError('provider_http', http_status=response.status_code, provider_code=provider_code)
    try:
        data = response.json()
    except ValueError as exc:
        raise ScreeningError('provider_json') from exc
    if not isinstance(data, dict): raise ScreeningError('provider_shape')
    if data.get('status') != 'completed':
        details = data.get('incomplete_details')
        reason = details.get('reason') if isinstance(details, dict) else None
        raise ScreeningError('provider_incomplete', provider_code=reason if isinstance(reason,str) and reason in PROVIDER_CODES else None)
    try:
        content = ''.join(part.get('text','') for output in data.get('output',[]) for part in output.get('content',[])
                          if part.get('type') == 'output_text')
        decisions = json.loads(content)['jobs']
        if not isinstance(decisions, list) or not all(isinstance(item,dict) and
                all(isinstance(item.get(k),str) for k in ('id','decision','reason','evidence_quote')) for item in decisions):
            raise ScreeningError('provider_shape')
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        if isinstance(exc, ScreeningError): raise
        raise ScreeningError('provider_shape') from exc
    ids = [item['id'] for item in decisions]
    if len(ids)!=len(rows) or len(set(ids))!=len(rows) or set(ids)!={r['id'] for r in rows}:
        raise ScreeningError('job_coverage')
    lookup={r['id']:r for r in rows}
    for item in decisions:
        if item['decision'] not in {'keep','trash'} or not item['reason'].strip() or len(item['reason'])>1200:
            raise ScreeningError('decision_invalid')
        quote=item['evidence_quote'].strip()
        if not quote or not any(quote in source.get('title','') for source in lookup[item['id']]['all_sources']):
            raise ScreeningError('evidence_mismatch')
    return decisions, data.get('usage',{})


def api_key():
    key=os.environ.get('OPENAI_API_KEY','')
    if not key and os.environ.get('OPENAI_API_KEY_FILE'):
        key=Path(os.environ['OPENAI_API_KEY_FILE']).read_text(encoding='utf-8').strip()
    if not key:
        raise ScreeningError('credential_missing')
    return key


def run(store, max_batches=20, batch_size=20, client=None):
    if not 1<=max_batches<=100 or not 1<=batch_size<=30:
        exc = ScreeningError('batch_limit'); exc.stage = 'progress'; raise exc
    owner=secrets.token_hex(12)
    now=time.time()
    with store.connect(True) as c:
        lock=c.execute("SELECT * FROM locks WHERE name='luna-screening'").fetchone()
        if lock and lock['expires']>now:
            return {'status':'already_running'}
        c.execute("INSERT INTO locks VALUES('luna-screening',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires",(owner,now+180))
    owned_client=client is None
    counts={'keep':0,'trash':0,'changed':0}
    stage='credentials'
    try:
        if owned_client:
            client=httpx.Client(timeout=90,trust_env=False,headers={'Authorization':'Bearer '+api_key()})
        stage='progress'
        progress=ScreeningProgress(store)
        batch=progress.manage('begin')
        board=Board(store)
        for _ in range(max_batches):
            stage='lock'
            with store.connect(True) as c:
                changed=c.execute("UPDATE locks SET expires=? WHERE name='luna-screening' AND owner=?",(time.time()+180,owner)).rowcount
                if changed!=1:raise ScreeningError('lock_lost')
            stage='queue'
            rows=[]
            for kind in ('newgrad','internship'):
                if len(rows)<batch_size:
                    rows.extend(board.queue(kind,limit=batch_size-len(rows),run_id=batch['id'])['jobs'])
            if not rows:break
            stage='provider'
            decisions,usage=classify(client,rows)
            stage='review'
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
        stage='complete'
        final=progress.manage('complete',batch['id'])
        return {'status':final['status'],'run_id':batch['id'],'remaining':final['remaining'],**counts}
    except Exception as exc:
        failure = exc if isinstance(exc, ScreeningError) else ScreeningError('unexpected')
        failure.stage = stage
        if failure is exc: raise
        raise failure from exc
    finally:
        if owned_client and client is not None:client.close()
        with store.connect(True) as c:
            c.execute("DELETE FROM locks WHERE name='luna-screening' AND owner=?",(owner,))
