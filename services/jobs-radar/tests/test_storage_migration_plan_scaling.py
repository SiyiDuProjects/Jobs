"""Bounded planning and durable recovery, using only synthetic source records."""
import asyncio
from contextlib import contextmanager
import json
import time
import uuid

import pytest

from jobs_radar import storage_migration_plan as planning
from jobs_radar.application_records import upsert
from jobs_radar.job_match import job_key
from jobs_radar.management import Management
from jobs_radar.profiles import Profiles
from jobs_radar.request_budget import DEADLINE
from jobs_radar.storage_migration_contract import MigrationError, checkpoint
from jobs_radar.storage_migrations import StorageMigrations
from jobs_radar.store import Store
from test_storage_migrations import DEVICE, application, source, uploaded


@pytest.fixture
def migration_service(tmp_path):
    store = Store(tmp_path / 'state.sqlite')
    service = StorageMigrations(store, Profiles(store), Management(store),
                                limits={'minimumFreeBytes': 0})
    # A real, unrelated domain record makes accidental application writes visible.
    with store.connect(True) as connection:
        upsert(connection, {**application(), 'id': 'synthetic-existing-record',
                            'jobLink': 'https://boards.greenhouse.io/synthetic/jobs/9999999'})
    return service


def application_source(count):
    rows = [{**application(), 'jobTitle': 'Synthetic role ' + str(index) + ' details' * 70,
             'jobLink': 'https://boards.greenhouse.io/synthetic/jobs/' + str(2000000 + index)}
            for index in range(count)]
    return source('appliedList', rows)


def domain_rows(service):
    """Include every nonmigration table, so planning cannot quietly add a write."""
    with service.store.connect() as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'installed_migration%' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {table: sorted((tuple(row) for row in connection.execute('SELECT * FROM "' + table + '"')),
                              key=repr) for table in tables}


def operation_rows(service, mid):
    with service.store.connect() as connection:
        return {row['id']: row['metadata'] for row in connection.execute(
            'SELECT id,metadata FROM installed_migration_operations WHERE migration_id=? ORDER BY rowid', (mid,))}


def plan_with_request_budget(service, mid):
    async def run():
        async with service.admission():
            return service.plan(DEVICE, mid)
    return asyncio.run(run())


