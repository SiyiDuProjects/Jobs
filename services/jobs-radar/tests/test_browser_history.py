import asyncio
import uuid

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from jobs_radar.browser_control import BrowserControl
from jobs_radar.browser_history import Diagnostics, RETENTION_DAYS, MAX_RUNS, pin
from jobs_radar.server import create_server
from jobs_radar.store import Store

NOW = 1_800_000_000_000


def packet(job=1, at=NOW):
    return {'schemaVersion': 2, 'runId': 'run-1', 'build': 'test', 'url': f'https://example.wd1.myworkdayjobs.com/en-US/careers/job/role_R{job}/apply',
            'ats': 'QV', 'firstSeen': at, 'lastSeen': at, 'truncated': False,
            'snapshots': [{'at': at, 'document': 'doc-1', 'phase': 'complete-manually',
                           'step': 'myExperiencePage', 'fields': [
                               {'id': 'field-1', 'question': 'Company', 'kind': 'text',
                                'hasValue': False, 'invalid': True, 'required': True,
                                'status': 'validation_error', 'attempts': 1}]}],
            'events': [{'at': at, 'document': 'doc-1', 'type': 'phase', 'phase': 'complete-manually'}]}


@pytest.fixture
def history(tmp_path):
    store = Store(tmp_path / 'history.sqlite')
    control = BrowserControl(store, lambda: NOW + 100_000, allow_commands=False)
    device, session = str(uuid.uuid4()), str(uuid.uuid4())
    def send(items):
        return Diagnostics(store, lambda: NOW + 100_000).receive(device, {'protocolVersion': 1, 'history': items})
    return store, control, send


def test_history_survives_closed_tabs_restart_and_merges_workday_steps(history):
    store, control, send = history
    first = packet()
    send([first])
    second = packet(at=NOW + 100)
    second['url'] += '/applicationQuestions'
    second['snapshots'][0]['phase'] = 'ai-filling'
    second['events'][0]['phase'] = 'ai-filling'
    send([second]); send([second]); send([])
    restarted = BrowserControl(store, allow_commands=False)
    index = restarted.history()['applications']
    assert len(index) == 1
    detail = restarted.history(index[0]['id'])
    assert [e['phase'] for e in detail['events']] == ['complete-manually', 'ai-filling']
    assert len(detail['snapshots']) == 2
    assert detail['executable'] is False
    assert control.pages()['pages'] == []


def test_runs_retained_for_thirty_days_and_exact_reuploads_are_deduplicated(history):
    _, control, send = history
    for job in range(1, 5):
        send([packet(job, NOW + job)])
    send([packet(1, NOW + 1)])
    rows = control.history()['applications']
    assert len(rows) == 4
    assert len({r['id'] for r in rows}) == 4


@pytest.mark.parametrize('where,key,value', [
    ('field', 'value', 'x' * 121), ('field', 'options', []),
    ('field', 'trace', {'answer': 'ok', 'html': '<b>'}), ('field', 'decision', {'status': 'answered', 'detail': 'x'}),
    ('event', 'detail', 'private answer'), ('event', 'answer', 'private answer'),
])
def test_history_rejects_unbounded_values_or_freeform_details(history, where, key, value):
    _, control, send = history
    p = packet()
    target = p['snapshots'][0]['fields'][0] if where == 'field' else p['events'][0]
    target[key] = value
    with pytest.raises(ValueError):
        send([p])
    assert control.history()['applications'] == []


def test_history_bounds_accumulation_and_marks_truncation(history):
    _, control, send = history
    for offset in range(65):
        send([packet(at=NOW + offset)])
    index = control.history()['applications'][0]
    assert index['snapshots'] == 60 and index['truncated']
    bad = packet(); bad['events'] *= 1501
    with pytest.raises(ValueError):
        send([bad])


def test_history_read_tool_is_read_only_and_requires_owner_scope(tmp_path, monkeypatch):
    monkeypatch.setenv('JOBS_BROWSER_OBSERVE_ENABLED', '1')
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '0')
    server = create_server(Store(tmp_path / 'mcp.sqlite'), 'https://radar.test')
    tool = next(t for t in asyncio.run(server.list_tools()) if t.name == 'get_browser_history')
    assert tool.annotations.read_only_hint is True
    with pytest.raises(ToolError):
        asyncio.run(server.call_tool('get_browser_history', {}))


def test_history_keeps_each_fields_value_decision_and_last_choice(history):
    _, control, send = history
    p = packet()
    p['snapshots'][0]['fields'][0].update(
        hasValue=True, value="Bachelor's Degree",
        decision={'status': 'answered', 'source': 'profile', 'reason': 'profile', 'field': 'educationData.degree'},
        trace={'source': 'adapter', 'topic': 'degree', 'answer': 'Bachelor of Arts', 'result': 'committed',
               'chosen': "Bachelor's Degree", 'method': 'exact', 'optionCount': 8, 'options': ['High School', "Bachelor's Degree"]})
    send([p])
    index = control.history()['applications']
    field = control.history(index[0]['id'])['snapshots'][0]['fields'][0]
    assert field['value'].startswith('Synthetic value ') and field['decision']['field'] == 'educationData.degree'
    assert field['trace']['chosen'] == field['value']
    assert field['trace']['options'][1] == field['value']
    assert field['trace']['options'][0] != field['value']


def test_history_keeps_unrecognized_questions_with_structure_only(history):
    _, control, send = history
    p = packet()
    p['snapshots'][0]['unrecognized'] = [{'question': 'Preferred shift', 'reason': 'required-title-without-field',
                                          'structure': 'div.question\n  label\n  div.shift-picker[tabindex=0]'}]
    send([p])
    index = control.history()['applications']
    snapshot = control.history(index[0]['id'])['snapshots'][0]
    assert snapshot['unrecognized'] == p['snapshots'][0]['unrecognized']
    extra = packet(job=2)
    extra['snapshots'][0]['unrecognized'] = [{'question': 'Q', 'reason': 'x', 'structure': 'div', 'value': 'secret'}]
    with pytest.raises(ValueError):
        send([extra])
