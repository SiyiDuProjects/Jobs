import asyncio
import json
import time
import httpx
import pytest
from jobs_radar.answer_bindings import BindingCache, answer, binding_key, checked, evaluate
from jobs_radar.answer_semantics import cache_key, MeaningCache
from jobs_radar.answers import Answers
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store

FIELD = dict(fieldId='f', question='Are you legally authorized to work in the United States?',
             description='', type='radio', required=True,
             options=[dict(value='n', label='No'), dict(value='y', label='Yes')])
MEANING = dict(topic='work_eligibility', country='US', company='', timeframe='current')
BINDING = dict(predicate='us_work_eligible', options=['false', 'true'])


class Client:
    def __init__(self, value='y', binding=BINDING, fail=False):
        self.calls = []; self.value = value; self.binding = binding; self.fail = fail
    async def post(self, url, json):
        self.calls.append(json)
        if self.fail:
            raise httpx.ReadTimeout('synthetic')
        request = __import__('json').loads(json['input'])
        if json['text']['format']['name'] == 'answer_evidence_check':
            body = {'checks': [dict(fieldId=c['field']['fieldId'], verdict='write', meaning=MEANING, binding=self.binding)
                               for c in request['candidates']]}
        else:
            body = {'answers': [dict(fieldId=f['fieldId'], state='answer', source='profile', value=self.value,
                                    reason='Explicit synthetic fact', meaning=MEANING,
                                    evidence=[{'profilePath': 'employmentData.eligibilityUS'}]) for f in request['fields']]}
        return httpx.Response(200, json={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps(body)}]}]})


def setup(tmp_path):
    store = Store(tmp_path / 'answers.sqlite')
    profile = {'profileName':'Synthetic', 'nameData':{}, 'addressData':{}, 'contactData':{},
               'jobData':[], 'educationData':[], 'languageData':[], 'resumeData':{}, 'websiteData':{},
               'employmentData':{'eligibilityUS':True}, 'skillsData':[]}
    record = Profiles(store).save(profile)
    payload = {'profileId':record['id'], 'profileVersion':record['last_sync'], 'fields':[FIELD]}
    return Answers(store), profile, payload


def run(answers, payload, client):
    return asyncio.run(answers.generate(payload, client))


def test_verified_cache_needs_zero_provider_calls_and_no_model_quota(tmp_path, monkeypatch):
    a, profile, payload = setup(tmp_path); first = Client()
    assert run(a, payload, first)['answers'][0]['decision'] == 'write'
    assert len(first.calls) == 2
    with a.store.connect(True) as c:
        c.executemany('INSERT INTO answer_requests VALUES(?,?,?)', [(str(i),time.time(),'fixture') for i in range(59)])
        cached = c.execute('SELECT binding FROM answer_bindings').fetchall()
        assert len(cached) == 1
        assert json.loads(cached[0][0]) == {'meaning': MEANING, 'binding': BINDING}
        assert all(value not in cached[0][0] for value in [payload['profileId'], 'eligibilityUS', 'Synthetic', 'noteQuote'])
    def no_key():
        raise AssertionError('Cached answers must not need provider credentials')
    monkeypatch.setattr('jobs_radar.answers.api_key', no_key)
    hit = asyncio.run(a.generate(payload))['answers'][0]
    assert hit['value'] == 'y' and hit['proof']['profileVersion'] == payload['profileVersion']
    with a.store.connect() as c:
        assert c.execute('SELECT count(*) FROM answer_requests').fetchone()[0] == 60


def test_cache_recomputes_false_and_pins_each_requested_revision(tmp_path):
    a, profile, payload = setup(tmp_path); run(a,payload,Client())
    profile['employmentData']['eligibilityUS'] = False
    newer = Profiles(a.store).save(profile,profile_id=payload['profileId'],expected_sync=payload['profileVersion'])
    no_calls = Client(fail=True)
    result = run(a,{**payload,'profileVersion':newer['last_sync']},no_calls)['answers'][0]
    assert result['value'] == 'n' and result['proof']['profileVersion'] == newer['last_sync']
    assert run(a,payload,no_calls)['answers'][0]['value'] == 'y'
    assert no_calls.calls == []


