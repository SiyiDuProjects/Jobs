from .answer_policy import COMMON_INSTRUCTIONS as INSTRUCTIONS
"""Luna answers for the selected Profile; no provider credential leaves the server."""
import hashlib
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
        raw=json.dumps(data,ensure_ascii=False)
        if len(raw.encode())>100000: raise ValueError('资料过大')
        now=time.time();rid=str(uuid.uuid4())
        with self.store.connect(True) as c:
            if c.execute('SELECT count(*) FROM answer_requests WHERE created>?',(now-3600,)).fetchone()[0]>=60:
                raise ValueError('本小时 AI 请求较多，请稍后再试')
            c.execute('INSERT INTO answer_requests VALUES(?,?,?)',(rid,now,'started'))
        async def call(active):
            result=await active.post('https://api.openai.com/v1/responses',json={'model':MODEL,'store':False,'instructions':INSTRUCTIONS+('\n'+field_answers.INSTRUCTIONS if batch else ''),'input':raw,
                'reasoning':{'effort':'low'},'max_output_tokens':6000 if batch else 1800,
                'text':{'format':{'type':'json_schema','name':'job_answer','strict':True,'schema':field_answers.schema(field_data['fields']) if batch else SCHEMA}}})
            if result.status_code!=200: raise ValueError('Luna 暂时不可用（HTTP '+str(result.status_code)+'）')
            body=result.json()
            if body.get('status')!='completed': raise ValueError('Luna 回答未完成，请重试')
            text=''.join(part.get('text','') for output in body.get('output',[]) for part in output.get('content',[]) if part.get('type')=='output_text')
            answer=json.loads(text)
            if batch:
                rows=field_answers.checked_answers(answer,field_data['fields'],profile)
                self.profile_gaps.record(pid,profile,field_data['fields'],rows)
                state='needs_input' if any(r['state']=='needs_input' for r in rows) else 'answer'
                with self.store.connect(True) as c:c.execute('UPDATE answer_requests SET state=? WHERE id=?',(state,rid))
                return {'answers':rows,'responseId':rid,'model':MODEL}
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
        except (httpx.HTTPError,json.JSONDecodeError,KeyError):
            raise ValueError('Luna 请求失败，未填入任何答案') from None
