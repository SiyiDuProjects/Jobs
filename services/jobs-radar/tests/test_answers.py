import asyncio
import json
import pytest
from jobs_radar.store import Store
from jobs_radar.profiles import Profiles
from jobs_radar.answers import Answers

def setup(tmp_path):
    store=Store(tmp_path/'answers.sqlite');profiles=Profiles(store)
    p={'profileName':'Intern','nameData':{},'addressData':{},'contactData':{},'jobData':[],
       'educationData':[],'languageData':[],'resumeData':{},'websiteData':{},'employmentData':{},'skillsData':['Python']}
    record=profiles.save(p)
    return Answers(store),{'profileId':record['id'],'profileVersion':record['last_sync'],'prompt':'Which languages do you use?'}

class Client:
    def __init__(self,state='answer',text='Python.'):self.state=state;self.text=text;self.body=None
    async def post(self,url,json):
        self.body=json
        response={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps({'state':self.state,'text':self.text})}]}]}
        class Result:
            status_code=200
            def json(self):return response
        return Result()

def test_answer_uses_selected_snapshot_existing_luna_and_no_provider_storage(tmp_path):
    a,p=setup(tmp_path);c=Client();result=asyncio.run(a.generate(p,c))
    assert result['model']=='gpt-6-luna' and result['text']=='Python.'
    assert c.body['store'] is False
    sent=json.loads(c.body['input']);assert sent['profile']['profileName']=='Intern'
    assert 'Do not invent' in c.body['instructions']

def test_unknown_facts_do_not_produce_a_fillable_answer(tmp_path):
    a,p=setup(tmp_path);c=Client('needs_input','Please confirm work authorization.')
    with pytest.raises(ValueError,match='需要你确认'):asyncio.run(a.generate(p,c))

@pytest.mark.parametrize('context', ['', 'Invented personal fact', 'x' * 5000])
def test_global_personal_context_cannot_reach_the_provider(tmp_path, context):
    a,p=setup(tmp_path);c=Client()
    with pytest.raises(ValueError,match='selected server Profile'):
        asyncio.run(a.generate({**p,'responseContext':context},c))
    assert c.body is None
    with a.store.connect() as db:
        assert db.execute('SELECT count(*) FROM answer_requests').fetchone()[0] == 0


def test_http_request_rejects_the_removed_global_context():
    from pydantic import ValidationError
    from jobs_radar.web_inputs import AnswerJobRequest
    with pytest.raises(ValidationError):
        AnswerJobRequest(requestId='test',profileId='a',profileVersion='v1',prompt='Example',responseContext='Old settings')

def test_credentials_and_missing_profile_rejected_before_provider(tmp_path):
    a,p=setup(tmp_path);c=Client()
    with pytest.raises(ValueError):asyncio.run(a.generate({**p,'profile':{'profileName':'Intern','accountPassword':'secret'}},c))
    assert c.body is None
    with pytest.raises(ValueError):asyncio.run(a.generate({**p,'profileId':'a'*36},c))