def interrupt_after_prefix(service, mid, monkeypatch, completed=5):
    prepare = planning._prepare
    count = 0

    def limited_prepare(*args, **kwargs):
        nonlocal count
        if count == completed:
            token = DEADLINE.set(time.monotonic() - 1)
            try:
                checkpoint()
            finally:
                DEADLINE.reset(token)
        count += 1
        return prepare(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(planning, '_prepare', limited_prepare)
        with pytest.raises(MigrationError) as stopped:
            plan_with_request_budget(service, mid)
    assert (stopped.value.code, stopped.value.status) == ('migration_limit', 503)
    rows = operation_rows(service, mid)
    assert len(rows) == completed
    assert service.status(DEVICE, mid)['phase'] == 'backed_up'
    assert 'planRevision' not in service.status(DEVICE, mid)
    return rows


def test_large_application_plan_respects_deadline_and_linear_source_read_budget(
        migration_service, monkeypatch, record_property):
    service = migration_service
    item = application_source(600)
    second = source('jobsManagementBeforeMigrationV1', {'appliedList': json.loads(item[1])})
    input_bytes = item[0]['size'] + second[0]['size']
    assert item[0]['size'] > 400_000
    with service.store.connect(True) as connection:
        connection.executemany('INSERT INTO jobs(id,identity,first_seen,last_seen,job_key) VALUES(?,?,?,?,?)',
                               [('synthetic-catalog-' + str(index), 'synthetic-identity-' + str(index), 0, 0,
                                 job_key('https://boards.greenhouse.io/synthetic/jobs/' + str(2000000 + index)))
                                for index in range(15_000)])
        for index, row in enumerate(json.loads(item[1])[:203]):
            upsert(connection, {**row, 'id': 'synthetic-matched-record-' + str(index)})
        connection.executemany('INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,?,?,?,?)',
                               [('synthetic-catalog-' + str(index % 15_000), 'synthetic_history',
                                 'synthetic-owner', 0, '{}') for index in range(5_418)] +
                               [('synthetic-catalog-' + str(index), 'owner_submission_undo',
                                 'synthetic-owner', 0, '{}') for index in (14_998, 14_999)])
    mid, _ = uploaded(service, [item, second])
    before = domain_rows(service)
    original_read = service.read_entry
    original_prepare = planning._prepare
    original_save = planning._save
    original_connect = service.store.connect
    charged_bytes = 0
    read_calls = 0
    costs = {name: [0, 0.0] for name in ('entry_read', 'prepare', 'save', 'read_connection', 'write_connection')}

    def measured(name, action, *args, **kwargs):
        started = time.monotonic()
        try:
            return action(*args, **kwargs)
        finally:
            costs[name][0] += 1
            costs[name][1] += time.monotonic() - started

    @contextmanager
    def measured_connection(write=False):
        started = time.monotonic()
        try:
            with original_connect(write) as connection:
                yield connection
        finally:
            name = 'write_connection' if write else 'read_connection'
            costs[name][0] += 1
            costs[name][1] += time.monotonic() - started

    def metered_read(migration_id, metadata):
        nonlocal charged_bytes, read_calls
        charged_bytes += metadata['size']
        read_calls += 1
        # Permit several validation passes, but never one whole-file parse per row.
        assert charged_bytes <= input_bytes * 4, 'planning repeatedly parsed the complete source list'
        return measured('entry_read', original_read, migration_id, metadata)

    monkeypatch.setattr(service, 'read_entry', metered_read)
    monkeypatch.setattr(service.store, 'connect', measured_connection)
    monkeypatch.setattr(planning, '_prepare', lambda *args, **kwargs: measured('prepare', original_prepare, *args, **kwargs))
    monkeypatch.setattr(planning, '_save', lambda *args, **kwargs: measured('save', original_save, *args, **kwargs))
    started = time.monotonic()
    try:
        result = plan_with_request_budget(service, mid)
    finally:
        elapsed = time.monotonic() - started
        record_property('plan_seconds', round(elapsed, 4))
        record_property('source_bytes_read', charged_bytes)
        record_property('source_read_calls', read_calls)
        record_property('source_entries', 2)
        record_property('application_rows_per_source', 600)
        record_property('catalog_jobs', 15_000)
        record_property('audit_rows', 5_420)
        record_property('owner_undo_rows', 2)
        record_property('existing_application_records', 203)
        for name, (calls, seconds) in costs.items():
            record_property(name + '_calls', calls)
            record_property(name + '_seconds', round(seconds, 4))
    assert elapsed < service.limits['requestTimeoutMs'] / 1000
    assert result['revision'] == 1 and result['phase'] == 'required_input'
    assert len(result['conflicts']) == 794 and len(result['operations']) == 1202
    assert sum(row['kind'] == 'preserve' for row in result['operations']) == 408
    assert len({row['id'] for row in result['operations']}) == 1202
    assert domain_rows(service) == before


def test_interrupted_plan_resumes_only_missing_operations_after_service_restart(migration_service, monkeypatch):
    service = migration_service
    mid, _ = uploaded(service, [application_source(12)])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch)
    restarted = StorageMigrations(service.store, service.profiles, service.management,
                                  vault=service.vault, limits={'minimumFreeBytes': 0})
    prepared = []
    original_prepare = planning._prepare

    def tracked_prepare(service, mid, operation, *args, **kwargs):
        prepared.append(operation['id'])
        return original_prepare(service, mid, operation, *args, **kwargs)

    monkeypatch.setattr(planning, '_prepare', tracked_prepare)
    result = plan_with_request_budget(restarted, mid)
    current = operation_rows(restarted, mid)
    assert len(result['operations']) == len(current) == 13
    assert len(prepared) == 8 and set(prepared).isdisjoint(prefix)
    assert all(current[key] == value for key, value in prefix.items())
    assert result['revision'] == 1 and len(result['conflicts']) == 12
    assert domain_rows(restarted) == before


def test_existing_user_preservation_is_not_replaced_when_partial_plan_resumes(migration_service, monkeypatch):
    service = migration_service
    mid, _ = uploaded(service, [application_source(8)])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch, completed=3)
    op_id = next(iter(prefix))
    operation = json.loads(prefix[op_id])
    # A retained historical decision must survive even if publication was interrupted.
    operation.update(kind='preserve', reason='explicit_preservation', state='ready')
    operation.pop('conflict', None)
    chosen = json.dumps(operation, separators=(',', ':'), sort_keys=True)
    with service.store.connect(True) as connection:
        connection.execute('UPDATE installed_migration_operations SET metadata=? WHERE migration_id=? AND id=?',
                           (chosen, mid, op_id))
    result = plan_with_request_budget(service, mid)
    assert operation_rows(service, mid)[op_id] == chosen
    assert next(row for row in result['operations'] if row['id'] == op_id)['kind'] == 'preserve'
    assert op_id not in {conflict['id'] for conflict in result['conflicts']}
    # A subsequent real owner decision uses the normal revision contract and stays intact too.
    conflict = result['conflicts'][0]
    decided = service.resolve(DEVICE, mid, result['revision'], conflict['id'], 'preserve')
    saved = operation_rows(service, mid)
    again = plan_with_request_budget(service, mid)
    assert again['revision'] == decided['revision']
    assert operation_rows(service, mid) == saved
    assert domain_rows(service) == before


