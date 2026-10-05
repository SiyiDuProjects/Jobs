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
from .geography import non_us_only, screening_locations
from .company_screening import public_input
from .sponsorship import restriction, title_citizenship

MODEL = 'gpt-6-luna'
from .screening_policy import POLICY, PROMPT

DECISION_SCHEMA = {
    'type':'object','properties':{'decision':{'type':'string','enum':['keep','trash']},
                                'company_recommended':{'type':'boolean'},
                                'reason':{'type':'string'},'evidence_quote':{'type':'string'}},
    'required':['decision','company_recommended','reason','evidence_quote'],'additionalProperties':False,
}


def response_schema(references):
    # Fixed required keys make an incomplete/foreign identity set invalid in
    # Structured Outputs itself, instead of merely discovering it after billing.
    properties={}
    for ref in references:
        schema=DECISION_SCHEMA
        if isinstance(references,dict):
            row=references[ref]
            quotes=[s.get('title','') for s in row['all_sources']]
            if non_us_only(screening_locations(row['all_sources'])):
                quotes.extend(loc for s in row['all_sources'] for loc in s.get('locations',[]))
            limited=restriction(row['all_sources'])
            if limited: quotes.append(limited[1])
            quotes=list(dict.fromkeys(q for q in quotes if isinstance(q,str) and q.strip()))
            if quotes:
                schema={**DECISION_SCHEMA,'properties':{**DECISION_SCHEMA['properties'],
                    'evidence_quote':{'type':'string','enum':quotes}}}
        properties[ref]=schema
    return {'type':'object','properties':{'jobs':{
        'type':'object','properties':properties,
        'required':list(references),'additionalProperties':False,
    }},'required':['jobs'],'additionalProperties':False}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ScreeningError('job_coverage')
        result[key] = value
    return result


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


def classify(client, rows):
    # One short reference per (job, kind) row; copying long canonical IDs is
    # unnecessary, and one job can legitimately occur in both kind queues.
    references = {f'job_{index}':row for index,row in enumerate(rows)}
    try:
        response = client.post('https://api.openai.com/v1/responses', json={
            'model':MODEL,'store':False,
            'instructions':PROMPT,
            'input':json.dumps([public_input(row,ref) for ref,row in references.items()],ensure_ascii=False),
            'reasoning':{'effort':'low'},'max_output_tokens':8192,
            'text':{'format':{'type':'json_schema','name':'job_screening','strict':True,'schema':response_schema(references)}},
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
        decoded = json.loads(content, object_pairs_hook=unique_object)
        if not isinstance(decoded,dict) or set(decoded)!={'jobs'}: raise ScreeningError('provider_shape')
        decisions = decoded['jobs']
        if not isinstance(decisions, dict) or not all(isinstance(item,dict) and
                set(item)=={'decision','company_recommended','reason','evidence_quote'} and type(item['company_recommended']) is bool and
                all(isinstance(item[k],str) for k in ('decision','reason','evidence_quote')) for item in decisions.values()):
            raise ScreeningError('provider_shape')
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        if isinstance(exc, ScreeningError): raise
        raise ScreeningError('provider_shape') from exc
    if set(decisions)!=set(references):
        raise ScreeningError('job_coverage')
    checked = []
    for ref,row in references.items():
        item=decisions[ref]
        if item['decision'] not in {'keep','trash'} or not item['reason'].strip() or len(item['reason'])>1200:
            raise ScreeningError('decision_invalid')
        if item['company_recommended'] and (item['decision']=='trash' or non_us_only(screening_locations(row['all_sources']))):
            raise ScreeningError('decision_invalid')
        quote=item['evidence_quote'].strip()
        title_quote = any(quote in source.get('title','') for source in row['all_sources'])
        location_quote = any(quote in loc for source in row['all_sources'] for loc in source.get('locations', []))
        geographic = item['decision']=='trash' and not title_quote and location_quote
        sponsored = restriction(row['all_sources'])
        restriction_quote = bool(sponsored and quote==sponsored[1])
        if not quote or not (title_quote or location_quote or restriction_quote):
            raise ScreeningError('evidence_mismatch')
        if geographic and not non_us_only(screening_locations(row['all_sources'])):
            raise ScreeningError('evidence_mismatch')
        checked.append({**item,'id':row['id'],'kind':row['kind'],
                        'reason_code':sponsored[2] if restriction_quote else 'non_us_only' if geographic
                        else 'citizenship' if title_quote and title_citizenship(quote) else 'off_target_role'})
    return checked, data.get('usage',{})


def api_key():
    key=os.environ.get('OPENAI_API_KEY','')
    if not key and os.environ.get('OPENAI_API_KEY_FILE'):
        key=Path(os.environ['OPENAI_API_KEY_FILE']).read_text(encoding='utf-8').strip()
    if not key:
        raise ScreeningError('credential_missing')
    return key


def run(store, max_batches=20, batch_size=20, client=None, backfill_company=False):
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
        # Correct earlier automatic keeps as well as new imports, while the
        # same transaction preserves processed and manually restored jobs.
        if backfill_company:
            from .screening import reopen_automatic_reviews
            with store.connect(True) as c:
                reopen_automatic_reviews(c)
        store.screen_titles()
        progress=ScreeningProgress(store)
        batch=progress.manage('begin',backfill_company=backfill_company)
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
            lookup={(r['id'],r['kind']):r for r in rows}
            with store.connect(True) as c:
                c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('luna_usage',?,?,?)",
                          (MODEL,time.time(),json.dumps({'run_id':batch['id'],'policy':POLICY,'jobs':len(rows),'usage':usage})))
            for item in decisions:
                row=lookup[(item['id'],item['kind'])]
                source=next(s for s in row['all_sources'] if item['evidence_quote'].strip() in s.get('title','')
                            or any(item['evidence_quote'].strip() in loc for loc in s.get('locations', []))
                            or item['evidence_quote'].strip()==s.get('sponsorship'))
                evidence=[{'url':source.get('source_url') or source.get('apply_url'),
                           'quote':item['evidence_quote'].strip(),'observed_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}]
                key=hashlib.sha256(json.dumps([POLICY,batch['id'],row['id'],row['kind'],row['fingerprint'],row['review_version'],item],sort_keys=True).encode()).hexdigest()
                try:
                    board.review(row['id'],row['kind'],item['decision'],item['reason_code'] if item['decision']=='trash' else 'eligible',
                                 item['reason'],evidence,row['fingerprint'],row['review_version'],key,actor=MODEL,
                                 company_recommended=item['company_recommended'],expected_company_fingerprint=row['company_fingerprint'])
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
