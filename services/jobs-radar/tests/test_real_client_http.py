"""Request envelopes captured from current clients cross the real ASGI boundary."""
import copy
import json
from pathlib import Path
import subprocess
import time
import uuid

import pytest
from starlette.testclient import TestClient

from jobs_radar.answers import Answers
from jobs_radar.application_records import ApplicationRecords
from jobs_radar.board import Board
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.profiles import Profiles
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_profiles import profile
from test_store import observation


def capture_clients(data):
    script = Path(__file__).with_name('client-http-fixture.mjs')
    run = subprocess.run(['node', str(script)], input=json.dumps(data), text=True,
                         encoding='utf-8', capture_output=True, timeout=30, cwd=script.parent)
    assert run.returncode == 0, run.stderr
    return {row['scenario']: row for row in json.loads(run.stdout)}


@pytest.fixture
def clients(tmp_path):
    store = Store(tmp_path / 'client-http.sqlite')
    url = observation()['apply_url']
    store.ingest('simplify:newgrad', [observation()], 'fixture')
    device = str(uuid.uuid4())
    pair = ExtensionSync(store).pair(device, EXTENSION_ID)
    profiles = Profiles(store)
    token = profiles.grant(device)
    saved = profiles.save(profile('Fixture'))
    data = {'device_id': device, 'receipt_token': pair['token'], 'profile_token': token,
            'profile_id': saved['id'], 'profile_version': saved['last_sync'], 'job_url': url}
    server = create_server(store, 'https://jobs.siyidu.com')
    with TestClient(server.streamable_http_app(), base_url='https://jobs.siyidu.com') as client:
        yield store, client, data, capture_clients(data)


def request(client, row, token=None, *, protocol=True):
    headers = dict(row['headers'])
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if not protocol:
        headers.pop('X-Jobs-Protocol', None)
    return client.request(row['method'], row['path'], headers=headers, json=row['body'])


def dump(store):
    with store.connect() as c:
        return list(c.iterdump())


def test_actual_receipt_proofs_preserve_attempt_error_confirmation_and_owner_undo(clients):
    store, client, _, rows = clients
    for scenario, expected in [('submit_attempt', 'submitted'),
                               ('submit_validation_error', 'submitted_unconfirmed'),
                               ('ats_confirmation', 'submitted'), ('tracker_record', 'already_submitted')]:
        result = request(client, rows[scenario])
        assert result.status_code == 200, (scenario, result.text)
        assert result.json()['state'] == expected
        row = ApplicationRecords(store).list()['applications'][0]
        assert row['submission']['attempted_at']
        if scenario == 'submit_validation_error':
            assert row['submission']['error']
        assert bool(row['submission']['confirmed_at']) == (scenario in {'ats_confirmation', 'tracker_record'})
    state = store.get_jobs([result.json()['job_id']])[0]
    Board(store).undo_submitted(state['id'], state['version'], 'fixture-undo')
    delayed = copy.deepcopy(rows['ats_confirmation'])
    delayed['body']['event_id'] = str(uuid.uuid4())
    delayed['body']['observed_at'] = '2020-01-01T00:00:00Z'
    ignored = request(client, delayed)
    assert ignored.status_code == 200 and ignored.json()['state'] == 'ignored_after_undo'
    assert ignored.json()['retryable'] is False
    assert store.get_jobs([state['id']])[0]['status'] == 'not_started'


def test_current_website_store_row_operations_progress_and_settings_cross_http(clients):
    store, client, data, rows = clients
    token = data['profile_token']
    for name in ['state-settings', 'application-create']:
        result = request(client, rows[name], token)
        assert result.status_code == 200, (name, result.text)
    row = ApplicationRecords(store).list()['applications'][0]
    data['application'] = row
    edits = capture_clients(data)
    for name in ['application-update', 'application-progress', 'application-delete']:
        before = dump(store)
        rejected = request(client, edits[name], token, protocol=False)
        assert rejected.status_code == 426
        assert dump(store) == before
        result = request(client, edits[name], token)
        assert result.status_code == 200, (name, result.text)
        if name == 'application-update':
            assert ApplicationRecords(store).list()['applications'][0]['jobTitle'] == 'Updated Fixture Engineer'
        if name == 'application-progress':
            assert ApplicationRecords(store).list()['applications'][0]['progress']['round'] == 1
    assert ApplicationRecords(store).list()['applications'] == []


