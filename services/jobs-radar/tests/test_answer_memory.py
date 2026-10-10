import asyncio
import pytest
from jobs_radar.answer_memory import company_key
from jobs_radar.management import Management
from jobs_radar.job_match import job_key
from test_answers import setup,field,mapping,Client,run,save
URL='https://jobs.ashbyhq.com/example/first/application'
OTHER='https://jobs.ashbyhq.com/example/second/application'

def record(**patch):
    return dict(key='person-answer',question=field()['question'],response='Yes',origin='person',scope='company',ruleVersion=3,
                jobKey=job_key(URL),context={'jobKey':job_key(URL),'companyKey':company_key(job_key(URL)),
                'country':'US','capturedAt':'2026-10-01T00:00:00Z'}) | patch

def prepare(tmp_path,rows=None):
    a,p=setup(tmp_path);p.update(jobUrl=OTHER,jobCountry='US')
    management=Management(a.store);key='jobsResponses:'+p['profileId']
    management.write([dict(key=key,revision=0,value=rows if rows is not None else [record()])])
    return a,p,management,key

def test_person_exact_company_answer_follows_profile_but_precedes_defaults(tmp_path):
    a,p,_,_=prepare(tmp_path)
    assert run(a,p,Client())['answers'][0]['value']=='y'
    p=save(a,p,employmentData={'eligibilityUS':False})
    assert run(a,p,Client())['answers'][0]['value']=='n'

@pytest.mark.parametrize('patch',[{'origin':'agent'},{'origin':'legacy'},{'question':'Different question'},{'context':{}},{'response':'An option not offered'}])
def test_wrong_provenance_question_context_or_option_is_not_reused(tmp_path,patch):
    a,p,_,_=prepare(tmp_path,[record(**patch)])
    assert run(a,p,Client())['answers'][0]['value'] is None

def test_global_record_still_cannot_cross_company(tmp_path):
    a,p,_,_=prepare(tmp_path,[record(scope='global')]);p['jobUrl']='https://jobs.ashbyhq.com/different/role/application'
    assert run(a,p,Client())['answers'][0]['value'] is None

def test_conflicting_person_records_stay_blank(tmp_path):
    a,p,_,_=prepare(tmp_path,[record(),record(key='second',response='No')])
    assert run(a,p,Client())['answers'][0]['value'] is None

def test_person_answer_precedes_enabled_default(tmp_path):
    f=field(question='Have you ever worked for the government?')
    a,p,_,_=prepare(tmp_path,[record(question=f['question'])]);p=save(a,p,applicationData={'defaultAnswers':['government']})
    assert run(a,p,Client([mapping(route='default.government')]),[f])['answers'][0]['value']=='y'

def test_person_answer_change_during_recognition_is_detected(tmp_path):
    a,p,m,key=prepare(tmp_path)
    def changed():m.write([dict(key=key,revision=1,value=[record(response='No')])])
    with pytest.raises(ValueError,match='已存回答已改变'):run(a,p,Client(changed=changed))

def test_person_answer_does_not_enter_model_input(tmp_path):
    a,p,_,_=prepare(tmp_path,[record(response='Private saved answer')]);client=Client();run(a,p,client)
    assert all('Private saved answer' not in c['input'] for c in client.calls)
