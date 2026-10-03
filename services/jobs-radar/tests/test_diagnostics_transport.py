import uuid

import pytest
from starlette.testclient import TestClient

from jobs_radar.browser_control import BrowserControl, ControlConflict
from jobs_radar.browser_history import Diagnostics
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.profiles import Profiles
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_browser_control import page, NOW
from test_browser_history import packet


def test_idle_inventory_never_collects_content_and_only_requested_documents_are_accepted(tmp_path):
    control = BrowserControl(Store(tmp_path / 'control.sqlite'), lambda: NOW)
    device, session = str(uuid.uuid4()), str(uuid.uuid4())
    inventory = [{k: page()[k] for k in ('tabId', 'frameId', 'documentId')}]
    poll = {'protocolVersion': 2, 'sessionId': session, 'inventory': inventory, 'pages': [], 'results': []}
    assert control.exchange(device, poll)['snapshotRequests'] == []
    with pytest.raises(ControlConflict, match='not requested'):
        control.exchange(device, {**poll, 'pages': [page()]})
    assert control.pages()['snapshotPending'] == []
    demand = control.pages(device, session, inventory[0])
    assert demand['pages'] == [] and len(demand['snapshotPending']) == 1
    assert control.exchange(device, poll)['snapshotRequests'] == inventory
    assert control.exchange(device, {**poll, 'pages': [page()]})['snapshotRequests'] == []
    assert control.exchange(device, poll)['snapshotRequests'] == []
    with pytest.raises(ValueError):
        control.exchange(device, {**poll, 'inventory': [{**inventory[0], 'url': page()['url']}]})


def test_diagnostics_upload_is_independent_of_remote_control(tmp_path, monkeypatch):
    monkeypatch.delenv('JOBS_BROWSER_CONTROL_ENABLED', raising=False)
    monkeypatch.delenv('JOBS_BROWSER_OBSERVE_ENABLED', raising=False)
    store = Store(tmp_path / 'diagnostics.sqlite')
    device = str(uuid.uuid4())
    ExtensionSync(store).pair(device, EXTENSION_ID)
    token = Profiles(store).grant(device)
    server = create_server(store, 'https://radar.test')
    import time
    data = packet(at=int(time.time() * 1000))
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as client:
        assert client.post('/api/extension/control', json={}).status_code == 404
        body = {'protocolVersion': 1, 'history': [data]}
        assert client.post('/api/extension/diagnostics', json=body).status_code == 401
        response = client.post('/api/extension/diagnostics', json=body, headers={'authorization': 'Bearer ' + token})
        assert response.json() == {'historyAccepted': True, 'historyEventMetrics': 1}
    assert len(Diagnostics(store).history()['applications']) == 1


def test_run_identity_expiry_and_pinned_unresolved_cases(tmp_path, monkeypatch):
    store = Store(tmp_path / 'history.sqlite')
    clock = [NOW]
    diagnostics = Diagnostics(store, lambda: clock[0])
    first = packet()
    second = {**packet(), 'runId': 'another-run'}
    diagnostics.receive('device', {'protocolVersion': 1, 'history': [first, second]})
    index = diagnostics.history()['applications']
    assert len(index) == 2
    pinned = index[0]['id']
    diagnostics.retain(pinned, 'notes/cases/real-failure.md')
    clock[0] += 31 * 86400000
    rows = diagnostics.history()['applications']
    assert [row['id'] for row in rows] == [pinned]
    diagnostics.retain(pinned)
    assert diagnostics.history()['applications'] == []


def test_private_answers_are_synthetic_and_passwords_never_reach_storage(tmp_path):
    store = Store(tmp_path / 'history.sqlite')
    diagnostics = Diagnostics(store, lambda: NOW)
    data = packet()
    field = data['snapshots'][0]['fields'][0]
    field.update(value='Personal private answer', trace={'answer': 'Personal private answer', 'chosen': 'Personal private answer'})
    data['snapshots'][0]['fields'].append({**field, 'id': 'secret', 'question': 'Verification code'})
    diagnostics.receive('device', {'protocolVersion': 1, 'history': [data]})
    with store.connect() as c:
        stored = c.execute('SELECT data FROM browser_diagnostic_history').fetchone()[0]
        assert 'Personal private answer' not in stored and 'Verification code' not in stored


