"""Explicit live-provider rehearsal using only the shared synthetic policy cases.

Uses the production Answers path, temporary database and at most three requests.
It never opens JOBS_DB or reads any owner Profile. Provider credentials remain in
the existing environment/file mount; neither requests nor credentials are logged.
"""
import argparse
import asyncio
from collections import defaultdict
import copy
import json
from json import loads
from pathlib import Path
import tempfile

import httpx

from jobs_radar.answers import Answers
from jobs_radar.luna_screening import api_key
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store

CASES = Path(__file__).with_name('fixtures') / 'answer-policy-cases.json'


def field(case):
    return {'fieldId': case['id'], 'question': case['question'], 'type': case['type'],
            'required': True, 'options': [{'value': value, 'label': value} for value in case.get('options', [])]}


def check(case, actual):
    expected = case['expected']
    mismatches = [key for key, value in expected.items() if key != 'nonempty' and actual.get(key) != value]
    if expected.get('nonempty') and (not isinstance(actual.get('value'), str) or not actual['value'].strip()):
        mismatches.append('nonempty')
    return {'id': case['id'], 'passed': not mismatches, 'mismatches': mismatches,
            **({'syntheticActualValue': actual.get('value')} if mismatches else {}),
            'state': actual.get('state'), 'source': actual.get('source'),
            'needsConfirmation': actual.get('needsConfirmation')}


async def run(client, *, live=False):
    fixture = json.loads(CASES.read_text(encoding='utf-8'))
    assert fixture['synthetic'] is True
    groups = defaultdict(list)
    for case in fixture['cases']:
        groups[json.dumps(case.get('profilePatch', {}), sort_keys=True)].append(case)
    assert len(groups) <= 3
    results, usages, provider_answers = [], [], {}

    class RecordingClient:
        async def post(self, url, json):
            response = await client.post(url, json=json)
            if response.status_code == 200:
                body = response.json()
                usages.append(body.get('usage', {}))
                output = ''.join(part.get('text', '') for entry in body.get('output', [])
                                 for part in entry.get('content', []) if part.get('type') == 'output_text')
                for answer in loads(output).get('answers', []):
                    provider_answers[answer['fieldId']] = answer
            return response

    with tempfile.TemporaryDirectory(prefix='synthetic-policy-') as directory:
        store = Store(Path(directory) / 'synthetic.sqlite')
        profiles, answers = Profiles(store), Answers(store)
        for patch, cases in groups.items():
            profile = {**copy.deepcopy(fixture['profile']), **json.loads(patch)}
            saved = profiles.save(profile)
            result = await answers.generate({'profileId': saved['id'], 'profileVersion': saved['last_sync'],
                'fields': [field(case) for case in cases], 'jobTitle': 'Software engineering internship',
                'jobDescription': 'Build reliable web services and test their behavior.'}, RecordingClient())
            received = {row['fieldId']: row for row in result['answers']}
            for case in cases:
                checked = check(case, received[case['id']])
                raw = check(case, provider_answers[case['id']])
                results.append({**checked, 'providerPassed': raw['passed'],
                                'providerMismatches': raw['mismatches'],
                                'guardChanged': any(received[case['id']].get(key) != provider_answers[case['id']].get(key)
                                                    for key in ('state', 'value', 'source', 'needsConfirmation'))})
    return {'evidence': 'live_provider' if live else 'mocked_provider', 'syntheticOnly': True,
            'model': result['model'], 'requests': len(groups), 'usage': usages, 'cases': results,
            'passed': all(row['passed'] for row in results)}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    async with httpx.AsyncClient(headers={'Authorization': 'Bearer ' + api_key()}, timeout=90, trust_env=False) as client:
        report = await run(client, live=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
