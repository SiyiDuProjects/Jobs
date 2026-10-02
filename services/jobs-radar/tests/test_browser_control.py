import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import uuid
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from jobs_radar.auth import OWNER
from jobs_radar.browser_control import BrowserControl, ControlConflict, MAX_BODY, MAX_OPTIONS
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.profiles import Profiles
from jobs_radar.server import create_server
from jobs_radar.store import Store


NOW = 1_800_000_000_000
CONTROL_TOOLS = {'get_browser_pages', 'command_browser_page', 'get_browser_command'}


def page(tab=7, frame=0, revision=1, now=NOW):
    return {'tabId': tab, 'frameId': frame, 'documentId': f'document-{tab}-{frame}', 'revision': revision,
            'url': 'https://jobs.ashbyhq.com/example/job/application', 'title': 'Software Engineer',
            'profileId': 'newgrad-profile', 'profileName': 'Newgrad', 'ats': 'ashby', 'phase': 'form',
            'visibility': 'hidden', 'coverage': 'partial', 'observedAt': now,
            'fields': [{'id': 'field-1', 'question': 'Your answer?', 'type': 'text', 'required': True,
                        'filled': False, 'invalid': False, 'supported': True}],
            'counts': {'total': 20, 'unfilled': 1, 'unsupported': 2},
            'actions': ['inspect', 'autofill', 'fill_answers', 'next', 'submit']}


def target(p):
    return {key: p[key] for key in ('tabId', 'frameId', 'documentId', 'revision')}


@pytest.fixture
def subject(tmp_path):
    store = Store(tmp_path / 'control.sqlite')
    clock = [NOW]
    control = BrowserControl(store, lambda: clock[0])
    device, session = str(uuid.uuid4()), str(uuid.uuid4())
    return store, control, clock, device, session


def exchange(subject, pages=None, results=None, session=None):
    _, control, _, device, original_session = subject
    values = [page()] if pages is None else pages
    body = {'protocolVersion': 2, 'sessionId': session or original_session,
            'inventory': [{k: p[k] for k in ('tabId', 'frameId', 'documentId')} for p in values],
            'pages': [], 'results': results or []}
    first = control.exchange(device, body)
    for document in body['inventory']:
        control.pages(device, body['sessionId'], document)
    second = control.exchange(device, {**body, 'pages': values, 'results': []})
    second['commands'] = first['commands'] + second['commands']
    return second


def http_snapshot(client, control, body, headers):
    inventory = [{k: p[k] for k in ('tabId', 'frameId', 'documentId')} for p in body['pages']]
    payload = {**body, 'protocolVersion': 2, 'inventory': inventory}
    response = client.post('/api/extension/control', json={**payload, 'pages': []}, headers=headers)
    if response.status_code != 200:
        return response
    for document in inventory:
        control.pages(Profiles(control.store).authenticate(headers['authorization'][7:]), body['sessionId'], document)
    return client.post('/api/extension/control', json=payload, headers=headers)


def command(subject, p=None, action='inspect', identity='command-1', **kwargs):
    _, control, _, device, session = subject
    return control.command(device, session, target(p or page()), action, identity, **kwargs)


def test_review_commands_use_only_current_card_fields_and_keep_replay_fencing(subject):
    p = page()
    p['phase'] = 'ai-review'
    p['actions'] = ['inspect', 'answer_review', 'confirm_review']
    p['review'] = {'id': 'review-1', 'ready': True, 'action': 'next',
                   'items': [{'itemId': '0', 'fieldId': 'field-1', 'version': 3}]}
    p['fields'].append({**p['fields'][0], 'id': 'unrelated'})
    exchange(subject, [p])
    with pytest.raises(ValueError, match='current review'):
        command(subject, p, action='answer_review', answers=[{'fieldId': 'unrelated', 'value': 'No'}])
    result = command(subject, p, action='answer_review', answers=[{'fieldId': 'field-1', 'value': 'No'}])
    assert result['action'] == 'answer_review'
    assert len(exchange(subject, [p])['commands']) == 1
    assert exchange(subject, [p])['commands'] == []
    exchange(subject, [p], results=[{'id': result['id'], 'state': 'completed', 'data': {'action': 'answer_review'}}])
    confirmed = command(subject, p, action='confirm_review', identity='confirm-1')
    assert confirmed['action'] == 'confirm_review'


