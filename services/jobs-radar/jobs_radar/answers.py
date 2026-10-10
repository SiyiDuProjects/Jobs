"""Recognize public questions, compute facts, and draft open prose separately."""
import asyncio
import json
import time
import uuid
import httpx
from .luna_screening import MODEL, api_key
from .profile_contract import project_answer_profile
from . import answer_bindings as bindings
from .answer_memory import AnswerMemory, request_context
from .field_answers import fields_input
from .draft_quality import basic_issues

INSTRUCTIONS = bindings.INSTRUCTIONS


def unique_rows(body, name='mappings'):
    """A missing/duplicate/invalid row affects only that field."""
    found={}; duplicates=set()
    for row in body.get(name,[]) if isinstance(body,dict) and isinstance(body.get(name),list) else []:
        if not isinstance(row,dict) or not isinstance(row.get('fieldId'),str): continue
        key=row['fieldId']
        if key in found: duplicates.add(key)
        found[key]=row
    return {k:v for k,v in found.items() if k not in duplicates}


def saved_answer(matches,field,pid,version):
    values={json.dumps(bindings.field_value(row['response'],field),ensure_ascii=False) for row in matches.values()}
    if len(values)!=1: return None
    value=json.loads(next(iter(values)))
    if value is None: return None
    row=bindings.result(field,pid,version,value,reason='本人在同一公司对同一题保存的回答',route='saved_response')
    row['evidence']=[{'savedResponse':key} for key in matches]
    return row


