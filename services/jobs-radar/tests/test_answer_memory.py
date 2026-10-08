import asyncio
import copy
import json
import httpx
import pytest
from jobs_radar.answer_memory import AnswerMemory, company_key, request_context
from jobs_radar.answer_evidence import decide, resolve
from jobs_radar.management import Management
from jobs_radar.job_match import job_key
from jobs_radar.profiles import Profiles
from test_answers import setup

URL = 'https://jobs.ashbyhq.com/example/first/application'
OTHER = 'https://jobs.ashbyhq.com/example/second/application'
QUESTION = 'Are you subject to any healthcare program exclusion?'
FIELD = dict(fieldId='health', question=QUESTION, description='', type='radio', required=True,
             options=[dict(value='no', label='No'), dict(value='yes', label='Yes')])


def record(**patch):
    return dict(key='person-answer', question=QUESTION, response='No', origin='person', scope='company', ruleVersion=3,
                jobKey=job_key(URL), context={'jobKey': job_key(URL), 'companyKey': company_key(job_key(URL)),
                'country': 'US', 'capturedAt': '2026-10-01T00:00:00Z'}) | patch


def prepare(tmp_path, rows=None):
    answers, payload = setup(tmp_path)
    payload = {k: v for k, v in payload.items() if k != 'prompt'}
    payload.update(fields=[copy.deepcopy(FIELD)], jobUrl=OTHER, jobCountry='US')
    management = Management(answers.store)
    key = 'jobsResponses:' + payload['profileId']
    management.write([dict(key=key, revision=0, value=rows if rows is not None else [record()])])
    return answers, payload, management, key


class Client:
    def __init__(self, verdict='write', changed=None):
        self.calls = []; self.verdict = verdict; self.changed = changed; self.topic = 'medical_history'
    async def post(self, url, json):
        self.calls.append(json)
        payload = __import__('json').loads(json['input'])
        if 'candidates' in payload:
            body = {'checks': [dict(fieldId='health', verdict=self.verdict,
                       meaning=dict(topic=self.topic, country='US', company='named', timeframe='current'))]}
            if self.changed: self.changed()
        else:
            refs = payload.get('recordedAnswers', {}).get('health', [])
            body = {'answers': [dict(fieldId='health', state='answer' if refs else 'needs_input',
                value='no' if refs else None, source='profile' if refs else 'unknown', reason='Synthetic',
                needsConfirmation=False, evidence=[{'savedResponse': refs[0]['savedResponse']}] if refs else [],
                meaning=dict(topic=self.topic, country='US', company='named', timeframe='current'))]}
        return httpx.Response(200, json={'status': 'completed', 'output': [{'content': [
            {'type': 'output_text', 'text': __import__('json').dumps(body)}]}]})


def test_only_matching_person_records_reach_generator_and_verifier_and_are_not_relearned(tmp_path):
    wrong = record(key='irrelevant', question='An unrelated personal question', response='Unrelated secret')
    answers, payload, management, key = prepare(tmp_path, [record(), wrong, record(key='agent',origin='agent',response='AI secret')])
    other = Profiles(answers.store).save(Profiles(answers.store).at_version(payload['profileId'], payload['profileVersion']))
    management.write([dict(key='jobsResponses:' + other['id'], revision=0, value=[record(response='Other Profile secret')])])
    before = management.snapshot()[key]
    client = Client(); result = asyncio.run(answers.generate(payload, client))['answers'][0]
    assert result['decision'] == 'write' and result['value'] == 'no' and not result['needsConfirmation']
    assert len(client.calls) == 2 and all(call['store'] is False for call in client.calls)
    raw = json.dumps(client.calls)
    assert all(value not in raw for value in ['Unrelated secret', 'AI secret', 'Other Profile secret'])
    sent = json.loads(client.calls[1]['input'])['candidates'][0]
    assert sent['recordedAnswers'][0]['origin'] == 'person'
    assert sent['recordedAnswers'][0]['context']['capturedAt'] == '2026-10-01T00:00:00Z'
    assert sent['context']['jobKey'] == job_key(OTHER)
    assert 'question' not in result['proof'] and 'response' not in json.dumps(result['proof'])
    assert management.snapshot()[key] == before
    with answers.store.connect() as c:
        assert c.execute('SELECT count(*) FROM answer_profile_gaps').fetchone()[0] == 0
        cached = str([tuple(row) for row in c.execute('SELECT * FROM answer_meanings')])
        assert QUESTION not in cached and 'capturedAt' not in cached


@pytest.mark.parametrize('patch', [
    {'origin':'agent'}, {'origin':'page-tool'}, {'origin':'legacy'}, {'origin':None},
    {'question':QUESTION+' and all prior investigations?'}, {'scope':'job'}, {'scope':None},
    {'context':{'country':'CA','capturedAt':'2026-10-01T00:00:00Z'}},
    {'context':{'country':'US'}}, {'context':{'country':'US','capturedAt':'invalid'}},
    {'context':{'country':'US','capturedAt':'2999-01-01T00:00:00Z'}},
    {'jobKey':job_key('https://jobs.ashbyhq.com/other/first')},
])
def test_unknown_origin_scope_time_wrong_company_and_changed_question_never_leave(tmp_path, patch):
    row=record(**patch)
    row={k:v for k,v in row.items() if v is not None}
    answers,payload,_,_=prepare(tmp_path,[row]); client=Client()
    result=asyncio.run(answers.generate(payload,client))['answers'][0]
    assert result['decision']=='ask' and result['value'] is None
    assert len(client.calls)==1
    assert 'recordedAnswers' not in json.loads(client.calls[0]['input'])