def test_legacy_partial_operations_without_preparation_pins_resume_and_keep_preservation(migration_service, monkeypatch):
    service = migration_service
    item = application_source(8)
    with service.store.connect(True) as connection:
        upsert(connection, {**json.loads(item[1])[0], 'id': 'synthetic-legacy-exact-record'})
    mid, _ = uploaded(service, [item])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch, completed=3)
    existing_id, retained_id = list(prefix)[:2]
    existing = json.loads(prefix[existing_id])
    assert existing['kind'] == 'preserve' and existing['reason'] == 'existing_application_evidence'
    legacy = {}
    for op_id, metadata in prefix.items():
        operation = json.loads(metadata)
        operation.pop('preparationSourceHash', None)
        if op_id == retained_id:
            operation.update(kind='preserve', reason='explicit_preservation', state='ready')
            operation.pop('conflict', None)
        legacy[op_id] = operation
    with service.store.connect(True) as connection:
        connection.executemany('UPDATE installed_migration_operations SET metadata=? WHERE migration_id=? AND id=?',
                               [(json.dumps(operation), mid, op_id) for op_id, operation in legacy.items()])
    result = plan_with_request_budget(service, mid)
    current = operation_rows(service, mid)
    assert len(current) == len(result['operations']) == 9
    assert set(legacy) <= set(current)
    assert json.loads(current[retained_id]) == legacy[retained_id]
    assert json.loads(current[existing_id])['reason'] == 'existing_application_evidence'
    assert retained_id not in {conflict['id'] for conflict in result['conflicts']}
    for op_id in set(legacy) - {retained_id}:
        operation = json.loads(current[op_id])
        assert operation['sources'] == legacy[op_id]['sources']
        assert operation['kind'] == legacy[op_id]['kind']
        assert operation['state'] == legacy[op_id]['state']
        if 'conflict' in legacy[op_id]:
            assert operation['conflict']['choices'] == legacy[op_id]['conflict']['choices']
    assert domain_rows(service) == before


@pytest.mark.parametrize('damage', ['source_hash', 'unexpected_operation'])
def test_partial_operation_identity_mismatch_stops_without_replacing_journal(migration_service, monkeypatch, damage):
    service = migration_service
    mid, _ = uploaded(service, [application_source(8)])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch, completed=3)
    op_id = next(iter(prefix))
    damaged = json.loads(prefix[op_id])
    if damage == 'source_hash':
        damaged['sources'][0]['sha256'] = '0' * 64
    else:
        damaged['id'] = str(uuid.uuid4())
    with service.store.connect(True) as connection:
        if damage == 'unexpected_operation':
            connection.execute('INSERT INTO installed_migration_operations VALUES(?,?,?)',
                               (mid, damaged['id'], json.dumps(damaged)))
        else:
            connection.execute('UPDATE installed_migration_operations SET metadata=? WHERE migration_id=? AND id=?',
                               (json.dumps(damaged), mid, op_id))
    saved = operation_rows(service, mid)
    with pytest.raises(MigrationError) as rejected:
        plan_with_request_budget(service, mid)
    assert rejected.value.code in {'migration_invalid_source', 'migration_source_changed', 'migration_plan_stale'}
    assert operation_rows(service, mid) == saved
    assert domain_rows(service) == before


def test_request_cache_does_not_hide_changed_source_after_interruption(migration_service, monkeypatch):
    service = migration_service
    item = application_source(8)
    mid, _ = uploaded(service, [item])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch, completed=3)
    path = service._path(mid, item[0]['entryId'] + '.json')
    path.write_bytes(path.read_bytes() + b' ')
    with pytest.raises(MigrationError) as rejected:
        plan_with_request_budget(service, mid)
    assert rejected.value.code == 'migration_source_changed'
    assert operation_rows(service, mid) == prefix
    assert domain_rows(service) == before


@pytest.mark.parametrize('legacy_without_pin', [False, True])
def test_partial_missing_profile_answer_owner_conflict_is_resumable(
        migration_service, monkeypatch, legacy_without_pin):
    service = migration_service
    item = source('jobsResponses:' + str(uuid.uuid4()), [])
    mid, _ = uploaded(service, [item])
    before = domain_rows(service)
    prefix = interrupt_after_prefix(service, mid, monkeypatch, completed=1)
    op_id = next(iter(prefix))
    operation = json.loads(prefix[op_id])
    assert operation['kind'] == 'answers' and operation.get('target') is None
    assert operation['conflict']['kind'] == 'answer_owner'
    if legacy_without_pin:
        operation.pop('preparationSourceHash', None)
        with service.store.connect(True) as connection:
            connection.execute('UPDATE installed_migration_operations SET metadata=? WHERE migration_id=? AND id=?',
                               (json.dumps(operation), mid, op_id))
    result = plan_with_request_budget(service, mid)
    current = json.loads(operation_rows(service, mid)[op_id])
    assert len(result['operations']) == 2 and result['revision'] == 1
    assert current['sources'] == operation['sources'] and current.get('target') is None
    assert current['conflict']['kind'] == 'answer_owner'
    assert current['conflict']['choices'] == operation['conflict']['choices']
    assert domain_rows(service) == before
