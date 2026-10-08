import asyncio
import json
import time
import httpx
import pytest
from jobs_radar.answer_bindings import BindingCache, answer, checked, evaluate
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
    {'jobCountry':'Canada'}, {'jobUrl':'https://jobs.lever.co/other-company/a'},
    {'formContext':[{'question':'Conditions','answer':'Additional restriction'}]},
    {'jobTitle':'Different role'}, {'additionalContext':'Different context'},
    {'fields':[FIELD | {'required':False}]},
    {'fields':[FIELD | {'description':'Without restrictions'}]},
    {'fields':[FIELD | {'question':'Do you have unrestricted rights to work?'}]},
    {'fields':[FIELD | {'options':list(reversed(FIELD['options']))}]},
])
def test_complete_field_and_context_changes_miss_cache(tmp_path, change):
    a, _, payload = setup(tmp_path); run(a,payload,Client())
    failed = Client(fail=True)
    with pytest.raises(ValueError): run(a,payload | change,failed)
    assert len(failed.calls) == 1


def test_model_and_vocabulary_versions_invalidate_cache():
    from jobs_radar.answer_semantics import VOCABULARY
    assert cache_key(FIELD,{},'one') != cache_key(FIELD,{},'two')
    old = cache_key(FIELD,{},'one'); VOCABULARY['ruleVersion'] += 1
    try: assert cache_key(FIELD,{},'one') != old
    finally: VOCABULARY['ruleVersion'] -= 1


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


def test_new_person_statement_during_model_wait_invalidates_cached_result(tmp_path):
    a, _, payload = setup(tmp_path); run(a,payload,Client())
    class Changed(Client):
        async def post(self,url,json):
            with a.store.connect(True) as c:
                c.execute('CREATE TABLE management_documents(key TEXT PRIMARY KEY,value TEXT,revision INTEGER)')
                c.execute('INSERT INTO management_documents VALUES(?,?,?)',('jobsResponses:'+payload['profileId'],'[]',1))
            raise httpx.ReadTimeout('synthetic')
    other=FIELD | {'fieldId':'other','question':'Another question'}
    with pytest.raises(ValueError,match='已存答案在核验期间改变'):
        run(a,payload | {'fields':[FIELD,other]},Changed())
