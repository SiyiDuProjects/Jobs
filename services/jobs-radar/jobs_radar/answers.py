"""Recognize public questions, compute facts, and draft open prose separately."""
import asyncio
import json
import time
import uuid
import httpx
from .luna_screening import MODEL, api_key
from .profile_contract import project_answer_profile
from . import answer_bindings as bindings
from . import flexible_answers as flexible
from .answer_memory import AnswerMemory, request_context
from .field_answers import fields_input

INSTRUCTIONS = flexible.INSTRUCTIONS


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
        projected=project_answer_profile(profile,partial=False)
        displays=cache.displays(fields,context,MODEL)
        pending=[f for f in fields if f['fieldId'] not in plans or bindings.answer(plans[f['fieldId']],None,f,profile,pid,version) is None]
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
                'reasoning':{'effort':'low'},'max_output_tokens':max(6000,min(24000,count*1000)),
                'text':{'format':{'type':'json_schema','name':'job_question','strict':True,'schema':schema}}})
            if response.status_code!=200: raise ValueError('AI 服务暂时不可用')
            body=response.json()
            if body.get('status')!='completed': raise ValueError('AI 返回未完成')
            text=''.join(p.get('text','') for o in body.get('output',[]) for p in o.get('content',[]) if p.get('type')=='output_text')
            return json.loads(text)

        async def run(active):
            generated={}
            mapping_failure = 'ai_rate_limited' if limited else 'unrecognized_question'
            if pending and not limited:
                schema={'type':'object','properties':{'mappings':{'type':'array','items':{'type':'object','properties':{
                    'fieldId':{'type':'string','enum':[f['fieldId'] for f in pending]},'binding':bindings.schema()},
                    'required':['fieldId','binding'],'additionalProperties':False}},
                    'answers':{'type':'array','items':flexible.schema(pending,projected)}},'required':['mappings','answers'],'additionalProperties':False}
                try:
                    body=await request(active,flexible.INSTRUCTIONS,{
                        'fields':pending,'context':context,'profile':projected,
                        'recordedAnswers':memory.prompt(),
                        'defaultCategories':{k:bindings.DEFAULTS[k] for k in profile.get('applicationData',{}).get('defaultAnswers',[]) if k in bindings.DEFAULTS},
                        'bindingDomains':bindings.PREDICATES,
                    },schema,len(pending))
                    generated=unique_rows(body,'answers')
                    mapped=unique_rows(body)
                    new={f['fieldId']:b for f in pending if (b:=bindings.checked(mapped.get(f['fieldId'],{}).get('binding'),None,f,context))}
                    views={f['fieldId']:flexible.presentation(generated.get(f['fieldId']),f) for f in pending}
                    cache.save_plans(pending,new,context,MODEL,views); plans.update(new); displays.update(views)
                except (httpx.HTTPError,ValueError,KeyError,TypeError): mapping_failure = 'ai_unavailable'
            if not memory.current(): raise ValueError('已存回答已改变，请重试；当前填写已保留')
            answers={}
            for field in fields:
                fid=field['fieldId']; plan=plans.get(fid)
                row=bindings.answer(plan,None,field,profile,pid,version,defaults=False) if plan else None
                candidate=flexible.checked(generated.get(fid),field,projected,pid,version,memory.by_field.get(fid,{}))
                # Explicit Profile facts, including grounded flexible deductions,
                # precede remembered answers and category defaults.
                if row is None and candidate and generated[fid].get('basis')=='profile' and candidate['state']=='answer': row=candidate
                if row is None: row=saved_answer(memory.by_field.get(fid,{}),field,pid,version)
                saved=memory.by_field.get(fid,{})
                if row is None and plan and not saved: row=bindings.answer(plan,None,field,profile,pid,version)
                if row is None and candidate: row=candidate
                draft=bool(plan and plan['predicate'].startswith('draft.'))
                interruption = mapping_failure if mapping_failure in {'ai_unavailable','ai_rate_limited'} else 'draft_unavailable' if draft else 'missing_fact' if plan and plan['predicate']!='unknown' else 'unrecognized_question'
                reason = {'missing_fact':'缺少资料字段或题意未能对应，留空', 'ai_unavailable':'AI 服务暂时不可用，当前填写已保留', 'ai_rate_limited':'AI 每小时调用额度已用完，稍后重试', 'unrecognized_question':'题意未能对应，留空', 'draft_unavailable':'开放题草稿未生成，请手动作答或重试'}[interruption]
                row=row or bindings.result(field,pid,version,reason=reason,route=plan['predicate'] if plan else 'unknown',interruption=interruption)
                origin='saved' if row['route']=='saved_response' else 'default' if {'profilePath':'applicationData.defaultAnswers'} in row['evidence'] else 'suggestion' if row['decision']=='draft' else 'profile'
                if candidate and row['value'] is not None and row['value']==candidate['value'] and generated[fid].get('basis')==origin:
                    row={**row,**{k:candidate[k] for k in ('questionZh','answerZh','reason') if k in candidate}}
                answers[fid]=flexible.display(row,field,displays.get(fid))
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
            if not pending: return await run(None)
            try: key=api_key()
            except ValueError: return await run(None)
            async with httpx.AsyncClient(headers={'Authorization':'Bearer '+key},timeout=60) as active:
                return await run(active)
        except asyncio.CancelledError as error:
            error.answer_usage=dict(usage); raise
        except ValueError as error:
            error.answer_usage=dict(usage); raise