@pytest.mark.parametrize('owner_edit', ['application-update', 'application-progress'])
def test_later_receipt_cannot_restore_undo_permission_after_an_owner_edit(clients, owner_edit):
    store, client, data, rows = clients
    first = request(client, rows['submit_attempt'])
    assert first.status_code == 200
    job_id = first.json()['job_id']
    with store.connect() as c:
        original_undo = dict(c.execute('SELECT * FROM owner_submission_undo WHERE job_id=?',(job_id,)).fetchone())
    data['application'] = ApplicationRecords(store).list()['applications'][0]
    edit = capture_clients(data)[owner_edit]
    assert request(client, edit, data['profile_token']).status_code == 200
    assert request(client, rows['ats_confirmation']).status_code == 200
    with store.connect() as c:
        undo = dict(c.execute('SELECT * FROM owner_submission_undo WHERE job_id=?',(job_id,)).fetchone())
    assert undo == original_undo
    state = store.get_jobs([job_id])[0]
    before = dump(store)
    with pytest.raises(ValueError, match='投递记录已更新'):
        Board(store).undo_submitted(job_id, state['version'], 'blocked-stale-undo')
    assert dump(store) == before


def test_actual_answer_clients_reach_bound_profile_and_field_validator(clients, monkeypatch):
    store, client, _, rows = clients
    calls = []
    class Provider:
        async def post(self, url, json):
            data = __import__('json').loads(json['input'])
            calls.append(data)
            result = {'answers': [{'fieldId': 'motivation', 'state': 'needs_input', 'value': None,
                        'source': 'unknown', 'needsConfirmation': True, 'reason': 'Fixture missing fact'}]} if 'fields' in data else {
                        'state': 'answer', 'text': 'Fixture answer', 'source': 'profile'}
            class Response:
                status_code = 200
                def json(self):
                    return {'status': 'completed', 'output': [{'content': [{'type': 'output_text', 'text': __import__('json').dumps(result)}]}]}
            return Response()
    generate = Answers.generate
    async def local_provider(self, payload):
        return await generate(self, payload, client=Provider())
    monkeypatch.setattr(Answers, 'generate', local_provider)
    for name in ['answer-text', 'answer-fields']:
        response = request(client, rows[name])
        assert response.status_code == 202, response.text
        request_id = rows[name]['body']['requestId']
        for _ in range(100):
            status = client.get('/api/manage/answer/jobs', params={'id': request_id}, headers=rows[name]['headers']).json()
            if status['state'] != 'pending':
                break
            time.sleep(.01)
        assert status['state'] == 'completed', status
    assert len(calls) == 2
    assert calls[0]['profile']['profileName'] == 'Fixture'
    assert calls[1]['formContext'][0]['answer'] == 'Fixture'
    assert calls[1]['fields'][0]['fieldId'] == 'motivation'


@pytest.mark.parametrize('name', ['submit_attempt', 'submit_validation_error', 'ats_confirmation',
                                  'answer-text', 'answer-fields', 'state-settings', 'application-create'])
def test_identical_real_client_write_without_current_protocol_cannot_mutate(clients, name):
    store, client, data, rows = clients
    row = rows[name]
    token = data['profile_token'] if name in {'state-settings', 'application-create'} else None
    before = dump(store)
    result = request(client, row, token, protocol=False)
    assert result.status_code == 426, result.text
    assert result.json()['code'] == 'client_upgrade_required'
    assert dump(store) == before
