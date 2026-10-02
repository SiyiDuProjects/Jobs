import sqlite3

from starlette.testclient import TestClient

from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_extension_sync import DEVICE, ORIGIN, receipt
from test_store import observation


def test_actual_plugin_resolve_payload_and_authoritative_submission_state(tmp_path):
    store = Store(tmp_path / 'db.sqlite')
    store.ingest('simplify:newgrad', [observation()], 'fixture')
    server = create_server(store, ORIGIN)
    pair = ExtensionSync(store).pair(DEVICE, EXTENSION_ID)
    headers = {'Authorization': 'Bearer ' + pair['token'], 'X-Jobs-Protocol': '2'}
    with TestClient(server.streamable_http_app(), base_url=ORIGIN, headers=headers) as client:
        # JobsSync.resolveJob sends url (receipt writes send job_url instead).
        request = {'url': observation()['apply_url']}
        initial = client.post('/api/extension/resolve', json=request)
        assert initial.status_code == 200, initial.text
        assert initial.json()['application']['submitted'] is False
        attempt = receipt()
        attempt['proof'] = 'submit_attempt'
        assert client.post('/api/extension/events', json=attempt).status_code == 200
        current = client.post('/api/extension/resolve', json=request).json()
        assert current['application']['submitted'] and not current['application']['confirmed']
        assert current['application']['label'] == '已投递'
        assert not current['queue']['allowed']
        assert client.post('/api/extension/events', json=receipt()).status_code == 200
        current = client.post('/api/extension/resolve', json=request).json()
        assert current['application']['confirmed'] and current['application']['confirmed_at']
        assert current['application']['label'] == '已确认投递'
        assert client.post('/api/extension/resolve', json={'job_url': request['url']}).status_code == 400


def test_old_receipt_clients_cannot_change_even_authentication_timestamps(tmp_path):
    database = tmp_path / 'db.sqlite'
    store = Store(database)
    store.ingest('simplify:newgrad', [observation()], 'fixture')
    server = create_server(store, ORIGIN)
    pair = ExtensionSync(store).pair(DEVICE, EXTENSION_ID)
    with sqlite3.connect(database) as connection:
        before = list(connection.iterdump())
    with TestClient(server.streamable_http_app(), base_url=ORIGIN) as client:
        for version in [None, '1', '3']:
            headers = {'Authorization': 'Bearer ' + pair['token']}
            if version:
                headers['X-Jobs-Protocol'] = version
            response = client.post('/api/extension/events', json=receipt(), headers=headers)
            assert response.status_code == 426
            assert response.json()['code'] == 'client_upgrade_required'
        with sqlite3.connect(database) as connection:
            assert list(connection.iterdump()) == before


def test_external_and_hidden_application_records_still_block_repeated_submission(tmp_path):
    store = Store(tmp_path / 'external.sqlite')
    server = create_server(store, ORIGIN)
    pair = ExtensionSync(store).pair(DEVICE, EXTENSION_ID)
    url = 'https://jobs.ashbyhq.com/example/external-job/application'
    headers = {'Authorization': 'Bearer ' + pair['token'], 'X-Jobs-Protocol': '2'}
    with TestClient(server.streamable_http_app(), base_url=ORIGIN, headers=headers) as client:
        assert client.post('/api/extension/resolve', json={'url': url}).json() == {'state': 'unmatched', 'application': None}
        event = receipt()
        event.update(job_url=url, proof='submit_attempt')
        response = client.post('/api/extension/events', json=event)
        assert response.status_code == 200, response.text
        first = client.post('/api/extension/resolve', json={'url': url}).json()
        assert first['state'] == 'unmatched' and first['application']['submitted']
        from jobs_radar.application_records import ApplicationRecords
        records = ApplicationRecords(store)
        records.mutate([{'action': 'delete', 'application_id': first['application']['id'],
                         'expected_version': first['application']['version']}], 'hide-for-test')
        assert client.post('/api/extension/resolve', json={'url': url}).json()['application']['submitted']