class Answers:
    def __init__(self,store):
        self.store=store
        from .profile_gaps import ProfileGaps
        self.profile_gaps=ProfileGaps(store)
        with store.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_requests(id TEXT PRIMARY KEY,created REAL,state TEXT)')

    async def generate(self,payload,client=None):
        if not isinstance(payload,dict): raise ValueError('题目为空或过长')
        if 'profile' in payload or 'responseContext' in payload:
            raise ValueError('Use a bound server Profile reference')
        batch='fields' in payload
        prompt=payload.get('prompt')
        if not batch and (not isinstance(prompt,str) or not 1<=len(prompt)<=8000): raise ValueError('题目为空或过长')
        data=fields_input(payload if batch else {**payload,'fields':[{'fieldId':'text','question':prompt[:2000],'description':prompt[2000:],'type':'textarea','required':True,'options':[]}]})
        fields=data['fields']
        from .profiles import Profiles
        pid=Profiles.identifier(payload.get('profileId')); version=payload.get('profileVersion')
        profile=Profiles(self.store).at_version(pid,version)
        context={'jobContext':request_context(payload)}
        for key,limit in [('additionalContext',6000),('jobTitle',500),('jobDescription',18000)]:
            value=payload.get(key,'')
            if not isinstance(value,str) or len(value)>limit: raise ValueError('题目上下文过长')
            context[key]=value
        context = bindings.recognition_context(context)
        memory=AnswerMemory(self.store,pid,fields,{**context['jobContext'],'profileVersion':version})
        cache=bindings.BindingCache(self.store); plans=cache.plans(fields,context,MODEL)
        usage={'fieldCount':len(fields),'cacheHits':len(plans),'modelFields':0,'modelCalls':0}
        pending=[f for f in fields if f['fieldId'] not in plans]
        rid=str(uuid.uuid4()); now=time.time()
        with self.store.connect(True) as c:
            limited=c.execute('SELECT count(*) FROM answer_requests WHERE created>?',(now-3600,)).fetchone()[0]>=60

        async def request(active, instructions, data, schema, count):
            if active is None: raise ValueError('AI 服务暂时不可用')
            with self.store.connect(True) as c:
                c.execute('INSERT OR IGNORE INTO answer_requests VALUES(?,?,?)',(rid,now,'started'))
            usage['modelCalls']+=1; usage['modelFields']=max(usage['modelFields'],count)
            response=await active.post('https://api.openai.com/v1/responses',json={
                'model':MODEL,'store':False,'instructions':instructions,'input':json.dumps(data,ensure_ascii=False),
                'reasoning':{'effort':'low'},'max_output_tokens':6000,
                'text':{'format':{'type':'json_schema','name':'job_question','strict':True,'schema':schema}}})
            if response.status_code!=200: raise ValueError('AI 服务暂时不可用')
            body=response.json()
            if body.get('status')!='completed': raise ValueError('AI 返回未完成')
            text=''.join(p.get('text','') for o in body.get('output',[]) for p in o.get('content',[]) if p.get('type')=='output_text')
            return json.loads(text)

        async def run(active):
            mapping_failure = 'ai_rate_limited' if limited else 'unrecognized_question'
            if pending and not limited:
                schema={'type':'object','properties':{'mappings':{'type':'array','items':{'type':'object','properties':{
                    'fieldId':{'type':'string','enum':[f['fieldId'] for f in pending]},'binding':bindings.schema()},
                    'required':['fieldId','binding'],'additionalProperties':False}}},'required':['mappings'],'additionalProperties':False}
                try:
                    body=await request(active,INSTRUCTIONS,{'fields':pending,'context':context},schema,len(pending))
                    mapped=unique_rows(body)
                    new={f['fieldId']:b for f in pending if (b:=bindings.checked(mapped.get(f['fieldId'],{}).get('binding'),None,f,context))}
                    cache.save_plans(pending,new,context,MODEL); plans.update(new)
                except (httpx.HTTPError,ValueError,KeyError,TypeError): mapping_failure = 'ai_unavailable'
            if not memory.current(): raise ValueError('已存回答已改变，请重试；当前填写已保留')
            answers={}; drafts=[]
            for field in fields:
                fid=field['fieldId']; plan=plans.get(fid)
                row=bindings.answer(plan,None,field,profile,pid,version,defaults=False) if plan else None
                if row is None: row=saved_answer(memory.by_field.get(fid,{}),field,pid,version)
                saved=memory.by_field.get(fid,{})
                if row is None and plan and not saved: row=bindings.answer(plan,None,field,profile,pid,version)
                if row is None and plan and not saved and plan['predicate'].startswith('draft.'): drafts.append(field)
                interruption = ('ai_rate_limited' if limited else 'draft_unavailable') if field in drafts else 'missing_fact' if plan else mapping_failure
                reason = {'missing_fact':'缺少资料字段或题意未能对应，留空', 'ai_unavailable':'AI 服务暂时不可用，当前填写已保留', 'ai_rate_limited':'AI 每小时调用额度已用完，稍后重试', 'unrecognized_question':'题意未能对应，留空', 'draft_unavailable':'开放题草稿未生成，请手动作答或重试'}[interruption]
                answers[fid]=row or bindings.result(field,pid,version,reason=reason,route=plan['predicate'] if plan else 'unknown',interruption=interruption)
            if drafts and not limited:
                projected=project_answer_profile(profile,partial=False)
                projected.get('applicationData',{}).pop('aiNotes',None)
                schema={'type':'object','properties':{'drafts':{'type':'array','items':{'type':'object','properties':{
                    'fieldId':{'type':'string','enum':[f['fieldId'] for f in drafts]},'text':{'type':'string'}},
                    'required':['fieldId','text'],'additionalProperties':False}}},'required':['drafts'],'additionalProperties':False}
                try:
                    body=await request(active,'Draft concise answers only to the supplied open motivation, preference or experience prompts. Match the question language. Use only the structured Profile for any named person, school, company, skill or project. Never invent credentials, numbers, experiences or commitments. Do not output placeholders. If the request actually asks a missing fact, return empty text. These drafts are reviewed before submission.',
                        {'fields':drafts,'profile':projected,'jobTitle':context['jobTitle'],'jobDescription':context['jobDescription']},schema,len(drafts))
                    for fid,row in unique_rows(body,'drafts').items():
                        field=next((f for f in drafts if f['fieldId']==fid),None)
                        value=bindings.field_value(row.get('text'),field) if field else None
                        if value and not basic_issues(value,field['question']):
                            answers[fid]=bindings.result(field,pid,version,value,draft=True,reason='开放题草稿，提交前过目',route=plans[fid]['predicate'])
                except (httpx.HTTPError,ValueError,KeyError,TypeError):
                    for f in drafts:
                        answers[f['fieldId']] = bindings.result(f,pid,version,reason='AI 服务暂时不可用，当前填写已保留',route=plans[f['fieldId']]['predicate'],interruption='ai_unavailable')
            if not memory.current(): raise ValueError('已存回答已改变，请重试；当前填写已保留')
            rows=[answers[f['fieldId']] for f in fields]
            self.profile_gaps.record(pid,profile,fields,rows)
            with self.store.connect(True) as c:
                c.execute('UPDATE answer_requests SET state=? WHERE id=?',('needs_input' if any(r['state']=='needs_input' for r in rows) else 'answer',rid))
            if not batch:
                row=rows[0]
                if row['state']=='needs_input': raise ValueError('需要补充资料或本人回答')
                return {'text':row['value'],'source':row['source'],'responseId':rid,'remaining':None,'model':MODEL}
            return {'answers':rows,'responseId':rid,'model':MODEL,'answerUsage':usage}
        try:
            if client is not None: return await run(client)
            # A cache-only request needs no credential or network.
            if not pending and not any(p['predicate'].startswith('draft.') for p in plans.values()): return await run(None)
            try: key=api_key()
            except ValueError: return await run(None)
            async with httpx.AsyncClient(headers={'Authorization':'Bearer '+key},timeout=60) as active:
                return await run(active)
        except asyncio.CancelledError as error:
            error.answer_usage=dict(usage); raise
        except ValueError as error:
            error.answer_usage=dict(usage); raise