def test_missing_facts_and_unverified_legacy_hints_cannot_short_circuit(tmp_path):
    a, profile, payload = setup(tmp_path)
    client = Client(binding=None)
    run(a,payload,client); run(a,payload,client)
    assert len(client.calls) == 4
    run(a,payload,Client())
    profile['employmentData'] = {}
    version = Profiles(a.store).save(profile,profile_id=payload['profileId'],expected_sync=payload['profileVersion'])
    failed = Client(fail=True)
    with pytest.raises(ValueError):
        run(a,{**payload,'profileVersion':version['last_sync']},failed)
    assert len(failed.calls) == 1


@pytest.mark.parametrize('change', [
    {'jobCountry':'Canada'}, {'jobCountry':'US'},
    {'fields':[FIELD | {'required':False}]},
    {'fields':[FIELD | {'type':'select-one'}]},
    {'fields':[FIELD | {'description':'Without restrictions'}]},
    {'fields':[FIELD | {'question':'Do you have unrestricted rights to work?'}]},
    {'fields':[FIELD | {'options':list(reversed(FIELD['options']))}]},
    {'fields':[FIELD | {'options':[FIELD['options'][0],{'value':'y','label':'Yes, without restrictions'}]}]},
])
def test_complete_field_and_country_changes_miss_cache(tmp_path, change):
    a, _, payload = setup(tmp_path); run(a,payload,Client())
    failed = Client(fail=True)
    with pytest.raises(ValueError): run(a,payload | change,failed)
    assert len(failed.calls) == 1


def test_cross_company_option_ids_reuse_meaning_but_bind_current_values(tmp_path):
    a, profile, payload = setup(tmp_path)
    first = FIELD | {'type':'select-one', 'options':[
        {'label':'No', 'value':'118734001'}, {'label':'Yes', 'value':'118734002'}]}
    second = first | {'fieldId':'other-page', 'options':[
        {'label':'No', 'value':'998110001'}, {'label':'Yes', 'value':'998110002'}]}
    initial = payload | {'fields':[first], 'jobCountry':'US',
                         'jobUrl':'https://boards.greenhouse.io/first/jobs/100'}
    cold = Client(value='118734002')
    assert run(a,initial,cold)['answers'][0]['value']=='118734002'
    assert len(cold.calls)==2
    later = initial | {'fields':[second], 'jobUrl':'https://boards.greenhouse.io/second/jobs/200',
                       'jobTitle':'Another role', 'formContext':[{'question':'Name','answer':'Synthetic'}]}
    offline = Client(fail=True)
    current = run(a,later,offline)['answers'][0]
    assert current['value']=='998110002' and current['decision']=='write'
    from jobs_radar.answer_semantics import field_key
    assert current['proof']['field']==field_key(second)
    profile['employmentData']['eligibilityUS']=False
    newer=Profiles(a.store).save(profile,profile_id=payload['profileId'],expected_sync=payload['profileVersion'])
    assert run(a,later | {'profileVersion':newer['last_sync']},offline)['answers'][0]['value']=='998110001'
    assert offline.calls==[]


@pytest.mark.parametrize('key', [cache_key, binding_key])
@pytest.mark.parametrize('version', ['version', 'ruleVersion'])
def test_model_and_vocabulary_versions_invalidate_cache(key, version):
    from jobs_radar.answer_semantics import VOCABULARY
    assert key(FIELD,{},'one') != key(FIELD,{},'two')
    old = key(FIELD,{},'one'); VOCABULARY[version] += 1
    try: assert key(FIELD,{},'one') != old
    finally: VOCABULARY[version] -= 1


def test_mixed_batch_keeps_verified_hit_when_uncached_model_fails(tmp_path):
    a, _, payload = setup(tmp_path); run(a,payload,Client())
    other = FIELD | {'fieldId':'other','question':'Unrestricted right to work?'}
    failed = Client(fail=True)
    result = run(a,payload | {'fields':[other,FIELD]},failed)['answers']
    assert [r['fieldId'] for r in result] == ['other','f']
    assert result[0]['decision'] == 'ask' and result[0]['interruptionReason'] == 'control_failure'
    assert result[1]['decision'] == 'write' and result[1]['value'] == 'y'
    assert [f['fieldId'] for f in json.loads(failed.calls[0]['input'])['fields']] == ['other']


