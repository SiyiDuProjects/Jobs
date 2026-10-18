"""Reproductions from the review, using only synthetic facts/provider responses."""
import json
import time
from jobs_radar.answer_bindings import binding_key, checked, evaluate
from test_answers import setup, save, run, Client, mapping, field


def test_employer_legal_suffixes_and_company_scope():
    p = {'jobData': [{'company': 'TikTok'}]}
    assert evaluate('previous_employer', p, 'TikTok Inc.')[0] == 'true'
    assert evaluate('previous_employer', p, 'TikTok Analytics LLC')[0] == 'false'
    assert evaluate('previous_employer_group', p, '字节跳动')[0] == 'true'
    assert evaluate('previous_employer_group', p, 'Unlisted Group')[0] == 'false'
    assert evaluate('previous_employer', {'jobData': []}, 'Other')[0] == 'false'


def test_affiliate_question_preserves_group_scope():
    f = field(question='Have you ever worked for ByteDance or its affiliates?')
    plan = checked(mapping(route='previous_employer', argument='ByteDance')['binding'], None, f, {})
    assert plan['predicate'] == 'previous_employer_group'


def test_current_employer_requires_current_employment():
    p = {'jobData': [{'company': 'Past employer', 'jobTitle': 'Engineer', 'endDate': '2025-08', 'currentlyWorkHere': False}]}
    for key in ('company', 'jobTitle'):
        f = field(question='Current employer' if key == 'company' else 'Current job title', type='text', options=[])
        plan = checked(mapping(route='jobData.latest.' + key, options=[])['binding'], None, f, {})
        assert plan['predicate'] == 'jobData.current.' + key
        assert evaluate(plan['predicate'], p) is None
    assert evaluate('jobData.latest.company', p)[0] == 'Past employer'
    p['jobData'][0]['currentlyWorkHere'] = True
    assert evaluate('jobData.current.company', p)[0] == 'Past employer'


def test_calendar_metadata_does_not_invalidate_recognition_cache():
    context = {'jobContext': {'country': 'US'}, 'additionalContext': json.dumps({'currentLocalDate': '2026-10-09', 'timeZone': 'America/Los_Angeles', 'dateAnswerFormat': 'YYYY-MM-DD'})}
    later = {**context, 'additionalContext': json.dumps({'currentLocalDate': '2026-10-10', 'timeZone': 'Asia/Shanghai', 'dateAnswerFormat': 'YYYY-MM-DD'})}
    assert binding_key(field(), context, 'model') == binding_key(field(), later, 'model')
    assert binding_key(field(), context, 'model') != binding_key(field(), {**context, 'additionalContext': 'For our Canadian subsidiary'}, 'model')


def gap_count(a):
    with a.store.connect() as c:
        return c.execute('SELECT count(*) FROM answer_profile_gaps').fetchone()[0]


def test_provider_failure_is_not_a_profile_gap(tmp_path):
    a, p = setup(tmp_path)
    row = run(a, p, Client(fail=True))['answers'][0]
    assert row['interruptionReason'] == 'ai_unavailable'
    assert 'missingField' not in row and gap_count(a) == 0


def test_hourly_volume_does_not_block_legacy_answers(tmp_path):
    a, p = setup(tmp_path)
    p = save(a, p, employmentData={'eligibilityUS': True})
    with a.store.connect(True) as c:
        c.executemany('INSERT INTO answer_requests VALUES(?,?,?)', [(str(i), time.time(), 'started') for i in range(60)])
    client = Client()
    row = run(a, p, client)['answers'][0]
    assert row['value'] == 'y' and row['decision'] == 'write'
    assert len(client.calls) == 1 and gap_count(a) == 0


def test_actual_missing_profile_value_remains_a_profile_gap(tmp_path):
    a, p = setup(tmp_path)
    row = run(a, p, Client())['answers'][0]
    assert row['interruptionReason'] == 'missing_fact' and gap_count(a) == 1


def test_failed_draft_is_not_a_missing_fact(tmp_path):
    a, p = setup(tmp_path)
    f = field(question='Why are you interested?', type='textarea', options=[])
    client = Client([mapping(route='draft.motivation', options=[])])
    row = run(a, p, client, [f])['answers'][0]
    assert row['interruptionReason'] == 'draft_unavailable' and gap_count(a) == 0
