import asyncio
import json
import re
import time
from datetime import datetime, timezone, timedelta
import httpx
from jobs_radar.answers import Answers
from jobs_radar.ai_answers import INSTRUCTIONS, checked
from jobs_radar.profile_text import render_profile
from jobs_radar.saved_answers import request_context
from jobs_radar.management import Management
from test_answers import setup, field, save

class Client:
    def __init__(self, rows, fail=False): self.rows,self.calls,self.fail=rows,[],fail
    async def post(self,url,json):
        self.calls.append(json)
        if self.fail: raise httpx.ReadTimeout('fixture')
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps({'answers':self.rows})}]}]})

def answer(fid='eligible', **patch):
    return dict(fieldId=fid,kind='answer',value='y',questionZh='是否有工作许可',answerZh='是',reasonZh='根据当前资料',jobSpecific=False,signingDate=False)|patch

def run(a,p,client=None,fields=None,**patch):
    return asyncio.run(Answers(a.store,flow='simple').generate(dict(**p,answerProtocol=3,fields=fields or [field()],**patch),client))

def document(a,p,rows):
    Management(a.store)
    with a.store.connect(True) as c:
        c.execute('INSERT OR REPLACE INTO management_documents VALUES(?,?,?)',('jobsResponses:'+p['profileId'],json.dumps(rows),1))

def test_readable_profile_has_no_enums_and_keeps_false(tmp_path):
    from jobs_radar.profiles import Profiles
    a,p=setup(tmp_path)
    base=Profiles(a.store).at_version(p["profileId"],p["profileVersion"])
    text=render_profile({**base, 'employmentData':{'eligibilityUS':False,'identityDefaults':'cis_heterosexual'},'applicationData':{'salaryPreference':'posted_range','salaryPeriod':'annual_base','defaultAnswers':['clearance']}})
    assert 'No' in text and 'have not held a security clearance' in text
    assert not any(v in text for v in ['posted_range','annual_base','cis_heterosexual'])

def test_prompt_general_and_short():
    assert len(INSTRUCTIONS.splitlines())<=30
    assert not re.search(r'Lucid|Handshake|Northrop|Proofpoint|Petra|False Claims|One Badge',INSTRUCTIONS,re.I)

def test_isolated_failure_and_unknown_have_chinese(tmp_path):
    a,p=setup(tmp_path)
    result=run(a,p,Client([answer('one'),answer('two',value='invented'),answer('three',kind='unknown',value=None,reasonZh='资料缺少此项')]),[field(x) for x in ['one','two','three']])
    rows=result['answers']; assert [r['kind'] for r in rows]==['answer','unknown','unknown']
    assert all(r['reasonZh'] for r in rows) and result['answerUsage']['modelCalls']==1

def test_cache_scope_profile_memory_and_job(tmp_path):
    a,p=setup(tmp_path);c=Client([answer()]); url='https://jobs.ashbyhq.com/example/11111111-1111-1111-1111-111111111111/application'
    first=run(a,p,c,jobUrl=url,jobCountry='US')
    assert first['answers'][0]['binding']['profileVersion']==p['profileVersion']
    assert run(a,p,None,jobUrl=url,jobCountry='US')['answerUsage']['modelCalls']==0
    assert run(a,p,c,jobUrl=url,jobCountry='CA')['answerUsage']['modelCalls']==1
    newer=save(a,p,employmentData={'eligibilityUS':True})
    assert run(a,newer,c,jobUrl=url,jobCountry='US')['answerUsage']['modelCalls']==1
    document(a,newer,[])
    assert run(a,newer,c,jobUrl=url,jobCountry='US')['answerUsage']['modelCalls']==0
    c=Client([answer(jobSpecific=True)]); run(a,newer,c,jobUrl=url,jobCountry='GB')
    assert run(a,newer,c,jobUrl=url.replace('11111111','22222222'),jobCountry='GB')['answerUsage']['modelCalls']==1

