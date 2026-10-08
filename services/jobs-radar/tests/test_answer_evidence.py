import copy
import json
import pytest
from jobs_radar.answer_evidence import decide, facts, resolve, citation_schema
from jobs_radar.answer_semantics import MeaningCache, cache_key, VOCABULARY
from jobs_radar.field_answers import schema
from jobs_radar.store import Store


def field(question='Are you bound by a non-compete agreement?', **extra):
    return dict(fieldId='fact', question=question, type='radio', required=True,
                description='', options=[dict(value='n',label='No'),dict(value='y',label='Yes')], **extra)


def answer(evidence, **extra):
    return dict(fieldId='fact', state='answer', source='profile', value='n', reason='Synthetic',
                needsConfirmation=False, evidence=evidence, **extra)


def decision(question, citations, profile, value='n', checked_topic=None):
    return decide(answer(citations) | {'value':value}, field(question), profile, 'profile-a', 'revision-a', {'verdict':'write','meaning':{'topic':checked_topic,'country':'','company':'','timeframe':''}} if checked_topic else None)


def test_explicit_noncompete_sentence_can_pass_without_category_confirmation():
    quote='I have no non-compete agreements.'
    result=decision('Are you bound by a non-compete agreement?', [{'noteQuote':quote}], {'applicationData':{'aiNotes':quote}}, checked_topic='noncompete')
    assert result['decision']=='write' and result['needsConfirmation'] is False
    assert result['proof']['status']=='verified'
    assert result['proof']['profileVersion']=='revision-a'
    assert quote not in json.dumps(result['proof'])


@pytest.mark.parametrize('notes,quote', [
    ('I have no non-compete agreements.', 'I have no non-compete obligations.'),
    ('Previously, I have no non-compete agreements.', 'I have no non-compete agreements.'),
    ('If I change jobs, I have no non-compete agreements.', 'I have no non-compete agreements.'),
    ('I have no non-compete agreements. I have an active non-compete agreement.', 'I have no non-compete agreements.'),
    ('I have no non-compete agreements except with Example.', 'I have no non-compete agreements'),
    ('', 'I have no non-compete agreements.'),
])
def test_nonexistent_partial_conditional_or_conflicting_quotes_cannot_authorize_an_answer(notes,quote):
    row=decision('Are you bound by a non-compete agreement?', [{'noteQuote':quote}], {'applicationData':{'aiNotes':notes}})
    assert row['decision']=='ask' and row['value'] is None
    assert row['interruptionReason']=='missing_fact'


@pytest.mark.parametrize('question', ['Have you ever had a non-compete agreement?', 'Have you had a non-compete agreement in the past three years?', 'Are you bound by a non-compete or confidentiality agreement?'])
def test_current_noncompete_fact_does_not_expand_scope(question):
    quote='I have no non-compete agreements.'
    assert decision(question,[{'noteQuote':quote}],{'applicationData':{'aiNotes':quote}})['decision']=='ask'


def test_sources_paths_false_and_zero_are_checked_not_trusted():
    profile={'employmentData':{'eligibilityUS':True},'applicationData':{'sponsorshipNow':False},'count':0}
    assert facts(profile)['applicationData.sponsorshipNow'] is False and facts(profile)['count']==0
    assert resolve([{'profilePath':'missing'}],profile) is None
    assert resolve([{'profilePath':'count','noteQuote':'text'}],profile) is None
    row=decision('Do you require sponsorship now?',[{'profilePath':'applicationData.sponsorshipNow'}],profile,checked_topic='sponsorship')
    assert row['decision']=='write' and row['value']=='n'
    assert decision('Do you require sponsorship now?',[],profile)['decision']=='ask'
    assert decision('Do you require sponsorship in the future?',[{'profilePath':'applicationData.sponsorshipNow'}],profile)['decision']=='ask'
    assert decision('Do you have unrestricted work authorization in the United States?',[{'profilePath':'employmentData.eligibilityUS'}],profile,'y')['decision']=='ask'
    assert decision('Are you authorized to work in Canada?',[{'profilePath':'employmentData.eligibilityUS'}],profile,'y')['decision']=='ask'
    assert decision('Are you not authorized to work in the United States?',[{'profilePath':'employmentData.eligibilityUS'}],profile,'y')['decision']=='ask'


def test_irrelevant_real_field_and_forged_topic_cannot_pass():
    profile={'applicationData':{'visaStatus':'F-1'},'employmentData':{'eligibilityUS':True}}
    row=answer([{'profilePath':'employmentData.eligibilityUS'}],meaning={'topic':'work_eligibility','country':'US','company':'','timeframe':''})
    result=decide(row,field('Have you ever been convicted of a felony?'),profile,'p','v')
    assert result['decision']=='ask' and result['value'] is None


def test_schema_enumerates_only_current_nonempty_profile_paths():
    profile={'applicationData':{'sponsorshipNow':False,'aiNotes':'Private fixture'},'nameData':{'firstName':''}}
    paths=citation_schema(profile)['items']['anyOf'][0]['properties']['profilePath']['enum']
    assert paths==['applicationData.sponsorshipNow']
    item=schema([field()],profile)['properties']['answers']['items']
    assert {'evidence','meaning'} <= set(item['required'])


def test_meaning_cache_versions_context_and_options_invalidate_without_storing_answers(tmp_path):
    store=Store(tmp_path/'cache.sqlite'); cache=MeaningCache(store)
    f=field();context={'country':'US','company':'Example'}
    row=answer([{'noteQuote':'private quotation'}], meaning={'topic':'noncompete','country':'US','company':'current','timeframe':'current'})
    cache.save([f],[row],context,'model-v1')
    assert cache.read([f],context,'model-v1')['fact']==row['meaning']
    assert not cache.read([f],context,'model-v2')
    assert not cache.read([f],context|{'country':'CA'},'model-v1')
    assert not cache.read([f|{'options':[{'value':'n','label':'No current or prior agreement'}]}],context,'model-v1')
    old=VOCABULARY['version']
    try:
        VOCABULARY['version']+=1
        assert not cache.read([f],context,'model-v1')
    finally: VOCABULARY['version']=old
    with store.connect() as c:
        assert 'private quotation' not in str([tuple(r) for r in c.execute('SELECT * FROM answer_meanings')])


def test_model_free_text_cannot_be_written_to_meaning_cache(tmp_path):
    store=Store(tmp_path/'cache.sqlite');cache=MeaningCache(store)
    row=answer([],meaning={'topic':'noncompete','country':'private fact','company':'','timeframe':''})
    cache.save([field()],[row],{},'model')
    assert not cache.read([field()],{},'model')


def test_even_an_exact_personal_fact_needs_the_semantic_check():
    profile={'applicationData':{'aiNotes':'I have no non-compete agreements.'}}
    result=decision('Are you bound by a non-compete agreement?',
                    [{'noteQuote':profile['applicationData']['aiNotes']}],profile)
    assert result['decision']=='ask' and result['value'] is None
