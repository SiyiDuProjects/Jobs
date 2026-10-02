"""Same cases as the JS rules and opt-in live-provider rehearsal; no network."""
import asyncio
import importlib.util
import json
from pathlib import Path

import httpx
import pytest
from jobs_radar.answers import Answers
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store

SCRIPT = Path(__file__).parents[1] / 'deploy' / 'verify_answer_policy.py'
spec = importlib.util.spec_from_file_location('verify_answer_policy', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_shared_cases_run_through_actual_provider_boundary_with_mocked_responses():
    fixture = json.loads(module.CASES.read_text(encoding='utf-8'))
    lookup = {row['id']: row for row in fixture['cases']}
    calls = []

    class Client:
        async def post(self, url, json):
            assert json['store'] is False
            payload = __import__('json').loads(json['input'])
            assert payload['profile']['profileName'] == 'Synthetic policy verification'
            assert 'resumeBase64' not in str(payload)
            calls.append(payload)
            rows = []
            for field in payload['fields']:
                expected = lookup[field['fieldId']]['expected']
                rows.append({'fieldId': field['fieldId'], **{k:v for k,v in expected.items() if k != 'nonempty'},
                             'value': expected.get('value', 'Backend reliability interests me.'),
                             'reason': 'Synthetic fixture', 'questionZh': '测试问题', 'answerZh': '测试回答'})
            return httpx.Response(200, json={'status':'completed', 'usage': {},
                'output':[{'content':[{'type':'output_text','text':__import__('json').dumps({'answers':rows})}]}]})

    report = asyncio.run(module.run(Client()))
    assert report['passed'] and len(report['cases']) == 11 and len(calls) == 3


def test_expected_answers_reject_false_facts_and_missing_confirmation():
    fixture = json.loads(module.CASES.read_text(encoding='utf-8'))
    for case in fixture['cases']:
        assert not module.check(case, {'state': 'answer', 'value': 'invented',
                                     'source': 'profile', 'needsConfirmation': False})['passed']


_fixture = json.loads(module.CASES.read_text(encoding='utf-8'))
_month_only = next(case for case in _fixture['cases'] if case['id'] == 'month-only')


@pytest.mark.parametrize('value', _month_only['invalidModelValues'])
def test_month_precision_cannot_become_a_day_even_when_provider_claims_certainty(tmp_path, value):
    store = Store(tmp_path / 'dates.sqlite')
    profile = {**_fixture['profile'], **_month_only['profilePatch']}
    record = Profiles(store).save(profile)

    class Client:
        async def post(self, url, json):
            rows = [{'fieldId': _month_only['id'], 'state': 'answer', 'value': value,
                     'source': 'profile', 'needsConfirmation': False,
                     'reason': 'The model claims this is known.', 'answerZh': value}]
            return httpx.Response(200, json={'status': 'completed', 'output': [
                {'content': [{'type': 'output_text', 'text': __import__('json').dumps({'answers': rows})}]}]})

    answer = asyncio.run(Answers(store).generate({
        'profileId': record['id'], 'profileVersion': record['last_sync'],
        'fields': [module.field(_month_only)]}, Client()))['answers'][0]
    assert module.check(_month_only, answer)['passed']
    assert 'answerZh' not in answer
    with store.connect() as connection:
        assert connection.execute('SELECT count(*) FROM answer_profile_gaps').fetchone()[0] == 0