@pytest.mark.parametrize('predicate,profile,expected', [
    ('age_at_least_18',{'employmentData':{'age':17}},'false'),
    ('age_at_least_18',{'employmentData':{'age':'18'}},'true'),
    ('age_at_least_18',{'employmentData':{'age':'unknown'}},None),
    ('sponsorship_now',{'employmentData':{'sponsorship':True}},None),
    ('sponsorship_future',{'applicationData':{'sponsorshipNow':True}},None),
    ('sponsorship_either',{'applicationData':{'sponsorshipNow':False}},None),
    ('sponsorship_either',{'applicationData':{'sponsorshipNow':False,'sponsorshipFuture':False}},'false'),
    ('sponsorship_either',{'applicationData':{'sponsorshipFuture':True}},'true'),
    ('sponsorship_either',{'employmentData':{'sponsorship':True}},'true'),
    ('sponsorship_now',{'applicationData':{'sponsorshipNow':True},'employmentData':{'sponsorship':False}},None),
    ('sponsorship_either',{'applicationData':{'sponsorshipNow':False,'sponsorshipFuture':False},'employmentData':{'sponsorship':True}},None),
    ('currently_enrolled',{'educationData':[]},None),
    ('currently_enrolled',{'educationData':[{'currentlyAttending':False},{}]},None),
    ('currently_enrolled',{'educationData':[{'currentlyAttending':False}]},'false'),
    ('currently_enrolled',{'educationData':[{}, {'currentlyAttending':True}]},'true'),
    ('voluntary_hispanic',{'employmentData':{'hispanicOrLatino':False}},'false'),
    ('voluntary_hispanic',{'employmentData':{'ethnicity':'Asian'}},None),
    ('voluntary_current_disability',{'employmentData':{'disability':'undisclosed'}},'undisclosed'),
    ('voluntary_race',{'employmentData':{'ethnicity':'Asian (not Hispanic)'}},None),
])
def test_closed_fact_evaluation_does_not_infer_unknown_scopes(predicate, profile, expected):
    result = evaluate(predicate,profile)
    assert (result[0] if result else None) == expected


@pytest.mark.parametrize('predicate', ['itar','unrestricted_work_right','veteran','protected_veteran','medical_history','criminal_history','application_terms'])
def test_excluded_predicates_never_execute(predicate):
    assert checked(BINDING | {'predicate':predicate},MEANING,FIELD) is None


def test_ambiguous_options_and_wrong_topic_cannot_execute():
    assert checked(BINDING | {'options':['true','true']},MEANING,FIELD) is None
    assert checked(BINDING,MEANING | {'topic':'citizenship'},FIELD) is None
    assert checked(BINDING,MEANING | {'country':'CA'},FIELD) is None
    assert checked(BINDING,MEANING | {'company':'named'},FIELD) is None
    assert answer(BINDING,MEANING,FIELD,{},'p','v') is None


def test_saved_statement_or_excess_records_keeps_semantic_verification(tmp_path):
    a, profile, payload = setup(tmp_path); run(a,payload,Client())
    context = {'additionalContext':'','jobTitle':'','jobDescription':'','formContext':[],
               'jobContext':{'jobKey':'','companyKey':'','country':''}}
    cache = BindingCache(a.store)
    for saved in [{'f':{'person':'conflicting statement'}}, {}]:
        assert cache.read([FIELD],context,'gpt-6-luna',profile,payload['profileId'],payload['profileVersion'],saved) == {}


def test_age_hispanic_evidence_never_authorizes_legal_topics():
    from jobs_radar.answer_evidence import decide
    profile = {'employmentData':{'age':25,'hispanicOrLatino':False}}
    for path,topic in [('employmentData.age','age'),('employmentData.hispanicOrLatino','hispanic_latino')]:
        row = dict(fieldId='f',state='answer',value='n',source='profile',evidence=[{'profilePath':path}])
        for meaning_topic in [topic,'citizenship','work_eligibility','unrestricted_work_right','visa_status']:
            result = decide(row,FIELD,profile,'p','v',{'verdict':'write','meaning':MEANING | {'topic':meaning_topic}})
            assert (result['decision']=='write') == (meaning_topic==topic)