@pytest.mark.parametrize('action', ['fill_answers','answer_review'])
def test_unknown_field_write_can_continue_only_after_expiry_and_a_fresh_page_read(subject, action):
    _, control, clock, _, _ = subject
    p=page()
    if action=='answer_review':
        p['actions'] += ['answer_review','confirm_review']
        p['review']={'id':'review-1','ready':True,'action':'next',
                     'items':[{'itemId':'0','fieldId':'field-1','version':1}]}
    exchange(subject,[p])
    command(subject,p,action=action,answers=[{'fieldId':'field-1','value':'No'}],ttl_seconds=1)
    assert len(exchange(subject,[p])['commands'])==1
    exchange(subject,[p],results=[{'id':'command-1','state':'unknown','error':'Connection interrupted'}])
    with pytest.raises(ControlConflict):
        command(subject,p,action=action,identity='too-early',answers=[{'fieldId':'field-1','value':'No'}])
    clock[0]+=1001
    with pytest.raises(ControlConflict):
        command(subject,p,action=action,identity='old-read',answers=[{'fieldId':'field-1','value':'No'}])
    p['observedAt']=clock[0]
    exchange(subject,[p])
    fresh=command(subject,p,action=action,identity='fresh-answer',answers=[{'fieldId':'field-1','value':'No'}])
    assert fresh['state']=='queued'
    assert control.get_command('command-1')['state']=='unknown'


def test_review_schema_and_readiness_are_validated(subject):
    p = page()
    p['actions'] = ['inspect', 'answer_review']
    p['review'] = {'id': 'review-1', 'ready': False, 'action': 'fill',
                   'items': [{'itemId': '0', 'fieldId': 'field-1', 'version': 1}]}
    exchange(subject, [p])
    with pytest.raises(ValueError, match='not ready'):
        command(subject, p, action='answer_review', answers=[{'fieldId': 'field-1', 'value': 'No'}])
    p['review']['items'][0]['version'] = -1
    with pytest.raises(ValueError):
        exchange(subject, [p])


def test_long_select_options_preserve_review_and_option_bounds(subject):
    p = page()
    p['fields'][0].update(type='select-one', options=[{'value': str(i), 'label': f'University {i}'} for i in range(MAX_OPTIONS)])
    p['phase'] = 'ai-review'
    p['actions'] = ['inspect', 'answer_review', 'confirm_review']
    p['review'] = {'id': 'review', 'ready': True, 'action': 'submit',
                   'items': [{'itemId': 'one', 'fieldId': 'field-1', 'version': 1}]}
    exchange(subject, [p])
    result = command(subject, p, action='answer_review', answers=[{'fieldId': 'field-1', 'value': str(MAX_OPTIONS - 1)}])
    assert result['action'] == 'answer_review'
    assert len(subject[1].pages()['pages'][0]['fields'][0]['options']) == MAX_OPTIONS
    p['fields'][0]['options'].append({'value': 'overflow', 'label': 'Overflow'})
    with pytest.raises(ValueError):
        exchange(subject, [p])


def test_default_disabled_exposes_no_routes_tools_or_tables(tmp_path, monkeypatch):
    monkeypatch.delenv('JOBS_BROWSER_CONTROL_ENABLED', raising=False)
    monkeypatch.delenv('JOBS_BROWSER_OBSERVE_ENABLED', raising=False)
    store = Store(tmp_path / 'disabled.sqlite')
    server = create_server(store, 'https://radar.test')
    assert not ({t.name for t in asyncio.run(server.list_tools())} & CONTROL_TOOLS)
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as client:
        assert client.post('/api/extension/control', json={}).status_code == 404
    with store.connect() as c:
        assert not c.execute("SELECT name FROM sqlite_master WHERE name LIKE 'browser_control_%'").fetchall()