def test_all_historical_origins_are_model_inputs(tmp_path):
    a,p=setup(tmp_path)
    document(a,p,[{'question':field()['question'],'response':'No','origin':origin} for origin in ['person','agent','legacy']])
    c=Client([answer()]);run(a,p,c)
    past=json.loads(c.calls[0]['input'])['pastAnswers']['eligible']
    assert {r['origin'] for r in past}=={'person','agent','legacy'}

def test_person_exact_after_profile_needs_no_provider_and_invalidates(tmp_path):
    a,p=setup(tmp_path);url='https://jobs.ashbyhq.com/example/11111111-1111-1111-1111-111111111111/application'
    context=request_context({'jobUrl':url,'jobCountry':'US'})
    captured=(datetime.now(timezone.utc)+timedelta(seconds=1)).isoformat()
    row={'question':field()['question'],'response':'Yes','origin':'person','options':['No','Yes'],'jobKey':context['jobKey'],'context':{**context,'capturedAt':captured},'questionZh':'是否有工作许可','answerZh':'是'}
    document(a,p,[row]);result=run(a,p,None,jobUrl=url,jobCountry='US')
    assert result['answers'][0]['value']=='y' and result['answerUsage']['modelCalls']==0
    row['context']['capturedAt']='2020-01-01T00:00:00Z';document(a,p,[row])
    c=Client([answer(value='n')]);assert run(a,p,c,jobUrl=url,jobCountry='US')['answers'][0]['value']=='n'

def test_exact_dates_do_not_use_answer_capture_timestamp(tmp_path):
    a,p=setup(tmp_path);f=field(type='date',options=[],question='Availability date')
    document(a,p,[{'question':'Availability date','response':'May 2027','context':{'capturedAt':'2027-05-21T12:00:00Z'}}])
    assert run(a,p,Client([answer(value='2027-05-21')]),[f])['answers'][0]['kind']=='unknown'
    row=checked(answer(value='2027-05-21',signingDate=True),f,p['profileId'],p['profileVersion'],set(),'2027-05-21')
    assert row['kind']=='answer'

def test_provider_failure_distinct_from_missing_profile(tmp_path):
    a,p=setup(tmp_path);row=run(a,p,Client([],fail=True))['answers'][0]
    assert row['kind']=='unknown' and row['interruptionReason']=='ai_unavailable'

def test_hourly_volume_does_not_block_simple_answers(tmp_path):
    a,p=setup(tmp_path)
    with a.store.connect(True) as c:
        c.executemany('INSERT INTO answer_requests VALUES(?,?,?)', [(str(i),time.time(),'started') for i in range(60)])
    client=Client([answer()]);result=run(a,p,client)
    assert result['answers'][0]['value']=='y' and result['answers'][0]['kind']=='answer'
    assert len(client.calls)==1 and result['answerUsage']['modelCalls']==1

def test_legacy_returns_same_wire_contract(tmp_path):
    from test_answers import Client as LegacyClient
    a,p=setup(tmp_path);p=save(a,p,employmentData={'eligibilityUS':True})
    response=asyncio.run(Answers(a.store,flow='legacy').generate(dict(**p,answerProtocol=3,fields=[field()]),LegacyClient()))
    row=response['answers'][0]
    assert row['kind']=='answer' and row['binding']['field']==field()
    assert not any(k in row for k in ['proof','decision','verification'])


def test_unrelated_saved_answer_write_does_not_cancel_or_invalidate_cached_batch(tmp_path):
    a,p=setup(tmp_path)
    class Updating(Client):
        async def post(self,url,json):
            document(a,p,[{'question':'Favorite office snack','response':'Fruit','origin':'person'}])
            return await super().post(url,json)
    result=run(a,p,Updating([answer('one'),answer('two')]),[field('one'),field('two')])
    assert all(row['kind']=='answer' for row in result['answers'])
    assert run(a,p,None,[field('one')])['answerUsage']['modelCalls']==0


