from .answer_policy import COMMON_INSTRUCTIONS as INSTRUCTIONS
"""Luna answers for the selected Profile; no provider credential leaves the server."""
import hashlib
import asyncio
import json
import time
import uuid
from pathlib import Path
import httpx
from .luna_screening import MODEL, api_key

from .profile_contract import ANSWER_PROJECTION as PROFILE_CONTRACT, project_answer_profile

SCHEMA={'type':'object','properties':{'state':{'type':'string','enum':['answer','needs_input']},'text':{'type':'string'},'source':{'type':'string','enum':['profile','suggestion','unknown']}},'required':['state','text','source'],'additionalProperties':False}

class Answers:
    def __init__(self,store):
        self.store=store
        from .profile_gaps import ProfileGaps
        self.profile_gaps=ProfileGaps(store)
        with store.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_requests(id TEXT PRIMARY KEY,created REAL,state TEXT)')

    async def generate(self,payload,client=None):
        batch=isinstance(payload,dict) and 'fields' in payload
        if not isinstance(payload,dict) or (not batch and (not isinstance(payload.get('prompt'),str) or not 1<=len(payload['prompt'])<=8000)):
            raise ValueError('题目为空或过长')
        if 'responseContext' in payload:
            raise ValueError('Personal answer context must be migrated into the selected server Profile')
        from . import field_answers
        field_data=field_answers.fields_input(payload) if batch else None
        review_suggestions = payload.get('reviewSuggestions', False)
        if type(review_suggestions) is not bool:
            raise ValueError('Invalid review suggestion policy')
        from .review_proposals import INSTRUCTIONS as REVIEW_INSTRUCTIONS, proposed
        from .profiles import Profiles
        pid=Profiles.identifier(payload.get('profileId'))
        if 'profile' in payload:
            raise ValueError('Use a server Profile reference, not a client Profile snapshot')
        # The server revision is fixed by the page. A later website edit cannot
        # change its facts, and a client cannot inject a different Profile.
        profile=project_answer_profile(Profiles(self.store).at_version(pid,payload.get('profileVersion')),partial=False)
        data={'profile':profile,**(field_data if batch else {'question':payload['prompt']})}
        for key,limit in [('additionalContext',6000),('jobTitle',500),('jobDescription',18000)]:
            value=payload.get(key,'')
            if not isinstance(value,str) or len(value)>limit: raise ValueError('题目上下文过长')
            data[key]=value
        from .answer_calendar import calendar_fact
        calendar = calendar_fact(data['additionalContext']) if batch else {}
        evidence_profile = {**profile, 'calendar': calendar}
        if calendar: data['calendar'] = calendar
        saved = {}; memory = None; memory_context = {}; cached = {}
        all_fields = field_data['fields'] if batch else []
        usage = {'fieldCount': len(all_fields), 'cacheHits': 0, 'modelFields': 0, 'modelCalls': 0}
        if batch:
            from .answer_memory import AnswerMemory, request_context
            job_context = request_context(payload)
            memory_context = {**job_context, 'profileVersion': payload['profileVersion'], **calendar}
            memory = AnswerMemory(self.store, pid, field_data['fields'], memory_context)
            saved = memory.by_field
            if memory.prompt():
                data['recordedAnswers'] = memory.prompt()
                data['answerContext'] = memory_context
            from .answer_semantics import MeaningCache, VOCABULARY
            meanings = MeaningCache(self.store)
            meaning_context = {key: data[key] for key in ['additionalContext','jobTitle','jobDescription','formContext']}
            meaning_context['jobContext'] = job_context
            from .answer_bindings import BindingCache
            bindings = BindingCache(self.store)
            cached = bindings.read(all_fields, meaning_context, MODEL, evidence_profile, pid, payload['profileVersion'], saved)
            usage['cacheHits'] = len(cached)
            field_data = {**field_data, 'fields': [f for f in all_fields if f['fieldId'] not in cached]}
            data['fields'] = field_data['fields']
            data['meaningHints'] = meanings.read(field_data['fields'], meaning_context, MODEL)
            data['topicVocabulary'] = {key: VOCABULARY[key] for key in ['version','topics','optionConcepts','draftTopics']}
            from .answer_policy import POLICY
            data['standingAuthorizations'] = POLICY['standingAuthorizations']
        def combined(rows, response_id):
            if cached and not memory.current():
                raise ValueError('已存答案在核验期间改变，请重试；当前填写已保留')
            by_id = {**cached, **{row['fieldId']: row for row in rows}}
            return {'answers': [by_id[f['fieldId']] for f in all_fields], 'responseId': response_id, 'model': MODEL, 'answerUsage': dict(usage)}
        def partial_failure(error):
            if batch: error.answer_usage = dict(usage)
            if not cached:
                raise error
            from .answer_evidence import decide
            rows = [decide({'fieldId': f['fieldId'], 'state': 'needs_input', 'value': None,
                            'source': 'unknown', 'reason': 'Answer service unavailable; verified fields remain usable.'},
                           f, evidence_profile, pid, payload['profileVersion'], {'verdict': 'unavailable'})
                    for f in field_data['fields']]
            return combined(rows, str(uuid.uuid4()))
        if batch and not field_data['fields']:
            return combined([], str(uuid.uuid4()))
        raw=json.dumps(data,ensure_ascii=False)
        if len(raw.encode())>100000: raise ValueError('资料过大')
        now=time.time();rid=str(uuid.uuid4())
        with self.store.connect(True) as c:
            if c.execute('SELECT count(*) FROM answer_requests WHERE created>?',(now-3600,)).fetchone()[0]>=60:
                return partial_failure(ValueError('本小时 AI 请求较多，请稍后再试'))
            c.execute('INSERT INTO answer_requests VALUES(?,?,?)',(rid,now,'started'))
        async def call(active):
            # Count attempts at the transport boundary, including failed requests.
            # A batch can generate once and independently verify once.
            class CountedClient:
                async def post(self, *args, **kwargs):
                    usage['modelFields'] = len(field_data['fields']) if batch else 0
                    usage['modelCalls'] += 1
                    return await active.post(*args, **kwargs)
            counted = CountedClient()
            result=await counted.post('https://api.openai.com/v1/responses',json={'model':MODEL,'store':False,'instructions':INSTRUCTIONS+('\n'+field_answers.INSTRUCTIONS if batch else '')+('\n'+REVIEW_INSTRUCTIONS if batch and review_suggestions else ''),'input':raw,
                'reasoning':{'effort':'low'},'max_output_tokens':6000 if batch else 1800,
                'text':{'format':{'type':'json_schema','name':'job_answer','strict':True,'schema':field_answers.schema(field_data['fields'], evidence_profile, {key: item for matches in saved.values() for key, item in matches.items()}) if batch else SCHEMA}}})
            if result.status_code!=200: raise ValueError('Luna 暂时不可用（HTTP '+str(result.status_code)+'）')
            body=result.json()
            if body.get('status')!='completed': raise ValueError('Luna 回答未完成，请重试')
            text=''.join(part.get('text','') for output in body.get('output',[]) for part in output.get('content',[]) if part.get('type')=='output_text')
            answer=json.loads(text)
            if batch:
                rows=field_answers.checked_answers(answer,field_data['fields'],profile)
                from .answer_evidence import decide
                from .answer_verification import verify
                if not memory.current():
                    raise ValueError('已存答案在核验期间改变，请重试；当前填写已保留')
                checks = await verify(counted, rows, field_data['fields'], evidence_profile, MODEL, saved, memory_context, meaning_context)
                if not memory.current():
                    raise ValueError('已存答案在核验期间改变，请重试；当前填写已保留')
                meanings.save(field_data['fields'], [{**row, 'meaning': checks.get(row['fieldId'], {}).get('meaning', row.get('meaning'))} for row in rows], meaning_context, MODEL)
                fields_by_id = {f['fieldId']: f for f in field_data['fields']}
                candidates = rows
                rows = [decide(row, fields_by_id[row['fieldId']], evidence_profile, pid, payload['profileVersion'], checks.get(row['fieldId'], {'verdict': 'missing_fact'}), saved.get(row['fieldId'])) for row in rows]
                if review_suggestions:
                    rows = [proposed(candidate, fields_by_id[row['fieldId']], row) for candidate, row in zip(candidates, rows)]
                bindings.save(field_data['fields'], rows, checks, meaning_context, MODEL, evidence_profile, pid, payload['profileVersion'], saved)
                self.profile_gaps.record(pid,profile,field_data['fields'],rows)
                state='needs_input' if any(r['state']=='needs_input' for r in rows) else 'answer'
                with self.store.connect(True) as c:c.execute('UPDATE answer_requests SET state=? WHERE id=?',(state,rid))
                return combined(rows, rid)
            if answer.get('state') not in {'answer','needs_input'} or not isinstance(answer.get('text'),str) or not answer['text'].strip(): raise ValueError('Luna 返回的回答无效')
            with self.store.connect(True) as c:c.execute('UPDATE answer_requests SET state=? WHERE id=?',(answer['state'],rid))
            if answer['state']=='needs_input': raise ValueError('需要你确认：'+answer['text'][:600])
            source=answer.get('source','unknown')
            if source not in {'profile','suggestion','unknown'}:source='unknown'
            self.profile_gaps.record(pid,profile,[{'fieldId':'text','question':payload['prompt'],'type':'textarea','options':[]}],
                [{'fieldId':'text','state':'answer','value':answer['text'],'reason':'Generate Answer: derived from selected Profile','source':source}])
            return {'text':answer['text'],'source':source,'responseId':rid,'remaining':None,'model':MODEL}
        try:
            if client is not None:return await call(client)
            async with httpx.AsyncClient(headers={'Authorization':'Bearer '+api_key()},timeout=60) as active:
                return await call(active)
        except asyncio.CancelledError as error:
            if batch: error.answer_usage = dict(usage)
            raise
        except (httpx.HTTPError,json.JSONDecodeError,KeyError):
            return partial_failure(ValueError('Luna 请求失败，未填入任何答案'))
        except ValueError as error:
            return partial_failure(error)