@pytest.mark.parametrize('setting', ['', '0', 'true', 'yes'])
def test_only_explicit_one_enables_control(tmp_path, monkeypatch, setting):
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', setting)
    server = create_server(Store(tmp_path / 'disabled.sqlite'))
    assert not ({t.name for t in asyncio.run(server.list_tools())} & CONTROL_TOOLS)


def test_observer_mode_has_authenticated_page_read_but_no_command_tools(subject, monkeypatch):
    store, _, _, device, session = subject
    monkeypatch.setenv('JOBS_BROWSER_OBSERVE_ENABLED', '1')
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '0')
    ExtensionSync(store).pair(device, EXTENSION_ID)
    token = Profiles(store).grant(device)
    server = create_server(store, 'https://radar.test')
    names = {t.name for t in asyncio.run(server.list_tools())}
    assert names & CONTROL_TOOLS == {'get_browser_pages'}
    value = page(now=__import__('time').time_ns() // 1_000_000)
    value['fields'][0]['value'] = 'Current editable answer'
    value['events'] = [{'at': value['observedAt'], 'type': 'action_returned', 'fieldId': 'field-1', 'detail': 'text'}]
    body = {'sessionId': session, 'pages': [value], 'results': []}
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as client:
        assert client.post('/api/extension/control', json=body).status_code == 401
        response = http_snapshot(client, BrowserControl(store), body, {'authorization': 'Bearer ' + token})
        assert response.json() == {'enabled': True, 'protocolVersion': 2, 'commands': [], 'snapshotRequests': []}
    observer = BrowserControl(store, allow_commands=False)
    result = observer.pages()
    assert result['executionEnabled'] is False
    assert result['pages'][0]['actions'] == ['inspect']
    assert result['pages'][0]['fields'][0]['value'] == 'Current editable answer'
    assert result['pages'][0]['events'][0]['fieldId'] == 'field-1'
    with pytest.raises(ControlConflict, match='disabled'):
        observer.command(device, session, target(value), 'submit', 'never-submit')


def test_observer_never_dispatches_previously_queued_mutations(subject):
    store, control, clock, device, session = subject
    exchange(subject)
    queued = command(subject, action='submit')
    observer = BrowserControl(store, lambda: clock[0], allow_commands=False)
    assert observer.exchange(device, {'protocolVersion': 2, 'sessionId': session, 'inventory': [{k: page()[k] for k in ('tabId', 'frameId', 'documentId')}], 'pages': [], 'results': []})['commands'] == []
    assert control.get_command(queued['id'])['dispatchedAt'] is None


def test_trace_schema_and_snapshot_retention_are_bounded(subject):
    _, control, clock, _, _ = subject
    value = page()
    value['events'] = [{'at': NOW, 'type': 'input', 'fieldId': 'field-1', 'answer': 'not a log field'}]
    with pytest.raises(ValueError):
        exchange(subject, [value])
    value['events'] = [{'at': NOW, 'type': 'input'}] * 51
    with pytest.raises(ValueError):
        exchange(subject, [value])
    exchange(subject)
    clock[0] += 86400001
    assert control.pages()['pages'] == []


def test_same_answer_api_preserves_explicit_replace_flag(subject):
    exchange(subject)
    result = command(subject, action='fill_answers', answers=[{'fieldId': 'field-1', 'value': 'New answer', 'replace': True}])
    assert result['args']['answers'][0]['replace'] is True


def test_http_requires_profile_device_auth_and_bounds(subject, monkeypatch):
    store, _, _, device, session = subject
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '1')
    extension = ExtensionSync(store)
    paired = extension.pair(device, EXTENSION_ID)
    profiles = Profiles(store)
    token = profiles.grant(device)
    server = create_server(store, 'https://radar.test')
    body = {'sessionId': session, 'pages': [page(now=__import__('time').time_ns() // 1_000_000)], 'results': []}
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as client:
        assert client.post('/api/extension/control', json=body).status_code == 401
        assert client.post('/api/extension/control', json=body, headers={'authorization': 'Bearer ' + paired['token']}).status_code == 401
        headers = {'authorization': 'Bearer ' + token}
        assert client.post('/api/extension/control', content='{}', headers=headers).status_code == 415
        assert client.post('/api/extension/control', content=' ' * (MAX_BODY + 1), headers={**headers, 'content-type': 'application/json'}).status_code == 413
        response = http_snapshot(client, BrowserControl(store), body, headers)
        assert response.status_code == 200 and response.json() == {'enabled': True, 'protocolVersion': 2, 'commands': [], 'snapshotRequests': []}
        assert response.headers['cache-control'] == 'no-store'
        # Exercise the HTTP parser as well as field validation: twenty real-
        # sized school lists used to exceed both independent transport limits.
        large_pages = [page(tab=i, now=__import__('time').time_ns() // 1_000_000) for i in range(20)]
        for p in large_pages:
            p['fields'][0].update(type='select-one', options=[{'value': str(i), 'label': f'University {i}'} for i in range(1500)])
        large_body = {**body, 'pages': large_pages}
        assert 512 * 1024 < len(json.dumps(large_body).encode()) < MAX_BODY
        assert http_snapshot(client, BrowserControl(store), large_body, headers).status_code == 200
        assert client.post('/api/extension/control', json={**body, 'execute': 'javascript'}, headers=headers).status_code == 400
        assert client.post('/api/extension/control', json={**body, 'sessionId': 3}, headers=headers).status_code == 400
        extension.disconnect(device)
        assert client.post('/api/extension/control', json=body, headers=headers).status_code == 401


def test_enabled_tools_require_existing_owner_scopes(subject, monkeypatch):
    store, _, _, _, _ = subject
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '1')
    server = create_server(store)
    tools = {t.name: t for t in asyncio.run(server.list_tools())}
    assert CONTROL_TOOLS <= tools.keys()
    assert tools['get_browser_pages'].annotations.read_only_hint is True
    assert tools['command_browser_page'].annotations.open_world_hint is True
    assert 'idempotency_key' in tools['command_browser_page'].input_schema['required']
    # FastMCP invokes the registered function through the same auth guard as other tools.
    function = server._tool_manager.get_tool('get_browser_pages').fn
    monkeypatch.setattr('jobs_radar.server.get_access_token', lambda: None)
    with pytest.raises(PermissionError):
        function()
    monkeypatch.setattr('jobs_radar.server.get_access_token', lambda: SimpleNamespace(subject='other', scopes=['jobs:read']))
    with pytest.raises(PermissionError):
        function()
    monkeypatch.setattr('jobs_radar.server.get_access_token', lambda: SimpleNamespace(subject=OWNER, scopes=['jobs:read']))
    assert function()['enabled'] is True
    mutation = server._tool_manager.get_tool('command_browser_page').fn
    with pytest.raises(PermissionError):
        mutation('device', 'session', target(page()), 'submit', 'identity')


def test_exchange_reports_freshness_without_claiming_hidden_is_frozen(subject):
    _, control, clock, _, _ = subject
    exchange(subject)
    result = control.pages()['pages'][0]
    assert result['online'] and result['fresh'] and result['visibility'] == 'hidden'
    assert result['coverage'] == 'partial' and result['counts']['total'] > len(result['fields'])
    clock[0] += 31_000
    result = control.pages()['pages'][0]
    assert not result['online'] and not result['fresh']
    exchange(subject)  # Cached page keeps old observedAt, although browser is online again.
    result = control.pages()['pages'][0]
    assert result['online'] and not result['fresh']
    with pytest.raises(ControlConflict, match='stale'):
        command(subject)


def test_full_snapshot_removes_absent_pages(subject):
    _, control, _, _, _ = subject
    exchange(subject, pages=[page(1), page(2)])
    assert len(control.pages()['pages']) == 2
    exchange(subject, pages=[page(2)])
    assert [p['tabId'] for p in control.pages()['pages']] == [2]
    exchange(subject, pages=[])
    assert control.pages()['pages'] == []


def test_queue_dispatch_once_and_exact_result_replay(subject):
    _, control, _, _, session = subject
    exchange(subject)
    queued = command(subject, action='next')
    assert queued['state'] == 'queued' and not queued['submissionConfirmed']
    response = exchange(subject)
    assert response['commands'] == [{'id': 'command-1', 'sessionId': session, 'target': target(page()),
                                    'action': 'next', 'args': {}, 'expiresAt': NOW + 30_000}]
    assert exchange(subject)['commands'] == []
    result = {'id': 'command-1', 'state': 'completed', 'data': {'action': 'next', 'phase': 'submission_pending',
              'evidence': {'type': 'none', 'text': 'Click finished; application outcome not observed.'}}}
    exchange(subject, results=[result])
    exchange(subject, results=[result])
    assert control.get_command('command-1')['state'] == 'completed'
    assert control.get_command('command-1')['submissionConfirmed'] is False
    with pytest.raises(ControlConflict, match='Conflicting'):
        exchange(subject, results=[{**result, 'state': 'failed'}])


def test_idempotency_survives_restart_and_rejects_changed_command(subject):
    store, _, clock, device, session = subject
    exchange(subject)
    original = command(subject, action='next')
    restarted = BrowserControl(Store(store.path), lambda: clock[0])
    assert restarted.command(device, session, target(page()), 'next', 'command-1') == original
    with pytest.raises(ControlConflict, match='Idempotency'):
        restarted.command(device, session, target(page()), 'submit', 'command-1')
    exchange(subject)
    assert restarted.command(device, session, target(page()), 'next', 'command-1')['state'] == 'dispatched'
    assert exchange(subject)['commands'] == []


def test_tabs_parallel_but_frames_on_one_tab_serialize(subject):
    pages = [page(1), page(1, frame=2), page(2)]
    exchange(subject, pages=pages)
    command(subject, p=pages[0], action='autofill', identity='first')
    command(subject, p=pages[2], action='autofill', identity='second')
    with pytest.raises(ControlConflict, match='running'):
        command(subject, p=pages[1], identity='frame')
    assert len(exchange(subject, pages=pages)['commands']) == 2
    with pytest.raises(ControlConflict, match='running'):
        command(subject, p=pages[0], identity='duplicate')
    exchange(subject, pages=pages, results=[{'id': 'first', 'state': 'completed'}])
    assert command(subject, p=pages[1], identity='frame')['state'] == 'queued'


def test_stale_revision_document_and_changed_page_before_dispatch(subject):
    _, control, _, _, _ = subject
    exchange(subject)
    with pytest.raises(ControlConflict, match='changed'):
        command(subject, p=page(revision=2))
    changed = {**page(), 'documentId': 'another-document'}
    with pytest.raises(ControlConflict, match='changed'):
        command(subject, p=changed)
    command(subject, action='submit')
    assert exchange(subject, pages=[page(revision=2)])['commands'] == []
    assert control.get_command('command-1')['state'] == 'cancelled'


def test_session_restart_cancels_pending_and_cannot_revive_old_work(subject):
    _, control, _, _, old = subject
    pages = [page(1), page(2)]
    exchange(subject, pages=pages)
    command(subject, p=pages[0], action='submit', identity='sent')
    exchange(subject, pages=pages)
    command(subject, p=pages[1], action='next', identity='queued')
    new = str(uuid.uuid4())
    assert exchange(subject, session=new, pages=pages)['commands'] == []
    assert control.get_command('sent')['state'] == 'unknown'
    assert control.get_command('queued')['state'] == 'cancelled'
    with pytest.raises(ControlConflict, match='ended'):
        exchange(subject, session=old, pages=pages)
    assert control.pages()['pages'][0]['sessionId'] == new


def test_lost_delivery_stays_unknown_no_blind_retry_but_late_result_reconciles(subject):
    _, control, clock, _, _ = subject
    exchange(subject)
    command(subject, action='submit', ttl_seconds=5)
    exchange(subject)  # Treat the response as lost after server committed dispatch.
    clock[0] += 6000
    assert control.get_command('command-1')['state'] == 'unknown'
    assert exchange(subject, pages=[page(now=clock[0])])['commands'] == []
    with pytest.raises(ControlConflict, match='uncertain'):
        command(subject, action='submit', identity='new-key')
    assert command(subject, identity='inspect-recovery')['state'] == 'queued'
    exchange(subject, results=[{'id': 'command-1', 'state': 'completed'}])
    assert control.get_command('command-1')['state'] == 'completed'


def test_undelivered_expiry_has_no_effect_and_cannot_extend_by_retry(subject):
    _, control, clock, _, _ = subject
    exchange(subject)
    command(subject, action='next', ttl_seconds=2)
    clock[0] += 3000
    assert exchange(subject)['commands'] == []
    assert command(subject, action='next', ttl_seconds=2)['state'] == 'expired'
    assert control.get_command('command-1')['dispatchedAt'] is None
    assert command(subject, identity='fresh-inspect')['state'] == 'queued'


def test_results_cannot_cross_devices_sessions_or_ack_undispatched_commands(subject):
    _, control, _, _, session = subject
    exchange(subject)
    command(subject)
    result = {'id': 'command-1', 'state': 'completed'}
    with pytest.raises(ControlConflict, match='dispatched'):
        exchange(subject, results=[result])
    exchange(subject)
    with pytest.raises(ControlConflict, match='dispatched'):
        control.exchange('another-device', {'protocolVersion': 2, 'sessionId': session, 'inventory': [], 'pages': [], 'results': [result]})
    with pytest.raises(ControlConflict, match='action'):
        exchange(subject, results=[{**result, 'data': {'action': 'submit'}}])


def test_fill_answers_only_known_supported_fields(subject):
    exchange(subject)
    for answer in [{'fieldId': 'missing', 'value': 'Test'}, {'fieldId': 'field-1', 'value': 3},
                   {'fieldId': 'field-1', 'value': 'Test', 'selector': '#unrelated'}]:
        with pytest.raises(ValueError):
            command(subject, action='fill_answers', answers=[answer])
    valid = command(subject, action='fill_answers', answers=[{'fieldId': 'field-1', 'value': ['A', 'B']}])
    assert valid['args'] == {'answers': [{'fieldId': 'field-1', 'value': ['A', 'B']}]}
    assert len(exchange(subject)['commands']) == 1


@pytest.mark.parametrize('change', [
    {'url': 'https://user:password@jobs.ashbyhq.com/example'},
    {'url': 'https://jobs.ashbyhq.com/example?access_token=private'},
    {'url': 'https://jobs.ashbyhq.com/example#api_key=private'},
    {'url': 'javascript:alert(1)'},
    {'url': 'http://jobs.ashbyhq.com/example'},
    {'html': '<html>Private DOM</html>'},
    {'title': 'Bearer secret-value-that-must-not-be-stored'},
    {'coverage': 'complete'},
    {'actions': ['execute_javascript']},
    {'observedAt': NOW + 60_001},
    {'tabId': True},
    {'fields': [{'id': 'secret', 'question': 'Password', 'type': 'password', 'required': True,
                 'filled': False, 'invalid': False, 'supported': False}]},
])
def test_invalid_snapshot_does_not_replace_good_snapshot(subject, change):
    _, control, _, _, _ = subject
    exchange(subject)
    with pytest.raises(ValueError):
        exchange(subject, pages=[{**page(), **change}])
    assert control.pages()['pages'][0]['title'] == 'Software Engineer'


def test_unsupported_action_expiry_limit_extra_result_data_and_duplicate_fields(subject):
    p = page()
    p['actions'] = ['inspect']
    exchange(subject, pages=[p])
    for action in ['submit', 'execute_javascript']:
        with pytest.raises(ValueError):
            command(subject, action=action)
    for seconds in [0, 61, True, 1.5]:
        with pytest.raises(ValueError):
            command(subject, ttl_seconds=seconds)
    command(subject)
    exchange(subject, pages=[p])
    with pytest.raises(ValueError):
        exchange(subject, pages=[p], results=[{'id': 'command-1', 'state': 'completed', 'data': {'html': 'no'}}])
    p['fields'] *= 2
    with pytest.raises(ValueError, match='Duplicate'):
        exchange(subject, pages=[p])


def test_actual_extension_snapshot_and_command_result_match_server(subject):
    """Exercise the real JavaScript boundary without browser/network/application use."""
    node = shutil.which('node')
    extension = Path(__file__).resolve().parents[3] / 'extensions' / 'speedyapply-local'
    if not node or not (extension / 'node_modules' / 'jsdom').exists():
        pytest.skip('Optional cross-language test requires local extension Node dependencies')
    fixture = r'''
      import { readFileSync } from 'node:fs';
      import { JSDOM } from 'jsdom';
      import { readWithDependencies } from './tests/helpers/runtime-source.mjs';
      const command = JSON.parse(readFileSync(0, 'utf8'));
      const dom = new JSDOM(`<form aria-labelledby="job-application-form">
        <label for="answer">Why this role?</label><textarea id="answer" required></textarea>
        <button class="ashby-application-form-submit-button" type="button">Submit</button>
      </form>`, { url: 'https://jobs.ashbyhq.com/example/job/application', runScripts: 'outside-only', pretendToBeVisual: true });
      const w = dom.window, listeners = [];
      w.JobsControlConfig = { enabled: true };
      w.Date.now = () => 1800000000000;
      w.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';
      w.chrome = { runtime: { id: 'test-extension', sendMessage: async message => message.type === 'jobs:tab-profile'
        ? { data: { id: 'newgrad-profile', profile: { profileName: 'Newgrad' } } } : { ok: true },
        onMessage: { addListener: listener => listeners.push(listener) } } };
      for (const name of ['job-match-rules', 'job-match', 'control-fields', 'operation-context', 'control-content'])
        w.eval(await readWithDependencies(new URL('./src/custom/' + name + '.js', import.meta.url), 'utf8'));
      async function ashbyRunApplication(options) { await options.getProfile(); options.setMessage('autofill-complete'); }
      await w.JobsPageSession.run(ashbyRunApplication, { getProfile: async () => ({ profileName: 'Newgrad' }),
        setMessage: () => {}, autofillSettings: {} });
      const invoke = message => new Promise(resolve => {
        for (const listener of listeners) listener(message, { id: 'test-extension' }, resolve);
      });
      // Establish the exact initial revision before executing the server command.
      await invoke({ type: 'jobs:control-inspect' });
      const result = command ? await invoke({ type: 'jobs:control-execute', command }) : null;
      const snapshot = (await invoke({ type: 'jobs:control-inspect' })).data;
      process.stdout.write(JSON.stringify({ sessionId: '00000000-0000-4000-8000-000000000002',
        pages: [{ ...snapshot, tabId: 7, frameId: 0, profileId: 'newgrad-profile' }], results: result ? [result] : [] }));
      dom.window.close();
    '''

    def run(value):
        completed = subprocess.run([node, '--input-type=module', '-e', fixture], cwd=extension,
                                   input=json.dumps(value), capture_output=True, text=True, encoding='utf-8', timeout=20)
        assert completed.returncode == 0, completed.stderr
        return json.loads(completed.stdout)

    _, control, _, device, _ = subject
    payload = run(None)
    payload.update(protocolVersion=2, inventory=[{k: p[k] for k in ('tabId', 'frameId', 'documentId')} for p in payload['pages']])
    control.exchange(device, {**payload, 'pages': []})
    for document in payload['inventory']:
        control.pages(device, payload['sessionId'], document)
    assert control.exchange(device, payload)['commands'] == []
    observed = control.pages()['pages'][0]
    assert observed['fields'][0]['question'] == 'Why this role?'
    assert observed['coverage'] == 'partial' and 'fill_answers' in observed['actions']
    control.command(device, payload['sessionId'], target(observed), 'fill_answers', 'actual-js-command',
                    answers=[{'fieldId': observed['fields'][0]['id'], 'value': 'Synthetic test answer'}])
    dispatched = control.exchange(device, payload)['commands'][0]
    completed = run(dispatched)
    assert completed['results'][0]['state'] == 'completed'
    assert completed['results'][0]['data']['appliedFieldIds'] == [observed['fields'][0]['id']]
    assert completed['pages'][0]['counts']['unfilled'] == 0
    completed.update(protocolVersion=2, inventory=payload['inventory'])
    for document in payload['inventory']:
        control.pages(device, payload['sessionId'], document)
    control.exchange(device, completed)
    assert control.get_command('actual-js-command')['state'] == 'completed'
    assert control.get_command('actual-js-command')['submissionConfirmed'] is False
