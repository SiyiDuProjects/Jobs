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


def test_history_unique_run_id_returns_the_same_redacted_archive(history):
    _, control, send = history
    data = {**packet(), 'runId': str(uuid.uuid4())}
    data['snapshots'][0]['fields'][0]['value'] = 'Synthetic fixture answer'
    send([data])
    archive = control.history()['applications'][0]
    detail = control.history(archive['id'])
    assert control.history(data['runId']) == detail
    assert detail['id'] == archive['id']
    assert detail['snapshots'][0]['fields'][0]['value'].startswith('Synthetic value ')
    assert detail['valuePolicy'] == 'synthetic_values_only' and detail['executable'] is False


def test_history_archive_id_takes_priority_over_another_rows_run_id(history):
    _, control, send = history
    send([packet()])
    archive_id = control.history()['applications'][0]['id']
    send([{**packet(job=2), 'runId': archive_id}])
    detail = control.history(archive_id)
    assert detail['id'] == archive_id and detail['runId'] == 'run-1'
    assert detail['url'] == packet()['url']


@pytest.mark.parametrize('second_device,second_job', [('device-a', 2), ('device-b', 1)])
def test_history_ambiguous_run_id_requires_an_archive_id(tmp_path, second_device, second_job):
    diagnostics = Diagnostics(Store(tmp_path / 'ambiguous.sqlite'), lambda: NOW)
    diagnostics.receive('device-a', {'protocolVersion': 1, 'history': [packet()]})
    diagnostics.receive(second_device, {'protocolVersion': 1, 'history': [packet(second_job)]})
    index = diagnostics.history()['applications']
    assert len(index) == 2
    with pytest.raises(ValueError, match=r'ambiguous.*applications\[\]\.id'):
        diagnostics.history('run-1')
    for row in index:
        assert diagnostics.history(row['id'])['id'] == row['id']


def test_history_run_id_lookup_keeps_unknown_expiry_and_pin_semantics(tmp_path):
    clock = [NOW]
    diagnostics = Diagnostics(Store(tmp_path / 'retention.sqlite'), lambda: clock[0])
    unknown = 'Diagnostic run is unknown or its retention period ended'
    with pytest.raises(ValueError, match=unknown):
        diagnostics.history('absent')
    diagnostics.receive('device', {'protocolVersion': 1, 'history': [packet()]})
    archive_id = diagnostics.history()['applications'][0]['id']
    diagnostics.retain(archive_id, 'notes/cases/synthetic-retained.md')
    clock[0] += (RETENTION_DAYS + 1) * 86400000
    assert diagnostics.history('run-1')['id'] == archive_id
    diagnostics.retain(archive_id)
    for identity in (archive_id, 'run-1'):
        with pytest.raises(ValueError, match=unknown):
            diagnostics.history(identity)
    assert diagnostics.history()['applications'] == []


def test_history_tool_documents_archive_id_and_unique_run_id(tmp_path):
    server = create_server(Store(tmp_path / 'tool-lookup.sqlite'), 'https://radar.test')
    tool = next(t for t in asyncio.run(server.list_tools()) if t.name == 'get_browser_history')
    assert 'applications[].id' in tool.description and 'unique runId' in tool.description


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


def test_history_metrics_survive_storage_restart_and_empty_capability_probe(history):
    store, control, send = history
    assert send([]) == {'historyAccepted': True, 'historyEventMetrics': 1}
    assert control.history()['applications'] == []
    p = packet()
    p['events'] = [
        {'at': NOW, 'document': 'doc-1', 'type': 'visibility_changed', 'visibility': 'hidden'},
        {'at': NOW + 1, 'document': 'doc-1', 'type': 'auto_write_timing', 'fieldId': 'field-1',
         'timing': {'ms': 1_234_567, 'heldMs': 20, 'scans': 2}},
        {'at': NOW + 2, 'document': 'doc-1', 'type': 'auto_run_timing',
         'timing': {'ms': 1_234_600, 'scans': 8, 'structuralScans': 3,
                    'writes': {'writes': 1, 'ms': 1_234_567, 'heldMs': 20, 'scans': 2},
                    'profileChecks': {'count': 2, 'fresh': 1, 'ms': 32, 'reused': 1}}},
    ]
    send([p])
    send([p])
    restarted = Diagnostics(store, lambda: NOW + 100_000)
    index = restarted.history()['applications']
    assert restarted.history(index[0]['id'])['events'] == p['events']


@pytest.mark.parametrize('event', [
    {'type': 'visibility_changed', 'visibility': 'private text'},
    {'type': 'phase', 'visibility': 'visible'},
    {'type': 'phase', 'timing': {'ms': 2}},
    {'type': 'auto_write_timing', 'timing': {'answer': 'private text'}},
    {'type': 'auto_write_timing', 'timing': {'ms': '123'}},
    {'type': 'auto_write_timing', 'timing': {'ms': True}},
    {'type': 'auto_write_timing', 'timing': {'ms': -1}},
    {'type': 'auto_write_timing', 'timing': {'ms': 86_400_001}},
    {'type': 'auto_write_timing', 'timing': {'scans': 1_000_001}},
    {'type': 'auto_write_timing', 'timing': {'ms': 1.5}},
    {'type': 'auto_write_timing', 'timing': []},
    {'type': 'auto_write_timing', 'timing': {}},
    {'type': 'auto_run_timing', 'timing': {'profileChecks': {'url': 'https://private.invalid'}}},
    {'type': 'auto_run_timing', 'timing': {'writes': {'count': 1}}},
    {'type': 'auto_run_timing', 'timing': {'writes': {}}},
])
def test_history_rejects_wrong_or_unbounded_metric_shapes(history, event):
    _, control, send = history
    p = packet()
    p['events'] = [{'at': NOW, 'document': 'doc-1', **event}]
    with pytest.raises(ValueError):
        send([p])
    assert control.history()['applications'] == []


def test_history_rich_reupload_replaces_legacy_shell_without_merging_distinct_metrics(history):
    _, control, send = history
    p = packet()
    shell = {'at': NOW, 'document': 'doc-1', 'type': 'auto_write_timing', 'fieldId': 'field-1'}
    p['events'] = [shell]
    send([p])
    enriched = [{**shell, 'timing': {'ms': 0}}, {**shell, 'timing': {'ms': 1}}]
    send([{**p, 'events': enriched}])
    send([p])
    row = control.history()['applications'][0]
    assert control.history(row['id'])['events'] == enriched

    # A first upload can already contain both shapes after an extension update.
    first = {**packet(job=2), 'events': [shell, *enriched, enriched[0]]}
    send([first])
    row = next(row for row in control.history()['applications'] if row['url'] == first['url'])
    assert control.history(row['id'])['events'] == enriched