def test_uncached_work_keeps_sixty_model_batch_limit(tmp_path):
    a, _, payload = setup(tmp_path)
    with a.store.connect(True) as c:
        c.executemany('INSERT INTO answer_requests VALUES(?,?,?)',[(str(i),time.time(),'fixture') for i in range(60)])
    client=Client()
    with pytest.raises(ValueError,match='本小时 AI 请求'): run(a,payload,client)
    assert client.calls==[]


@pytest.mark.parametrize('relevant', [True,False])
def test_only_relevant_person_statement_during_model_wait_invalidates_cached_result(tmp_path, relevant):
    a, _, payload = setup(tmp_path); run(a,payload,Client())
    statement=dict(key='new-person-answer',question=FIELD['question'] if relevant else 'Unrelated question',
                   response='No',origin='person',scope='global',context={'capturedAt':'2026-10-01T00:00:00Z'})
    class Changed(Client):
        async def post(self,url,json):
            with a.store.connect(True) as c:
                c.execute('CREATE TABLE management_documents(key TEXT PRIMARY KEY,value TEXT,revision INTEGER)')
                c.execute('INSERT INTO management_documents VALUES(?,?,?)',
                          ('jobsResponses:'+payload['profileId'],__import__('json').dumps([statement]),1))
            raise httpx.ReadTimeout('synthetic')
    other=FIELD | {'fieldId':'other','question':'Another question'}
    if relevant:
        with pytest.raises(ValueError,match='已存答案在核验期间改变'):
            run(a,payload | {'fields':[FIELD,other]},Changed())
    else:
        result=run(a,payload | {'fields':[FIELD,other]},Changed())['answers']
        assert result[0]['decision']=='write' and result[0]['value']=='y'
        assert result[1]['decision']=='ask' and result[1]['value'] is None


def test_verified_binding_survives_job_company_and_form_progress_changes(tmp_path):
    a, profile, payload = setup(tmp_path)
    first_payload = payload | {
        'jobCountry':'US', 'jobUrl':'https://jobs.lever.co/first-company/role-one',
        'jobTitle':'Software Engineer', 'jobDescription':'First role description',
        'additionalContext':'Application one', 'formContext':[],
    }
    cold = Client()
    assert run(a,first_payload,cold)['answers'][0]['decision']=='write'
    assert len(cold.calls)==2
    later = first_payload | {'formContext':[{'question':'First name','answer':'Synthetic'}]}
    for current in [later,
                    later | {'jobUrl':'https://jobs.lever.co/first-company/role-two','jobTitle':'Backend Engineer','jobDescription':'Second role description'},
                    later | {'jobUrl':'https://jobs.lever.co/second-company/role-three','jobTitle':'Platform Engineer','jobDescription':'Third role description','additionalContext':'Application three','fields':[FIELD | {'fieldId':'other-page-field'}]}]:
        offline = Client(fail=True)
        answer = run(a,current,offline)['answers'][0]
        assert answer['decision']=='write' and answer['value']=='y'
        assert answer['fieldId']==current['fields'][0]['fieldId']
        assert answer['proof']['profileVersion']==payload['profileVersion']
        assert offline.calls==[]
    profile['employmentData']['eligibilityUS']=False
    newer=Profiles(a.store).save(profile,profile_id=payload['profileId'],expected_sync=payload['profileVersion'])
    offline=Client(fail=True)
    answer=run(a,current | {'profileVersion':newer['last_sync']},offline)['answers'][0]
    assert answer['value']=='n' and answer['proof']['profileVersion']==newer['last_sync']
    assert offline.calls==[]
    with a.store.connect() as connection:
        assert connection.execute('SELECT count(*) FROM answer_requests').fetchone()[0]==1