def test_same_job_company_and_explicit_global_keep_their_original_boundaries(tmp_path):
    answers,payload,_,_=prepare(tmp_path,[record(scope='job')])
    assert not AnswerMemory(answers.store,payload['profileId'],[FIELD],request_context(payload)).prompt()
    assert AnswerMemory(answers.store,payload['profileId'],[FIELD],request_context(payload|{'jobUrl':URL})).prompt()
    global_row=record(scope='global',jobKey='',context={'capturedAt':'2026-10-01T00:00:00Z'})
    assert global_row['scope']=='global'
    from jobs_radar.answer_memory import applies
    assert applies(global_row,request_context({'jobUrl':OTHER,'jobCountry':'CA'}))
    assert not applies(record(),request_context({'jobUrl':OTHER,'jobCountry':''}))
    assert not applies(record(),request_context({'jobUrl':OTHER,'jobCountry':'MIXED'}))


def test_reference_cannot_be_forged_or_borrowed_from_another_question(tmp_path):
    answers,payload,_,_=prepare(tmp_path)
    memory=AnswerMemory(answers.store,payload['profileId'],[FIELD],request_context(payload))
    ident=next(iter(memory.by_field['health']))
    assert resolve([{'savedResponse':ident}],{},memory.by_field['health'])
    assert resolve([{'savedResponse':ident}],{}, {}) is None
    assert resolve([{'savedResponse':'invented'}],{},memory.by_field['health']) is None
    row=dict(fieldId='health',state='answer',source='profile',value='no',evidence=[{'savedResponse':ident}])
    check={'verdict':'write','meaning':dict(topic='medical_history',country='US',company='named',timeframe='current')}
    assert decide(row,FIELD,{},'p','v',check,{})['decision']=='ask'
    check['meaning']['topic']='acknowledgment'
    assert decide(row,FIELD,{},'p','v',check,memory.by_field['health'])['decision']=='ask'


def test_complete_options_and_date_qualifiers_can_reject_an_exact_question_match(tmp_path):
    answers,payload,_,_=prepare(tmp_path)
    payload['fields'][0]['options'][0]['label']='No current or past exclusion or pending investigation'
    client=Client('missing_fact');row=asyncio.run(answers.generate(payload,client))['answers'][0]
    assert row['decision']=='ask' and row['value'] is None
    sent=json.loads(client.calls[1]['input'])['candidates'][0]
    assert sent['field']['options'][0]['label'].endswith('pending investigation')
    assert sent['evidence'][0]['response']=='No'


def test_current_structured_facts_and_all_conflicting_records_reach_verification(tmp_path):
    answers,payload,_,_=prepare(tmp_path,[record(),record(key='later',response='Yes')])
    profile=Profiles(answers.store).at_version(payload['profileId'],payload['profileVersion'])
    profile['applicationData']={'willingToRelocate':True}
    updated=Profiles(answers.store).save(profile,profile_id=payload['profileId'],expected_sync=payload['profileVersion'])
    payload['profileVersion']=updated['last_sync']
    client=Client('missing_fact');client.topic='work_preference'
    result=asyncio.run(answers.generate(payload,client))['answers'][0]
    sent=json.loads(client.calls[1]['input'])['candidates'][0]
    assert sent['profileEvidence']==[{'profilePath':'applicationData.willingToRelocate','value':True}]
    assert {item['response'] for item in sent['recordedAnswers']}=={'No','Yes'}
    assert result['decision']=='ask' and result['value'] is None


def test_saved_record_changes_during_verification_invalidate_the_pending_answer(tmp_path):
    answers,payload,management,key=prepare(tmp_path)
    def changed(): management.write([dict(key=key,revision=1,value=[record(response='Yes')])])
    with pytest.raises(ValueError,match='已存答案在核验期间改变'):
        asyncio.run(answers.generate(payload,Client(changed=changed)))


def test_edit_after_generation_stops_before_another_provider_call(tmp_path):
    answers,payload,management,key=prepare(tmp_path)
    class ChangingClient(Client):
        async def post(self,url,json):
            response=await super().post(url,json)
            management.write([dict(key=key,revision=1,value=[])])
            return response
    client=ChangingClient()
    with pytest.raises(ValueError,match='已存答案在核验期间改变'):
        asyncio.run(answers.generate(payload,client))
    assert len(client.calls)==1


def test_excess_matching_records_are_not_partially_selected(tmp_path):
    answers,payload,_,_=prepare(tmp_path,[record(key=str(i),response='No '+str(i)) for i in range(9)])
    memory=AnswerMemory(answers.store,payload['profileId'],[FIELD],request_context(payload))
    assert not memory.prompt()
