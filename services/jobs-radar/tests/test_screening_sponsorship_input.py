import json

import httpx
import pytest

from jobs_radar.board import fingerprint
from jobs_radar.luna_screening import classify, public_input
from test_luna_screening import reply


@pytest.mark.parametrize('label', [
    'Offers Sponsorship', 'Does Not Offer Sponsorship',
    'U.S. Citizenship is Required', 'Other', None,
])
def test_provider_receives_source_sponsorship_without_inventing_missing_values(label):
    sources = [
        {'company': 'Example', 'title': 'Software Engineer', 'locations': ['USA'],
         'repository': 'SimplifyJobs/New-Grad-Positions', 'sponsorship': label},
        {'company': 'Example', 'title': 'Software Engineer', 'locations': ['USA'],
         'repository': 'speedyapply/2027-SWE-College-Jobs'},
    ]
    row = {'id': 'canonical', 'kind': 'newgrad', 'company': 'Example',
           'title': 'Software Engineer', 'all_sources': sources}
    calls = []

    def provider(request):
        rows = json.loads(json.loads(request.content)['input'])
        calls.extend(rows)
        return httpx.Response(200, json=reply(rows))

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        classify(client, [row])
    sent = calls[0]['sources']
    assert sent[0]['sponsorship'] == label
    assert sent[1]['sponsorship'] is None
    assert sent[0]['repository'] != sent[1]['repository']


def test_disagreeing_sources_remain_distinct_and_changes_invalidate_cached_input():
    source = {'company': 'Example', 'title': 'Software Engineer', 'locations': ['USA'],
              'repository': 'SimplifyJobs/New-Grad-Positions', 'sponsorship': 'Offers Sponsorship'}
    sources = [source, {**source, 'repository': 'another-source', 'sponsorship': 'Does Not Offer Sponsorship'}]
    row = {'id': 'canonical', 'kind': 'newgrad', 'company': 'Example',
           'title': 'Software Engineer', 'all_sources': sources}
    assert [s['sponsorship'] for s in public_input(row, 'job_0')['sources']] == [
        'Offers Sponsorship', 'Does Not Offer Sponsorship']
    changed = [{**source, 'sponsorship': 'Other'}, sources[1]]
    assert fingerprint(sources) != fingerprint(changed)

    assert fingerprint(sources) == fingerprint(sources[::-1])
