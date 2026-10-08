import asyncio
import json
import httpx
import pytest
from jobs_radar.answer_verification import verify, candidates
from jobs_radar.answer_evidence import decide


def field(question='Are you bound by a non-compete agreement?'):
    return dict(fieldId='f', question=question, description='', type='radio', required=True,
                options=[dict(value='n',label='No'),dict(value='y',label='Yes')])


def answer(evidence, **values):
    return dict(fieldId='f', state='answer', source='profile', value='n', reason='',
                needsConfirmation=False, evidence=evidence, **values)


class Client:
    def __init__(self, verdict='write', body=None, fail=False):
        self.calls=[]; self.verdict=verdict; self.body=body; self.fail=fail; self.topic='noncompete'
    async def post(self, url, json):
        self.calls.append((url,json))
        if self.fail: raise httpx.ReadTimeout('synthetic')
        body=self.body if self.body is not None else {'checks':[{'fieldId':'f','verdict':self.verdict,
            'meaning':{'topic':self.topic,'country':'','company':'','timeframe':'current'}}]}
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':__import__('json').dumps(body)}]}]})


def test_second_pass_contains_only_candidate_and_necessary_citations_once():
    profile={'applicationData':{'aiNotes':'I have no non-compete agreement, except with Example.\nUnrelated private note.'},
             'nameData':{'firstName':'PrivateName'},'resumeData':{'filename':'private.pdf'}}
    row=answer([{'noteQuote':'I have no non-compete agreement'}]);client=Client('missing_fact')
    checks=asyncio.run(verify(client,[row],[field()],profile,'existing-model'))
    assert len(client.calls)==1
    url,body=client.calls[0]
    assert url=='https://api.openai.com/v1/responses' and body['store'] is False
    sent=json.loads(body['input'])
    assert set(sent)=={'candidates'}
    assert set(sent['candidates'][0])=={'field','answer','evidence'}
    assert 'except with Example' in body['input']
    assert all(secret not in body['input'] for secret in ['PrivateName','private.pdf','Unrelated private note'])
    result=decide(row,field(),profile,'p','v',checks['f'])
    assert result['value'] is None and result['interruptionReason']=='missing_fact'


@pytest.mark.parametrize('verdict,expected', [('write','write'),('missing_fact','ask'),('new_commitment','ask')])
def test_decision_uses_checked_verdict_not_model_certainty_or_question_keywords(verdict,expected):
    profile={'applicationData':{'aiNotes':'The complete relevant fact is stated in a different form.'}}
    row=answer([{'noteQuote':profile['applicationData']['aiNotes']}]);client=Client(verdict)
    check=asyncio.run(verify(client,[row],[field()],profile,'model'))['f']
    result=decide(row,field(),profile,'p','v',check)
    assert result['decision']==expected
    assert result['needsConfirmation'] is (expected!='write')
    assert result['proof']['profileVersion']=='v'
    assert 'noteQuote' not in json.dumps(result['proof'])


@pytest.mark.parametrize('body', [[],{}, {'checks':[]},{'checks':[{'fieldId':'other','verdict':'write','meaning':{}}]}])
def test_malformed_or_wrong_coverage_is_control_failure_without_retry(body):
    profile={'employmentData':{'eligibilityUS':True}}
    row=answer([{'profilePath':'employmentData.eligibilityUS'}]);client=Client(body=body)
    checks=asyncio.run(verify(client,[row],[field()],profile,'model'))
    assert len(client.calls)==1
    result=decide(row,field(),profile,'p','v',checks['f'])
    assert result['decision']=='ask' and result['interruptionReason']=='control_failure'


def test_provider_failure_is_not_missing_personal_data():
    row=answer([],);row['source']='suggestion';client=Client(fail=True)
    check=asyncio.run(verify(client,[row],[field('Why this role?')],{},'model'))['f']
    result=decide(row,field('Why this role?'),{},'p','v',check)
    assert result['interruptionReason']=='control_failure' and result['value'] is None
    assert len(client.calls)==1


def test_a_draft_must_pass_semantics_and_cannot_be_a_factual_or_new_agreement_escape():
    row=answer([]);row['source']='suggestion'
    for verdict,expected in [('draft','draft'),('missing_fact','ask'),('new_commitment','ask')]:
        client=Client(verdict);client.topic='preference'
        check=asyncio.run(verify(client,[row],[field()],{},'model'))['f']
        result=decide(row,field(),{},'p','v',check)
        assert result['decision']==expected
    assert decide(row,field(),{},'p','v')['decision']=='ask'


def test_missing_or_forged_reference_does_not_reach_verifier_or_authorize_write():
    row=answer([{'profilePath':'invented'}]);client=Client()
    assert asyncio.run(verify(client,[row],[field()],{},'model'))=={}
    assert client.calls==[]
    assert decide(row,field(),{},'p','v',{'verdict':'write'})['decision']=='ask'