def test_batch_fields_share_provider_and_validate_types_and_complete_coverage(tmp_path):
    a,p=setup(tmp_path)
    fields=[{'fieldId':'language','question':'Preferred language?','type':'radio','required':True,
             'options':[{'value':'python','label':'Python'}]},
            {'fieldId':'office','question':'Willing to relocate?','type':'checkbox','required':False}]
    answers=[{'fieldId':'language','state':'answer','value':'python','reason':'','source':'profile','needsConfirmation':False,'questionZh':'首选编程语言','answerZh':'Python'},
             {'fieldId':'office','state':'needs_input','value':None,'reason':'No confirmed preference','source':'unknown','needsConfirmation':True}]
    class Batch:
        async def post(self,url,json):
            self.body=json
            class Result:
                status_code=200
                def json(self):return {'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps({'answers':answers})}]}]}
            return Result()
    client=Batch();result=asyncio.run(a.generate({**p,'fields':fields,'formContext':[{'question':'Country','answer':'United States'}]},client))
    assert result['answers']==answers and client.body['store'] is False
    assert json.loads(client.body['input'])['formContext'][0]['answer']=='United States'
    with a.store.connect() as c:
        gap=c.execute('SELECT question,answer,occurrences FROM answer_profile_gaps').fetchall()
        assert len(gap)==1 and gap[0]['question']=='Preferred language?' and json.loads(gap[0]['answer'])=='python'
    answers[1]={'fieldId':'office','state':'answer','value':False,'reason':'Confirmed preference','source':'suggestion','needsConfirmation':True}
    for invalid in ['unknown',True,['python']]:
        answers[0]['value']=invalid
        result=asyncio.run(a.generate({**p,'fields':fields},client))
        assert result['answers'][0]['state']=='needs_input' and result['answers'][0]['value'] is None
        assert 'answerZh' not in result['answers'][0], 'Rejected values must not retain a successful-looking translation'
        assert result['answers'][1]==answers[1], 'One bad value must not discard another valid answer'
    answers[0]['fieldId']='unknown'
    with pytest.raises(ValueError):asyncio.run(a.generate({**p,'fields':fields},client))
    answers[0]['fieldId']='office'
    with pytest.raises(ValueError):asyncio.run(a.generate({**p,'fields':fields},client))
    answers.pop()
    with pytest.raises(ValueError):asyncio.run(a.generate({**p,'fields':fields},client))
    with a.store.connect() as c:
        assert c.execute('SELECT count(*) FROM answer_profile_gaps').fetchone()[0]==1,'Suggestions and invalid values must not become profile adapter candidates'

def test_conditional_optional_blanks_keep_valid_school_answer_but_required_blanks_need_review():
    from jobs_radar.field_answers import fields_input, checked_answers
    fields=fields_input({'fields':[
        {'fieldId':'school','question':'Please select your School from the list','type':'select-one','required':True,
         'options':[{'value':'berkeley','label':'University of California Berkeley'}]},
        {'fieldId':'extra-school','question':'Please add your School if it is not in the list','type':'text','required':False},
        {'fieldId':'required','question':'Required missing answer','type':'text','required':True},
        {'fieldId':'unexplained','question':'Other optional question','type':'text','required':False}
    ]})['fields']
    answers=[{'fieldId':f['fieldId'],'state':'answer','value':'berkeley' if i==0 else '',
              'reason':'学校已在列表中，无需补充。' if i<3 else '', 'source':'profile','needsConfirmation':False} for i,f in enumerate(fields)]
    checked=checked_answers({'answers':answers},fields)
    assert checked[:2]==answers[:2]
    assert all(r['state']=='needs_input' and r['value'] is None and r['reason'] for r in checked[2:])
    assert all(r['source']=='unknown' for r in checked[2:])
    answers[0].pop('source')
    assert checked_answers({'answers':answers},fields)[0]['source']=='unknown'

def test_confirmation_flag_is_explicit_and_unknown_or_invalid_answers_cannot_bypass_it():
    from jobs_radar.field_answers import checked_answers, schema
    field={'fieldId':'experience','question':'Related experience?','type':'select-one','required':True,
           'options':[{'value':'no','label':'No'}]}
    item=schema([field])['properties']['answers']['items']
    assert item['properties']['needsConfirmation']=={'type':'boolean'}
    assert 'needsConfirmation' in item['required']
    answer={'fieldId':'experience','state':'answer','value':'no','reason':'Interpretation needs review','source':'profile'}
    for flag in [False,True,None,'false',0]:
        result=checked_answers({'answers':[{**answer,'needsConfirmation':flag}]},[field])[0]
        assert result['needsConfirmation'] is (flag is not False)
        assert result['value']=='no'
    assert checked_answers({'answers':[answer]},[field])[0]['needsConfirmation'] is True
    for change in [{'state':'needs_input','value':None},{'value':'not-an-option'}]:
        result=checked_answers({'answers':[{**answer,'needsConfirmation':False,**change}]},[field])[0]
        assert result['needsConfirmation'] is True and result['state']=='needs_input'


def test_a_subjective_suggestion_cannot_skip_review_even_if_the_model_marks_it_certain():
    from jobs_radar.field_answers import checked_answers
    field={'fieldId':'salary','question':'Desired annual salary?','type':'text','required':True,'options':[]}
    answer={'fieldId':'salary','state':'answer','value':'120000','reason':'Suggested target',
            'source':'suggestion','needsConfirmation':False}
    result=checked_answers({'answers':[answer]},[field])[0]
    assert result['value']=='120000'
    assert result['needsConfirmation'] is True

def test_real_world_duplicate_options_and_long_school_lists_are_valid_without_ambiguous_values():
    from jobs_radar.field_answers import fields_input
    def field(options):
        return {'fields':[{'fieldId':'school','question':'School?','type':'select-one','required':True,'options':options}]}
    choices=[{'value':str(i),'label':'School '+str(i)} for i in range(319)]
    data=fields_input(field(choices+[choices[5].copy()]))
    assert len(data['fields'][0]['options'])==319
    assert data['fields'][0]['options'][-1]==choices[-1]
    with pytest.raises(ValueError,match='Ambiguous option value: school'):
        fields_input(field(choices+[{'value':'5','label':'Different school'}]))


def test_exact_graduation_dates_require_the_same_unambiguous_server_fact():
    from jobs_radar.field_answers import checked_answers
    field={'fieldId':'graduation','question':'Graduation date','type':'date','required':True,'options':[]}
    answer={'fieldId':'graduation','state':'answer','value':'2027-05-14','reason':'Known date',
            'source':'profile','needsConfirmation':False}
    profile={'educationData':[{'graduationDate':'2027-05-14','endDate':'2027-05'}]}
    assert checked_answers({'answers':[answer]},[field],profile)[0]==answer
    for records in [[],[{}],[{'graduationDate':'2027-05-13'}],
                    [*profile['educationData'],{}],
                    [*profile['educationData'],{'graduationDate':'2026-05-14'}]]:
        result=checked_answers({'answers':[answer]},[field],{'educationData':records})[0]
        assert result['state']=='needs_input' and result['value'] is None and result['needsConfirmation']


def test_date_validation_preserves_reviewable_start_preferences_but_rejects_invalid_calendar_dates():
    from jobs_radar.field_answers import checked_answers
    field={'fieldId':'start','question':'Desired start date preference','type':'date','required':True,'options':[]}
    answer={'fieldId':'start','state':'answer','value':'2027-06-14','reason':'A proposed preference',
            'source':'suggestion','needsConfirmation':False}
    result=checked_answers({'answers':[answer]},[field],{})[0]
    assert result['state']=='answer' and result['value']=='2027-06-14' and result['needsConfirmation']
    for value in ['2027-02-29','2027-05','05/14/2027','tomorrow']:
        result=checked_answers({'answers':[{**answer,'value':value}]},[field],{})[0]
        assert result['state']=='needs_input' and result['value'] is None