def test_meaning_hints_keep_full_context_while_bindings_use_public_scope(tmp_path):
    from jobs_radar.answers import MODEL
    a, profile, payload=setup(tmp_path)
    contexts=[{'jobTitle':'First role','jobDescription':'First description','additionalContext':'First application','formContext':[],
               'jobContext':{'jobKey':'lever:first/one','companyKey':'lever:first','country':'US'}},
              {'jobTitle':'Second role','jobDescription':'Second description','additionalContext':'Second application',
               'formContext':[{'question':'Name','answer':'Synthetic'}],
               'jobContext':{'jobKey':'lever:second/two','companyKey':'lever:second','country':'US'}}]
    hints=MeaningCache(a.store)
    hints.save([FIELD],[{'fieldId':'f','meaning':MEANING}],contexts[0],MODEL)
    assert hints.read([FIELD],contexts[0],MODEL)=={'f':MEANING}
    assert hints.read([FIELD],contexts[1],MODEL)=={}
    assert binding_key(FIELD,contexts[0],MODEL)==binding_key(FIELD,contexts[1],MODEL)


def test_old_context_bound_plan_is_not_promoted_without_new_verification(tmp_path):
    from jobs_radar.answers import MODEL
    a, profile, payload=setup(tmp_path)
    context={'additionalContext':'','jobTitle':'','jobDescription':'','formContext':[],
             'jobContext':{'jobKey':'','companyKey':'','country':''}}
    bindings=BindingCache(a.store)
    with a.store.connect(True) as connection:
        connection.execute('INSERT INTO answer_bindings VALUES(?,?)',
                           (cache_key(FIELD,context,MODEL),json.dumps({'meaning':MEANING,'binding':BINDING})))
    assert bindings.read([FIELD],context,MODEL,profile,payload['profileId'],payload['profileVersion'],{'f':{}})=={}
    client=Client()
    assert run(a,payload,client)['answers'][0]['decision']=='write'
    assert len(client.calls)==2
    assert run(a,payload,client)['answers'][0]['decision']=='write'
    assert len(client.calls)==2


def test_context_dependent_verdict_is_not_cached_as_a_binding(tmp_path):
    a, _, payload=setup(tmp_path)
    payload=payload | {'fields':[FIELD | {'question':'Are you eligible under the conditions above?'}],
                       'jobTitle':'First role','jobDescription':'First conditions',
                       'formContext':[{'question':'Conditions','answer':'First answer'}]}
    client=Client(binding=None)
    for current in [payload,payload | {'jobTitle':'Second role','jobDescription':'Second conditions',
                                      'formContext':[{'question':'Conditions','answer':'Second answer'}]}]:
        assert run(a,current,client)['answers'][0]['decision']=='write'
        verifier_input=json.loads(client.calls[-1]['input'])
        assert verifier_input['context']['formContext']==current['formContext']
        assert verifier_input['context']['jobDescription']==current['jobDescription']
    assert len(client.calls)==4
    with a.store.connect() as connection:
        assert connection.execute('SELECT count(*) FROM answer_bindings').fetchone()[0]==0


def test_option_labels_normalize_only_display_space_and_canonical_unicode():
    labels = FIELD | {'options':[{'value':'a','label':'  No\u00a0  '}, {'value':'b','label':' Ye\u0301s  '}]}
    equivalent = FIELD | {'options':[{'value':'100','label':'No'}, {'value':'200','label':'Yés'}]}
    assert binding_key(labels,{},'model')==binding_key(equivalent,{},'model')
    for label in ['Not Yés','Yés, unrestricted','YES']:
        changed = equivalent | {'options':[equivalent['options'][0],{'value':'200','label':label}]}
        assert binding_key(labels,{},'model')!=binding_key(changed,{},'model')
    # The proof and advisory hint cache still distinguish the exact page values.
    assert cache_key(labels,{},'model')!=cache_key(equivalent,{},'model')


@pytest.mark.parametrize('labels', [['No',' No '], ['', 'Yes'], ['\u00a0','Yes']])
def test_blank_or_duplicate_normalized_option_labels_are_not_reusable(labels):
    field=FIELD | {'options':[{'value':str(i),'label':label} for i,label in enumerate(labels)]}
    assert checked(BINDING,MEANING,field) is None


def test_previous_value_bound_namespace_is_not_promoted(tmp_path):
    from jobs_radar.answers import MODEL
    a, _, payload=setup(tmp_path)
    BindingCache(a.store)
    with a.store.connect(True) as c:
        c.execute('INSERT INTO answer_bindings VALUES(?,?)',
                  (cache_key(FIELD,{'bindingVersion':2,'country':''},MODEL),
                   json.dumps({'meaning':MEANING,'binding':BINDING})))
    client=Client()
    assert run(a,payload,client)['answers'][0]['decision']=='write'
    assert len(client.calls)==2


