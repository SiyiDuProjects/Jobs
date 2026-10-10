import pytest
from jobs_radar.answer_bindings import answer, checked, evaluate
from test_answers import field, mapping


def value(route, profile, kind='radio', options=None, argument='', polarity=True):
    f=field(type=kind, options=[{'value':'n','label':'No'},{'value':'y','label':'Yes'}] if options is None else options)
    plan=mapping(route=route, options=['false','true'] if options is None else [], argument=argument, polarity=polarity)['binding']
    row=answer(plan,None,f,profile,'synthetic','version')
    return row['value'] if row else None


@pytest.mark.parametrize('visa,countries,citizen,person',[
    ('US citizen',['United States'],'y','y'),('F-1 OPT',['China'],'n','n'),('Green card',['China'],'n','y'),
    ('',[],None,None),('Other',['China'],'n',None)])
def test_multi_identity_citizenship_and_export_control(visa,countries,citizen,person):
    p={'employmentData':{'citizenships':countries},'applicationData':{'visaStatus':visa}}
    assert value('us_citizen',p)==citizen
    assert value('us_person',p)==person
    assert value('us_permanent_work_right',p)==person


@pytest.mark.parametrize('now,future,either',[(False,False,'n'),(False,True,'y'),(True,False,'y'),(True,None,'y'),(False,None,None)])
def test_sponsorship_current_future_and_either(now,future,either):
    p={'applicationData':dict(sponsorshipNow=now,**({'sponsorshipFuture':future} if future is not None else {}))}
    assert value('sponsorship_now',p)==('y' if now else 'n')
    assert value('sponsorship_future',p)==(None if future is None else 'y' if future else 'n')
    assert value('sponsorship_either',p)==either


def test_default_enabled_only_and_explicit_false_wins():
    p={'applicationData':{'defaultAnswers':['location','government']}}
    assert value('default.government',p)=='n'
    assert value('default.criminal',p) is None
    assert value('applicationData.willingToRelocate',p)=='y'
    p['applicationData']['willingToRelocate']=False
    assert value('applicationData.willingToRelocate',p)=='n'
    assert value('default.government',{},kind='checkbox',options=[],polarity=False) is None
    assert value('default.government',p,kind='checkbox',options=[],polarity=False) is True


def test_date_precision_and_actual_month_are_preserved():
    p={'educationData':[{'endDate':'2027-05'}]}
    assert value('educationData.latest.endDate',p,'date',[]) is None
    assert value('educationData.latest.endDate',p,'month',[])=='2027-05'
    p['educationData'][0]['graduationDate']='2027-05-26'
    assert value('educationData.latest.graduationDate',p,'date',[])=='2027-05-26'


def test_employer_absent_means_never_employed():
    p={'jobData':[{'company':'Example'}]}
    assert value('previous_employer',p,argument='Example')=='y'
    assert value('previous_employer',p,argument='Other')=='n'
    assert value('previous_employer',p) is None
    assert value('previous_employer',{},argument='Other') is None


def test_identity_preset_is_explicit_not_inferred_from_gender():
    p={'employmentData':{'gender':'Male'}}
    assert value('transgender',p) is None
    p['employmentData']['identityDefaults']='cis_heterosexual'
    assert value('transgender',p)=='n' and value('lgbtq',p)=='n'
    assert evaluate('gender_identity',p)[0]=='male'
    assert evaluate('sexual_orientation',p)[0]=='heterosexual'
    p['employmentData']['identityDefaults']='undisclosed'
    assert evaluate('gender_identity',p)[0]=='undisclosed'


def test_company_argument_must_be_from_public_question():
    assert checked(mapping(route='previous_employer',argument='Invented')['binding'],None,field(),{}) is None


def test_option_membership_and_negative_polarity():
    p={'employmentData':{'eligibilityUS':True}}
    plan=mapping(options=['true','false'])['binding']
    f=field(options=[{'value':'n','label':'No, I have authorization'},{'value':'y','label':'Yes, I do not'}])
    assert answer(plan,None,f,p,'p','v')['value']=='n'
    assert value('us_work_eligible',p,'checkbox',[],polarity=False) is False


def test_direct_boolean_negation_and_unknown_mapping():
    p={'applicationData':{'willingToRelocate':False}}
    assert value('applicationData.willingToRelocate',p,'checkbox',[],polarity=False) is True
    plan=checked(mapping(route='unknown',options=[])['binding'],None,field(),{})
    assert plan and answer(plan,None,field(),p,'p','v') is None


def test_cache_ignores_posting_ids_but_retains_public_context():
    from jobs_radar.answer_bindings import binding_key
    a={'jobContext':{'country':'US','companyKey':'example','jobKey':'one'}}
    b={'jobContext':{'country':'US','companyKey':'example','jobKey':'two'}}
    assert binding_key(field(),a,'model') == binding_key(field(),b,'model')
    assert binding_key(field(),a,'model') != binding_key(field(),{**a,'additionalContext':'different qualifier'},'model')


def test_latest_history_does_not_ignore_an_undated_entry():
    p={'jobData':[{'company':'Undated'},{'company':'Dated','endDate':'2025-09'}]}
    assert evaluate('jobData.latest.company',p) is None
    p['jobData'][0]['currentlyWorkHere']=True
    assert evaluate('jobData.latest.company',p)[0]=='Undated'


def test_unknown_country_cannot_prove_non_citizenship():
    assert evaluate('us_citizen',{'employmentData':{'citizenships':['Unrecognized country']}}) is None
    assert evaluate('us_citizen',{'employmentData':{'citizenships':['美国']}})[0]=='true'
    assert evaluate('voluntary_gender',{'employmentData':{'gender':'I choose not to disclose'}})[0]=='undisclosed'
