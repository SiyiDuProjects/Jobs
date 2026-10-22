"""Saved answer, private cache, one model call, or an explicit unknown."""
import asyncio
import json
import re
import time
import uuid
from datetime import datetime, timezone
import httpx
from . import ai_answers
from .answer_cache import AnswerCache, digest
from .answer_result import result
from .answer_transport import record_failure
from .field_answers import fields_input, _exact_date
from .luna_screening import MODEL, api_key
from .profile_text import render_profile
from .profiles import Profiles
from .saved_answers import SavedAnswers, request_context


class SimpleAnswers:
    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_requests(id TEXT PRIMARY KEY,created REAL,state TEXT)')

    async def generate(self, payload, client=None):
        if not isinstance(payload,dict) or 'profile' in payload or 'responseContext' in payload: raise ValueError('Use a bound server Profile reference')
        validated = fields_input(payload)
        fields = validated['fields']
        pid = Profiles.identifier(payload.get('profileId')); version = payload.get('profileVersion')
        profile = Profiles(self.store).at_version(pid,version)
        context = request_context(payload)
        for key, limit in [('additionalContext',6000),('jobTitle',500),('jobDescription',18000)]:
            value = payload.get(key,'')
            if not isinstance(value,str) or len(value)>limit: raise ValueError('题目上下文过长')
            context[key] = value
        today = datetime.now(timezone.utc).date().isoformat()
        try:
            local = json.loads(context['additionalContext'])
            supplied = local.get('currentLocalDate')
            if _exact_date(supplied): today = supplied
        except (ValueError,TypeError,AttributeError): pass
        memory = SavedAnswers(self.store,pid,version,context)
        cache = AnswerCache(self.store,[pid,version,MODEL,ai_answers.PROMPT_VERSION,digest(ai_answers.INSTRUCTIONS),context['country']])
        job = {k:context[k] for k in ('jobKey','companyKey','jobTitle','jobDescription')}
        # Context can include useful public scope, but ephemeral dates must not age every answer.
        try:
            stable_context=json.loads(context['additionalContext'])
            if isinstance(stable_context,dict):
                stable_context={k:v for k,v in stable_context.items() if k not in {'currentLocalDate','timeZone','dateAnswerFormat'}}
        except (ValueError,TypeError): stable_context=context['additionalContext']
        job['additionalContext']=stable_context
        job['formContext']=validated['formContext']
        # Whole-page prose is model input, not stable job identity for the cache.
        readable = render_profile(profile); answers = {}; pending = []
        usage = {'fieldCount':len(fields),'cacheHits':0,'modelFields':0,'modelCalls':0}
        for field in fields:
            saved = memory.exact(field)
            if saved is not None:
                row = ai_answers.checked({'kind':'answer', **saved,
                    'questionZh':saved.get('questionZh') or '沿用你在该公司的同题回答',
                    'answerZh':saved.get('answerZh') or '你上次确认的答案',
                    'reasonZh':'复用资料更新后，你在同一公司对同一题保存的回答'},
                    field,pid,version,{saved['value']} if isinstance(saved['value'],str) else set(),today)
                if row['kind'] == 'answer':
                    answers[field['fieldId']] = {**row,'source':'saved'}
                    continue
            cached = cache.get(field,job,memory.fingerprint(field))
            if cached and not (cached.get('signingDate') and cached['value'] != today):
                answers[field['fieldId']] = {**cached,'binding':{'profileId':pid,'profileVersion':version,'field':field}}
                usage['cacheHits'] += 1
            else: pending.append(field)
        rid = str(uuid.uuid4()); failures = []
        async def run(active):
            if pending:
                with self.store.connect(True) as c:
                    if active: c.execute('INSERT INTO answer_requests VALUES(?,?,?)',(rid,time.time(),'started'))
                failure = 'ai_unavailable'; generated = {}
                if active:
                    usage.update(modelCalls=1,modelFields=len(pending))
                    try:
                        body = await ai_answers.generate(active,MODEL,pending,{
                            'profile':readable,'pastAnswers':{f['fieldId']:memory.candidates(f) for f in pending},
                            'job':context,'formContext':validated['formContext'],'formDocument':validated['formDocument'],'today':today,'fields':pending})
                        rows = body.get('answers',[]) if isinstance(body,dict) else []
                        if isinstance(rows,list):
                            for field in pending:
                                matches = [r for r in rows if isinstance(r,dict) and r.get('fieldId')==field['fieldId']]
                                if len(matches)==1: generated[field['fieldId']]=matches[0]
                        failure = 'answer_missing'
                    except (httpx.HTTPError,ValueError,KeyError,TypeError) as error:
                        failures.append(record_failure(error,rid,'simple'))
                for field in pending:
                    sources = readable + '\n'.join(r['answer'] for r in memory.candidates(field))
                    dates = set(re.findall(r'\b\d{4}-\d{2}-\d{2}\b',sources))
                    raw = generated.get(field['fieldId'])
                    row = ai_answers.checked(raw,field,pid,version,dates,today) if raw else result(
                        field,pid,version,interruptionReason=failure,reasonZh={
                            'ai_unavailable':'AI 服务暂时不可用，当前填写已保留',
                            'answer_missing':'AI 没有返回这道题的有效回答，请重试'}[failure])
                    answers[field['fieldId']] = row
                    cache.put(field,job,row,memory.fingerprint(field))
            for field in fields:
                if not memory.current(field):
                    answers[field['fieldId']] = result(field,pid,version,interruptionReason='saved_answer_changed',
                        questionZh=answers[field['fieldId']].get('questionZh',''),reasonZh='这道题参考的已存回答刚刚改变，请重试此题')
            rows = [answers[f['fieldId']] for f in fields]
            with self.store.connect(True) as c:
                c.execute('UPDATE answer_requests SET state=? WHERE id=?',('needs_input' if any(r['kind']=='unknown' for r in rows) else 'answer',rid))
            return {'answers':rows,'responseId':rid,'model':MODEL,'answerUsage':usage,'flow':'simple', **({'answerDiagnostics':failures} if failures else {})}
        try:
            if client is not None or not pending: return await run(client)
            try: key = api_key()
            except ValueError: return await run(None)
            async with httpx.AsyncClient(headers={'Authorization':'Bearer '+key},timeout=60) as active: return await run(active)
        except (asyncio.CancelledError,ValueError) as error:
            error.answer_usage = dict(usage)
            raise
