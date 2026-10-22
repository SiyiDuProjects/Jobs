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
from .answer_transport import request_json, record_failure
from .answer_timing import database, request_state, add

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
        started = time.monotonic()
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
        profile=await database(lambda: Profiles(self.store).at_version(pid,version))
        context={'jobContext':request_context(payload)}
        for key,limit in [('additionalContext',6000),('jobTitle',500),('jobDescription',18000)]:
            value=payload.get(key,'')
            if not isinstance(value,str) or len(value)>limit: raise ValueError('题目上下文过长')
            context[key]=value
        context = bindings.recognition_context(context)
        context['formContext'] = data['formContext']
        if data['formDocument'] is not None: context['formDocument'] = data['formDocument']
        memory=await database(AnswerMemory,self.store,pid,fields,{**context['jobContext'],'profileVersion':version})
        cache=await database(bindings.BindingCache,self.store); plans=await database(cache.plans,fields,context,MODEL)
        public_plans={f['fieldId']:plan for f in fields if (plan:=bindings.public_binding(f))}
        plans.update(public_plans)
        usage={'fieldCount':len(fields),'cacheHits':len(plans),'modelFields':0,'modelCalls':0}
        projected=project_answer_profile(profile,partial=False)
        displays=await database(cache.displays,fields,context,MODEL)
        pending=[f for f in fields if f['fieldId'] not in plans or bindings.answer(plans[f['fieldId']],None,f,profile,pid,version) is None or f['fieldId'] in public_plans and not displays.get(f['fieldId'])]
        add('preparationMs',time.monotonic()-started)
        rid=str(uuid.uuid4()); now=time.time(); failures=[]

        async def request(active, instructions, data, schema, count):
            if active is None: raise ValueError('AI 服务暂时不可用')
            await database(request_state,self.store,rid,'started',created=now)
            usage['modelCalls']+=1; usage['modelFields']=max(usage['modelFields'],count)
            return await request_json(active, {
                'model':MODEL,'store':False,'instructions':instructions,'input':json.dumps(data,ensure_ascii=False),
                'reasoning':{'effort':'low'},'max_output_tokens':max(6000,min(24000,count*1000)),
                'text':{'format':{'type':'json_schema','name':'job_question','strict':True,'schema':schema}}})

        async def run(active):
            generated={}
            mapping_failure = 'unrecognized_question'
            if pending:
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
                    new.update(public_plans)
                    views={f['fieldId']:flexible.presentation(generated.get(f['fieldId']),f) for f in pending}
                    await database(cache.save_plans,pending,new,context,MODEL,views); plans.update(new); displays.update(views)
                except (httpx.HTTPError,ValueError,KeyError,TypeError) as error:
                    mapping_failure = 'ai_unavailable'
                    failures.append(record_failure(error,rid,'legacy'))
            if not await database(memory.current): raise ValueError('已存回答已改变，请重试；当前填写已保留')
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
                interruption = mapping_failure if mapping_failure == 'ai_unavailable' else 'answer_invalid' if fid in generated else 'draft_unavailable' if draft else 'missing_fact' if plan and plan['predicate']!='unknown' else 'answer_missing'
                reason = {'missing_fact':'已识别题目，但资料中缺少作答所需的事实', 'ai_unavailable':'AI 服务暂时不可用，当前填写已保留', 'answer_missing':'AI 没有返回这道题的有效回答，请重试', 'answer_invalid':'AI 返回的答案无法用于这道题，请重试', 'draft_unavailable':'开放题草稿未生成，请手动作答或重试'}[interruption]
                row=row or bindings.result(field,pid,version,reason=reason,route=plan['predicate'] if plan else 'unknown',interruption=interruption)
                origin=row['source']
                if candidate and row['value'] is not None and row['value']==candidate['value'] and generated[fid].get('basis')==origin:
                    row={**row,**{k:candidate[k] for k in ('questionZh','answerZh','reason') if k in candidate}}
                answers[fid]=flexible.display(row,field,displays.get(fid))
            if not await database(memory.current): raise ValueError('已存回答已改变，请重试；当前填写已保留')
            rows=[answers[f['fieldId']] for f in fields]
            await database(self.profile_gaps.record,pid,profile,fields,rows)
            await database(request_state,self.store,rid,'needs_input' if any(r['state']=='needs_input' for r in rows) else 'answer')
            if not batch:
                row=rows[0]
                if row['state']=='needs_input': raise ValueError('需要补充资料或本人回答')
                return {'text':row['value'],'source':row['source'],'responseId':rid,'remaining':None,'model':MODEL}
            return {'answers':rows,'responseId':rid,'model':MODEL,'answerUsage':usage, **({'answerDiagnostics':failures} if failures else {})}
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