def test_existing_standing_authority_remains_scoped_and_does_not_fill_optional_consent():
    row=answer([{'authorization':'application_terms'}]);row['value']='y'
    assert candidates([row],[field('I accept the application terms')],{})
    assert decide(row,field(),{},'p','v',{'verdict':'write','meaning':{'topic':'acknowledgment','country':'','company':'','timeframe':''}})['decision']=='write'
    optional=field()|{'required':False}
    assert decide(row,optional,{},'p','v',{'verdict':'write'})['decision']=='ask'
    row['evidence']=[{'authorization':'demographic_data_processing'}]
    assert candidates([row],[field()],{})==[]


def test_an_accepted_verdict_cannot_pair_an_unrelated_profile_path_with_a_topic():
    profile={'employmentData':{'eligibilityUS':True},'nameData':{'firstName':'Fixture'}}
    for topic in ['unrestricted_work_right','medical_history','criminal_history','citizenship']:
        check={'verdict':'write','meaning':{'topic':topic,'country':'US','company':'','timeframe':'current'}}
        result=decide(answer([{'profilePath':'employmentData.eligibilityUS'}]),field(),profile,'p','v',check)
        assert result['decision']=='ask'
    check={'verdict':'draft','meaning':{'topic':'medical_history','country':'','company':'','timeframe':''}}
    row=answer([]);row['source']='suggestion'
    assert decide(row,field(),profile,'p','v',check)['decision']=='ask'


def test_every_context_containing_a_repeated_quote_reaches_the_check():
    profile={'applicationData':{'aiNotes':'No restrictions.\nNo restrictions except one current obligation.'}}
    row=answer([{'noteQuote':'No restrictions'}]);client=Client('missing_fact')
    asyncio.run(verify(client,[row],[field()],profile,'model'))
    assert 'except one current obligation' in client.calls[0][1]['input']


def test_search_query_is_a_verified_fact_not_a_guessed_option():
    from jobs_radar.field_answers import fields_input, checked_answers
    search=dict(fieldId='f',question='Which university did you attend?',type='search-choice',required=True,description='',options=[])
    profile={'educationData':[{'school':'Fixture University'}]}
    fields=fields_input({'fields':[search]})['fields']
    row=answer([{'profilePath':'educationData.0.school'}], meaning={'topic':'education','country':'','company':'','timeframe':'past'})
    row['value']='Fixture University'
    checked=checked_answers({'answers':[row]},fields,profile)[0]
    client=Client();client.topic='education'
    check=asyncio.run(verify(client,[checked],fields,profile,'model'))['f']
    result=decide(checked,fields[0],profile,'p','v',check)
    assert result['decision']=='write' and result['value']=='Fixture University'
    assert result['proof']['paths']==['educationData.0.school']
    assert len(client.calls)==1
    with pytest.raises(ValueError,match='Search query'):
        fields_input({'fields':[search|{'options':[{'value':'other','label':'Other'}]}]})


def test_exact_date_evidence_selects_one_record_and_cannot_invent_precision():
    current=dict(fieldId='f',question='Date for the selected record',type='date',required=True,description='',options=[])
    profile={'educationData':[{'graduationDate':'2027-05-14','endDate':'2027-05'},{}]}
    check={'verdict':'write','meaning':{'topic':'graduation_date','country':'','company':'','timeframe':''}}
    row=answer([{'profilePath':'educationData.0.graduationDate'}]);row['value']='2027-05-14'
    assert decide(row,current,profile,'p','v',check)['decision']=='write'
    row['evidence']=[{'profilePath':'educationData.0.endDate'}]
    assert decide(row,current,profile,'p','v',check)['decision']=='ask'


def test_calendar_evidence_is_computed_in_the_declared_zone_not_copied_from_page_text():
    from datetime import datetime, timezone
    from jobs_radar.answer_calendar import calendar_fact
    now=datetime(2027,5,14,6,tzinfo=timezone.utc)
    assert calendar_fact(json.dumps({'timeZone':'America/Los_Angeles','currentLocalDate':'1990-01-01'}),now)=={'today':'2027-05-13'}
    assert calendar_fact('untrusted page date',now)=={}
    assert calendar_fact(json.dumps({'timeZone':'invalid/fixture'}),now)=={}
    current=dict(fieldId='f',question="Enter today's date",type='date',required=True,description='',options=[])
    profile={'calendar':{'today':'2027-05-13'}}
    row=answer([{'profilePath':'calendar.today'}]);row['value']='2027-05-13'
    check={'verdict':'write','meaning':{'topic':'signature','country':'','company':'','timeframe':'current'}}
    assert decide(row,current,profile,'p','v',check)['decision']=='write'
    check['meaning']['topic']='graduation_date'
    assert decide(row,current,profile,'p','v',check)['decision']=='ask'