def test_relevant_answer_change_invalidates_only_that_question(tmp_path):
    a,p=setup(tmp_path)
    class Updating(Client):
        async def post(self,url,json):
            document(a,p,[{'question':field()['question'],'response':'No','origin':'person'}])
            return await super().post(url,json)
    fields=[field('one'),field('two',question='Do you prefer remote meetings?')]
    rows=run(a,p,Updating([answer('one'),answer('two')]),fields)['answers']
    assert rows[0]['kind']=='unknown' and rows[0]['interruptionReason']=='saved_answer_changed'
    assert rows[1]['kind']=='answer'


def test_option_ids_can_change_without_missing_the_cache(tmp_path):
    a,p=setup(tmp_path);run(a,p,Client([answer()]))
    fresh=field(options=[{'label':'No','value':'fresh-n'},{'label':'Yes','value':'fresh-y'}])
    row=run(a,p,None,[fresh])['answers'][0]
    assert row['value']=='fresh-y' and row['binding']['field']==fresh


def test_cached_choice_labels_must_remain_unambiguous(tmp_path):
    a,p=setup(tmp_path);run(a,p,Client([answer()]))
    repeated=field(options=[{'label':'No','value':'n'},{'label':'Yes','value':'y1'},{'label':'Yes','value':'y2'}])
    response=run(a,p,Client([answer(value='y1')]),[repeated])
    assert response['answerUsage']['modelCalls']==1
    # Ambiguous label mappings are not cached for a later page's identifiers.
    assert run(a,p,Client([answer(value='y2')]),[repeated])['answerUsage']['modelCalls']==1


def test_job_cache_ignores_day_and_timezone_but_retains_other_context(tmp_path):
    a,p=setup(tmp_path);c=Client([answer(jobSpecific=True)])
    run(a,p,c,additionalContext=json.dumps({'currentLocalDate':'2026-10-10','timeZone':'America/Los_Angeles','company':'Example'}))
    response=run(a,p,None,additionalContext=json.dumps({'currentLocalDate':'2026-10-11','timeZone':'UTC','company':'Example'}))
    assert response['answerUsage']['cacheHits']==1
    response=run(a,p,c,additionalContext=json.dumps({'currentLocalDate':'2026-10-11','company':'Another'}))
    assert response['answerUsage']['modelCalls']==1


def test_saved_text_is_checked_before_direct_reuse(tmp_path):
    a,p=setup(tmp_path);url='https://jobs.ashbyhq.com/example/11111111-1111-1111-1111-111111111111/application'
    f=field(type='text',options=[],question='Expected compensation')
    context=request_context({'jobUrl':url,'jobCountry':'US'})
    document(a,p,[{'question':f['question'],'response':'posted_range','origin':'person','jobKey':context['jobKey'],'context':{**context,'capturedAt':(datetime.now(timezone.utc)+timedelta(seconds=1)).isoformat()}}])
    response=run(a,p,Client([answer(value='Within the posted salary range')]),[f],jobUrl=url,jobCountry='US')
    assert response['answerUsage']['modelCalls']==1
    assert response['answers'][0]['value']=='Within the posted salary range'


def test_provider_schema_constrains_each_control_before_generation():
    from jsonschema import Draft202012Validator
    from jobs_radar.ai_answers import schema
    fields = [field('month',type='month',options=[]),field('query',type='search-choice',options=[]),field('toggle',type='checkbox',options=[])]
    validator = Draft202012Validator(schema(fields))
    def valid(row): return not list(validator.iter_errors({'answers':[row]}))
    assert valid(answer('month',value='2025-10'))
    assert not valid(answer('month',value='10/2025'))
    assert not valid(answer('query',value=['Python','Java']))
    assert valid(answer('query',value='Python'))
    assert valid(answer('toggle',value=False))
    assert not valid(answer('toggle',value='No'))
    assert all(valid(answer(f['fieldId'],kind='unknown',value=None)) for f in fields)