def test_batch_usage_distinguishes_cold_cached_mixed_and_quota_blocked(tmp_path):
    a, _, payload=setup(tmp_path)
    assert run(a,payload,Client())['answerUsage']==dict(fieldCount=1,cacheHits=0,modelFields=1,modelCalls=2)
    assert run(a,payload,Client(fail=True))['answerUsage']==dict(fieldCount=1,cacheHits=1,modelFields=0,modelCalls=0)
    other=FIELD | {'fieldId':'other','question':'A different question?'}
    mixed=payload | {'fields':[FIELD,other]}
    assert run(a,mixed,Client(fail=True))['answerUsage']==dict(fieldCount=2,cacheHits=1,modelFields=1,modelCalls=1)
    assert run(a,mixed,Client(binding=None))['answerUsage']==dict(fieldCount=2,cacheHits=1,modelFields=1,modelCalls=2)
    with a.store.connect(True) as c:
        c.executemany('INSERT INTO answer_requests VALUES(?,?,?)',[(str(i),time.time(),'fixture') for i in range(60)])
    assert run(a,mixed,Client(fail=True))['answerUsage']==dict(fieldCount=2,cacheHits=1,modelFields=0,modelCalls=0)
    with pytest.raises(ValueError) as error: run(a,payload | {'fields':[other]},Client(fail=True))
    assert error.value.answer_usage==dict(fieldCount=1,cacheHits=0,modelFields=0,modelCalls=0)


@pytest.mark.parametrize('fail_at', [1,2])
def test_batch_usage_counts_failed_generation_or_verification_attempts(tmp_path,fail_at):
    a, _, payload=setup(tmp_path)
    class Failing(Client):
        async def post(self,url,json):
            self.fail=len(self.calls)+1==fail_at
            return await super().post(url,json)
    client=Failing()
    if fail_at==1:
        with pytest.raises(ValueError) as error: run(a,payload,client)
        usage=error.value.answer_usage
    else:
        result=run(a,payload,client)
        assert result['answers'][0]['decision']=='ask'
        usage=result['answerUsage']
    assert usage==dict(fieldCount=1,cacheHits=0,modelFields=1,modelCalls=fail_at)
    assert len(client.calls)==fail_at


def test_no_verifier_candidates_count_only_generation(tmp_path):
    a, _, payload=setup(tmp_path)
    class Missing(Client):
        async def post(self,url,json):
            self.calls.append(json)
            return httpx.Response(200,json={'status':'completed','output':[{'content':[{
                'type':'output_text','text':__import__('json').dumps({'answers':[dict(
                    fieldId='f',state='needs_input',value=None,source='unknown',reason='Missing fact',
                    evidence=[],meaning=MEANING)]})}]}]})
    client=Missing()
    result=run(a,payload,client)
    assert result['answerUsage']==dict(fieldCount=1,cacheHits=0,modelFields=1,modelCalls=1)
    assert len(client.calls)==1


@pytest.mark.parametrize('timeout', [False,True])
def test_failed_job_persists_actual_usage_without_replaying(tmp_path,monkeypatch,timeout):
    import uuid
    from jobs_radar.answer_jobs import AnswerJobs
    a, _, payload=setup(tmp_path)
    class Slow(Client):
        async def post(self,url,json):
            self.calls.append(json)
            await asyncio.sleep(10)
    client=Slow() if timeout else Client(fail=True)
    original=a.generate
    async def measured(payload): return await original(payload,client)
    a.generate=measured
    if timeout: monkeypatch.setattr('jobs_radar.answer_jobs.ANSWER_TIMEOUT_SECONDS',0.02)
    async def scenario():
        jobs=AnswerJobs(a.store,a)
        request=payload | {'requestId':str(uuid.uuid4())}
        jobs.start(request)
        await asyncio.gather(*list(jobs.tasks.values()))
        result=jobs.status(request['requestId'])
        assert result['state']=='failed'
        assert result['result']['answerUsage']==dict(fieldCount=1,cacheHits=0,modelFields=1,modelCalls=1)
        assert AnswerJobs(a.store,a).start(request)==result
        assert len(client.calls)==1
    asyncio.run(scenario())
