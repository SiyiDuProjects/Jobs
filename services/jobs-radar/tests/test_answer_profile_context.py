import pytest
from jobs_radar.profile_contract import SCHEMA,assert_profile,project_answer_profile
from test_answers import setup,save,run,Client,mapping,field
from jobs_radar.profiles import Profiles

def test_new_fields_survive_profile_and_answer_projection(tmp_path):
    a,p=setup(tmp_path);p=save(a,p,projectData=[dict(name='Synthetic project',link='https://example.com',startDate='2026-01',endDate='2026-05',description='Python')],employmentData={'citizenships':['China'],'identityDefaults':'cis_heterosexual'},applicationData={'visaStatus':'F-1 OPT','defaultSource':'Company website','availableUntil':'2027-08-31','defaultAnswers':['government']})
    profile=Profiles(a.store).at_version(p['profileId'],p['profileVersion'])
    projected=project_answer_profile(profile,partial=False)
    assert projected['projectData']==profile['projectData'] and projected['employmentData']==profile['employmentData']
    assert set(SCHEMA['x-answerProjection'])==set(SCHEMA['properties'])

@pytest.mark.parametrize('parts',[{'applicationData':{'visaStatus':'made up'}},{'applicationData':{'defaultAnswers':['not_a_category']}},{'applicationData':{'availableUntil':'2027-05'}},{'employmentData':{'identityDefaults':'no'}},{'projectData':[{'name':'x','password':'secret'}]}])
def test_invalid_new_fields_rejected_without_provider(tmp_path,parts):
    a,p=setup(tmp_path)
    with pytest.raises(ValueError):save(a,p,**parts)

def test_month_fact_cannot_become_exact_date(tmp_path):
    a,p=setup(tmp_path);p=save(a,p,educationData=[{'school':'Example','endDate':'2027-05'}])
    f=field(question='Graduation date',type='date',options=[])
    row=run(a,p,Client([mapping(route='educationData.latest.endDate',options=[])]),[f])['answers'][0]
    assert row['value'] is None and row['decision']=='ask'