def test_separate_packets_keep_value_changes_and_exact_retries_stable(tmp_path):
    store = Store(tmp_path / 'history.sqlite')
    diagnostics = Diagnostics(store, lambda: NOW + 1000)
    for offset, value in enumerate(['Alpha', 'Beta', 'Alpha']):
        data = packet(at=NOW + offset)
        data['snapshots'][0]['fields'][0]['value'] = value
        diagnostics.receive('device', {'protocolVersion': 1, 'history': [data]})
        diagnostics.receive('device', {'protocolVersion': 1, 'history': [data]})
    rows = diagnostics.history()['applications']
    snapshots = diagnostics.history(rows[0]['id'])['snapshots']
    assert len(snapshots) == 3
    values = [s['fields'][0]['value'] for s in snapshots]
    assert values[0] == values[2] and values[0] != values[1]


def test_requesting_one_tab_never_asks_another_tab_for_content(tmp_path):
    control = BrowserControl(Store(tmp_path / 'control.sqlite'), lambda: NOW)
    device, session = str(uuid.uuid4()), str(uuid.uuid4())
    inventory = [{k: page(tab)[k] for k in ('tabId', 'frameId', 'documentId')} for tab in (1, 2)]
    poll = {'protocolVersion': 2, 'sessionId': session, 'inventory': inventory, 'pages': [], 'results': []}
    control.exchange(device, poll)
    assert control.pages()['snapshotPending'] == []
    control.pages(device, session, inventory[1])
    assert control.exchange(device, poll)['snapshotRequests'] == [inventory[1]]


def test_plugin_case_pins_survive_expiry_and_cannot_remove_independent_owner_pin(tmp_path):
    store = Store(tmp_path / 'case-pins.sqlite')
    clock = [NOW]
    diagnostics = Diagnostics(store, lambda: clock[0])
    data = {**packet(), 'caseRetention': {'revision': 1, 'unresolvedCaseIds': ['synthetic-case']}}
    send = lambda item: diagnostics.receive('device', {'protocolVersion': 1, 'history': [item]})
    send(data)
    history_id = diagnostics.history()['applications'][0]['id']
    clock[0] += 31 * 86400000
    assert diagnostics.history()['applications'][0]['pinned'] is True
    # Missing/old metadata cannot silently forget a captured unresolved case.
    send(packet())
    assert diagnostics.history()['applications'][0]['pinned'] is True
    with pytest.raises(ValueError, match='revision'):
        send({**data, 'caseRetention': {'revision': 1, 'unresolvedCaseIds': []}})
    diagnostics.retain(history_id, 'notes/cases/independent-owner-case.md')
    send({**data, 'caseRetention': {'revision': 2, 'unresolvedCaseIds': []}})
    send(data)  # Late retry must not resurrect the plugin pin.
    current = diagnostics.history()['applications'][0]
    assert current['caseRetention'] == {'revision': 2, 'unresolvedCaseIds': []}
    assert current['pinned'] is True
    diagnostics.retain(history_id)
    assert diagnostics.history()['applications'] == []


def test_case_ids_cannot_contain_freeform_personal_data(tmp_path):
    diagnostics = Diagnostics(Store(tmp_path / 'invalid-case.sqlite'), lambda: NOW)
    for ids in [['someone@example.test'], ['same', 'same'], ['private answer']]:
        data = {**packet(), 'caseRetention': {'revision': 1, 'unresolvedCaseIds': ids}}
        with pytest.raises(ValueError):
            diagnostics.receive('device', {'protocolVersion': 1, 'history': [data]})
    assert diagnostics.history()['applications'] == []
