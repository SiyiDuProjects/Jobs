import asyncio
import json
import httpx
from jobs_radar.answers import Answers
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.answer_evidence import decide
from jobs_radar.review_proposals import proposed


def field(ident='clearance', required=True):
    return dict(fieldId=ident, question='Do you currently hold a security clearance?',
                type='select-one', required=required, description='',
                options=[dict(value='yes', label='Yes'), dict(value='no', label='No')])


def test_unverified_required_candidate_is_review_only_without_truth_or_cache_upgrade(tmp_path):
    store = Store(tmp_path/'fixture.sqlite')
    p = {'profileName':'Synthetic review', 'nameData':{}, 'addressData':{}, 'contactData':{},
         'jobData':[], 'educationData':[], 'languageData':[], 'resumeData':{}, 'websiteData':{},
         'employmentData':{}, 'skillsData':[], 'applicationData':{}}
    record = Profiles(store).save(p)
    calls = []
    class Client:
        async def post(self, url, json):
            calls.append(json)
            payload = __import__('json').loads(json['input'])
            if 'candidates' in payload:
                body = {'checks':[{'fieldId':'clearance','verdict':'missing_fact',
                     'meaning':{'topic':'security_clearance','country':'US','company':'','timeframe':'current'}}]}
            else:
                body = {'answers':[{'fieldId':'clearance','state':'answer','value':'no',
                     'source':'suggestion','needsConfirmation':True,'evidence':[],
                     'reason':'Unconfirmed proposal','questionZh':'目前持有安全许可吗？','answerZh':'否'}]}
            return httpx.Response(200, json={'status':'completed','output':[{'content':[
                {'type':'output_text','text':__import__('json').dumps(body)}]}]})
    request = dict(profileId=record['id'], profileVersion=record['last_sync'], fields=[field()], reviewSuggestions=True)
    result = asyncio.run(Answers(store).generate(request, Client()))['answers'][0]
    assert result['state']=='answer' and result['value']=='no'
    assert result['reviewOnly'] and result['decision']=='draft' and result['needsConfirmation']
    assert result['proof']['status']=='proposed' and result['proof']['paths']==[]
    assert 'editable review card' in calls[0]['instructions'] and all(c['store'] is False for c in calls)
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM answer_profile_gaps').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM answer_bindings').fetchone()[0]==0
    legacy = asyncio.run(Answers(store).generate({**request,'reviewSuggestions':False},Client()))['answers'][0]
    assert legacy['decision']=='ask' and legacy['value'] is None


def test_abstained_choices_receive_a_proposal_but_optional_and_invalid_text_do_not():
    row=dict(fieldId='clearance',state='needs_input',source='unknown',value=None,reason='Unknown',evidence=[])
    f=field()
    ask=decide(row,f,{},'p','v')
    assert proposed(row,f,ask)['value']=='no'
    optional=field(required=False)
    assert proposed(row,optional,decide(row,optional,{},'p','v'))['decision']=='ask'
    text={**f,'type':'text','options':[]}
    assert proposed(row,text,decide(row,text,{},'p','v'))['decision']=='ask'


def test_avav_sponsorship_candidate_survives_work_eligibility_topic_with_full_evidence():
    f={**field('authorization'),'question':'Work Authorization:*','type':'combobox','options':[
        {'value':'any','label':'I am authorized to work in this country for any employer'},
        {'value':'present','label':'I am authorized to work in this country for my present employer only'},
        {'value':'sponsor','label':'I require sponsorship to work in this country'}]}
    p={'employmentData':{'eligibilityUS':True,'sponsorship':True},
       'applicationData':{'sponsorshipNow':True,'sponsorshipFuture':True,'visaStatus':'F-1'}}
    row=dict(fieldId='authorization',state='answer',source='profile',value='sponsor',reason='Synthetic',
             evidence=[{'profilePath':path} for path in ['applicationData.sponsorshipNow',
                       'applicationData.sponsorshipFuture','applicationData.visaStatus']])
    meaning={'topic':'work_eligibility','country':'US','company':'','timeframe':'current'}
    check={'verdict':'write','meaning':meaning}
    result=decide(row,f,p,'p','v',check)
    assert result['decision']=='write' and result['value']=='sponsor' and not result['needsConfirmation']
    # Related paths cannot substitute for the independent scope check.
    for invalid in ['any','present']:
        result=decide({**row,'value':invalid},f,p,'p','v',{'verdict':'missing_fact','meaning':meaning})
        assert result['decision']=='ask' and result['value'] is None
