"""Synthetic explicit migration lifecycle, recovery and privacy regressions."""
import asyncio
import copy
import json
import os
import stat
import sqlite3
import time
import uuid

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from jobs_radar.client_protocol import CURRENT_HEADERS
from jobs_radar.http_routes import RouteAPI
from jobs_radar.management import Management
from jobs_radar.profiles import ProfileConflict, Profiles
from jobs_radar.storage_migration_contract import CONTRACT, MigrationError, canonical, sha, strict_json
from jobs_radar.storage_migration_routes import register_storage_migration_routes
from jobs_radar.storage_migrations import StorageMigrations
from jobs_radar.store import Store
from test_profile_contract import fixture
from test_profile_rest import Server


DEVICE = 'synthetic-device'


@pytest.fixture
def service(tmp_path):
    store = Store(tmp_path / 'state.sqlite')
    return StorageMigrations(store, Profiles(store), Management(store), limits={'minimumFreeBytes': 0})


def source(key, value, *, area='local', pointer=None, container=None):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    kind = {'profile': 'profile', 'jobsProfilesCache': 'profile', 'jobsProfileBeforeMigration': 'profile_backup',
            'jobsProfilePending': 'profile_pending', 'responseList': 'answers', 'jobsResponsesLegacyBackup': 'answers_backup',
            'jobsManagementBaseV1': 'merge_baseline', 'jobsManagementBeforeMigrationV1': 'management_backup',
            'jobsTabProfileRecoveryV1': 'legacy_recovery', 'appliedList': 'legacy_applications'}.get(key, 'answers' if key.startswith('jobsResponses:') else 'identity')
    entry = dict(entryId=str(uuid.uuid4()), selector=('session:' if area == 'session' else '') + key + ('#' + pointer if pointer else ''),
                 storageArea=area, storageKey=key, disposition='retain_identity' if kind == 'identity' else 'remove_key', kind=kind,
                 size=len(text.encode()), sha256=sha(text.encode()))
    if pointer: entry.update(pointer=pointer, disposition='remove_path', kind='response_context', containerSha256=container)
    return entry, text


def begin(service, values=(), *, device=DEVICE, mid=None):
    values = sorted(values, key=lambda v: v[0]['selector'])
    value = dict(version=CONTRACT['version'], migrationId=mid or str(uuid.uuid4()), clientBuild='synthetic-build',
                 inventoryVersion=CONTRACT['version'], entries=[v[0] for v in values])
    text = json.dumps(value, separators=(',', ':')); digest = sha(text.encode())
    result = service.create(device, text, digest)
    return result['migrationId'], digest, text


def uploaded(service, values=(), **kwargs):
    mid, digest, text = begin(service, values, **kwargs)
    for entry, raw in values:
        service.upload(kwargs.get('device', DEVICE), mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    service.seal(kwargs.get('device', DEVICE), mid, digest)
    return mid, digest


def preserve(service, mid):
    plan = service.plan(DEVICE, mid)
    while plan['conflicts']:
        conflict = plan['conflicts'][0]
        plan = service.resolve(DEVICE, mid, plan['revision'], conflict['id'], 'preserve')
    return plan


def decide(service, mid, kind, choice):
    plan = service.plan(DEVICE, mid)
    conflict = next(c for c in plan['conflicts'] if c['kind'] == kind)
    return resolve_reviewed(service, mid, plan, conflict, choice)


def resolve_reviewed(service, mid, plan, conflict, choice):
    preview_id = None
    if choice != 'preserve':
        cursor = None
        while True:
            preview = service.preview(DEVICE, mid, conflict['id'], choice, cursor)
            assert not preview.get('blocked')
            if preview['complete']:
                preview_id = preview['previewId']; break
            cursor = preview['nextCursor']
    return service.resolve(DEVICE, mid, plan['revision'], conflict['id'], choice, preview_id)


def test_exact_bytes_restore_device_boundary_permits_and_idempotent_ack(service):
    value = source('profile', fixture()); entry, raw = value
    mid, digest, manifest = begin(service, [value])
    assert service.create(DEVICE, manifest, digest)['migrationId'] == mid
    with pytest.raises(MigrationError): service.status('other-device', mid)
    with pytest.raises(MigrationError): service.claim(DEVICE, mid, entry['entryId'], digest, entry['sha256'], 'synthetic-build')
    service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    sealed = service.seal(DEVICE, mid, digest)
    assert sealed['backup']['restoreVerified'] is True
    assert service._path(mid, entry['entryId'] + '.backup').read_bytes() == raw.encode()
    assert 'profileName' not in json.dumps(sealed)
    plan = preserve(service, mid)
    service.apply(DEVICE, mid, plan['revision'], digest)
    permit = service.claim(DEVICE, mid, entry['entryId'], digest, entry['sha256'], 'synthetic-build')
    with service.store.connect(True) as c:
        c.execute('UPDATE installed_migration_permits SET expires=0')
    first = service.ack(DEVICE, mid, entry['entryId'], permit['permitId'], digest, 'absent')
    assert service.ack(DEVICE, mid, entry['entryId'], permit['permitId'], digest, 'absent') == first
    assert service.complete(DEVICE, mid, digest, 0)['phase'] == 'complete'
    if os.name == 'posix':
        assert stat.S_IMODE(service.vault.stat().st_mode) == 0o700
        assert stat.S_IMODE(service._path(mid, entry['entryId'] + '.backup').stat().st_mode) == 0o600


@pytest.mark.parametrize('raw', ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":1e999}', '"\\ud800"', '[' * 65 + '0' + ']' * 65])
def test_strict_json_rejects_ambiguous_or_excessive_inputs(raw):
    with pytest.raises(MigrationError): strict_json(raw)


def test_node_budget_is_enforced_before_decoder(monkeypatch):
    monkeypatch.setattr(json, 'loads', lambda *a, **kw: pytest.fail('decoded over-budget input'))
    with pytest.raises(MigrationError): strict_json('[0,0,0]', max_nodes=3)


@pytest.mark.parametrize('value', [
    {'profile': {**fixture(), 'applicationData': {'password': 'SYNTHETIC-SECRET'}}},
    {'unexpected': 'SYNTHETIC-UNKNOWN'},
])
def test_invalid_or_credential_source_is_never_persisted(service, value):
    item = source('jobsProfileBeforeMigration', value); entry, raw = item
    mid, _, _ = begin(service, [item])
    with pytest.raises(MigrationError): service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    assert not service._path(mid, entry['entryId'] + '.json').exists()


def test_changed_bytes_and_foreign_entry_cannot_replace_backup(service):
    item = source('profile', fixture()); entry, raw = item
    mid, digest = uploaded(service, [item])
    changed = raw + ' '
    with pytest.raises(MigrationError): service.upload(DEVICE, mid, entry['entryId'], changed, len(changed.encode()), sha(changed.encode()))
    with pytest.raises(MigrationError): service.upload(DEVICE, mid, str(uuid.uuid4()), raw, entry['size'], entry['sha256'])
    assert service._path(mid, entry['entryId'] + '.backup').read_bytes() == raw.encode()


def test_session_budgets_include_nodes_retained_and_incomplete_bytes(service):
    service.limits['maxTotalJsonNodes'] = 2
    item = source('profile', fixture()); entry, raw = item
    mid, digest, _ = begin(service, [item])
    with pytest.raises(MigrationError, match='migration_limit'): service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    with pytest.raises(MigrationError, match='migration_required_input'): begin(service)
    service.supersede(DEVICE, mid, digest, str(uuid.uuid4()))
    service.limits['maxRetainedSessionsPerDevice'] = 1
    with pytest.raises(MigrationError, match='migration_limit'): begin(service)


def test_backup_corruption_and_restore_failure_never_issue_cleanup(service, monkeypatch):
    item = source('profile', fixture()); mid, digest = uploaded(service, [item])
    plan = preserve(service, mid); service.apply(DEVICE, mid, plan['revision'], digest)
    service._path(mid, item[0]['entryId'] + '.backup').write_bytes(b'{}')
    with pytest.raises(MigrationError, match='migration_restore_unverified'):
        service.claim(DEVICE, mid, item[0]['entryId'], digest, item[0]['sha256'], 'synthetic-build')


def test_profile_identity_uses_id_not_name_and_stale_choice_is_rejected(service):
    saved = service.profiles.save(fixture()); pid = saved['id']
    different = {**fixture(), 'applicationData': {'sponsorshipNow': False}}
    item = source('jobsProfilePending', {'path': '/api/ext/sync/profile', 'body': {'id': pid, 'profile': different, 'expected_sync': saved['last_sync']}})
    mid, digest = uploaded(service, [item]); plan = service.plan(DEVICE, mid)
    assert plan['conflicts'][0]['kind'] == 'profile_version'
    with pytest.raises(MigrationError, match='migration_plan_stale'):
        service.resolve(DEVICE, mid, 999, plan['conflicts'][0]['id'], 'source:0')
    resolved = decide(service, mid, 'profile_version', 'source:0')
    service.profiles.save({**fixture(), 'profileName': 'Concurrent'}, profile_id=pid, expected_sync=saved['last_sync'])
    assert service.apply(DEVICE, mid, resolved['revision'], digest)['phase'] == 'required_input'
    assert service.profiles.get(pid)['profile']['profileName'] == 'Concurrent'


def test_lost_reply_after_profile_save_does_not_create_duplicate(service, monkeypatch):
    item = source('profile', fixture()); mid, digest = uploaded(service, [item])
    plan = decide(service, mid, 'profile_identity', 'new')
    plan = decide(service, mid, 'profile_version', 'source:0')
    original = service.profiles.save
    def lost(*a, **kw):
        original(*a, **kw)
        raise OSError('synthetic lost reply')
    monkeypatch.setattr(service.profiles, 'save', lost)
    with pytest.raises(OSError): service.apply(DEVICE, mid, plan['revision'], digest)
    monkeypatch.setattr(service.profiles, 'save', original)
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    assert len(service.profiles.list()) == 1


def test_session_expiry_only_after_durable_reconciliation_and_no_local_alias(service):
    pid = service.profiles.save(fixture())['id']
    response = [{'key': 'q', 'question': 'Q?', 'keywords': ['q'], 'appearances': 1, 'response': 'Synthetic response'}]
    items = [source('jobsResponses:' + pid, response, area='session'),
             source('jobsManagementBaseV1', {'jobsResponses:' + pid: {'value': [], 'revision': 0}}, area='session')]
    mid, digest = uploaded(service, items)
    plan = preserve(service, mid); service.apply(DEVICE, mid, plan['revision'], digest)
    for entry, _ in items:
        permit = service.claim(DEVICE, mid, entry['entryId'], digest, entry['sha256'], 'synthetic-build', observed='session_absent')
        assert permit['observedState'] == 'session_absent'
        with pytest.raises(MigrationError): service.ack(DEVICE, mid, entry['entryId'], permit['permitId'], digest, 'absent')
        service.ack(DEVICE, mid, entry['entryId'], permit['permitId'], digest, 'session_expired')
    assert service.complete(DEVICE, mid, digest, 0)['phase'] == 'complete'


def test_session_base_rejects_unrelated_document_before_persist(service):
    item = source('jobsManagementBaseV1', {'settings': {'value': {}, 'revision': 0}}, area='session')
    mid, _, _ = begin(service, [item]); entry, raw = item
    with pytest.raises(MigrationError): service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    assert not service._path(mid, entry['entryId'] + '.json').exists()


def test_nested_container_cleanup_requires_serial_hash_chain(service):
    old = sha(b'synthetic original container'); after = sha(b'synthetic after first')
    items = [source('configList', 'A', pointer='/0/premiumSettings/responseContext', container=old),
             source('configList', 'B', pointer='/1/premiumSettings/responseContext', container=old)]
    mid, digest = uploaded(service, items); plan = preserve(service, mid); service.apply(DEVICE, mid, plan['revision'], digest)
    first, second = (item[0] for item in items)
    permit = service.claim(DEVICE, mid, first['entryId'], digest, first['sha256'], 'synthetic-build', old)
    assert permit['containerBeforeSha256'] == old
    with pytest.raises(MigrationError, match='migration_writer_active'):
        service.claim(DEVICE, mid, second['entryId'], digest, second['sha256'], 'synthetic-build', old)
    service.ack(DEVICE, mid, first['entryId'], permit['permitId'], digest, 'path_absent', after)
    with pytest.raises(MigrationError, match='migration_source_changed'):
        service.claim(DEVICE, mid, second['entryId'], digest, second['sha256'], 'synthetic-build', old)
    assert service.claim(DEVICE, mid, second['entryId'], digest, second['sha256'], 'synthetic-build', after)['containerBeforeSha256'] == after


def test_server_settings_and_config_contexts_are_backed_up_and_migrated(service):
    pid = service.profiles.save(fixture())['id']
    settings = {'theme': 'dark', 'premiumSettings': {'responseContext': 'Synthetic A', 'keep': True}}
    config = [{'configName': 'Example', 'premiumSettings': {'responseContext': 'Synthetic B', 'keep': 7}}]
    # Historical documents predate the new normal-write boundary.
    with service.store.connect(True) as c:
        c.executemany('INSERT INTO management_documents VALUES(?,?,1)', [('settings', json.dumps(settings)), ('configList', json.dumps(config))])
    with service.store.connect() as c:
        raw = {r['key']: r['value'].encode() for r in c.execute("SELECT * FROM management_documents WHERE key IN ('settings','configList')")}
    mid, digest = uploaded(service)
    status = service.status(DEVICE, mid)
    assert {e['key'] for e in status['backup']['serverEntries']} == {'settings', 'configList'}
    for e in status['backup']['serverEntries']: assert e['sha256'] == sha(raw[e['key']])
    plan = service.plan(DEVICE, mid)
    while plan['conflicts']:
        c = plan['conflicts'][0]
        plan = resolve_reviewed(service, mid, plan, c, 'profile:' + pid)
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    assert service.profiles.get(pid)['profile']['applicationData']['aiNotes'] == 'Synthetic A\n\nSynthetic B'
    docs = service.management.snapshot()
    assert docs['settings']['value'] == {'theme': 'dark', 'premiumSettings': {'keep': True}}
    assert docs['configList']['value'] == [{'configName': 'Example', 'premiumSettings': {'keep': 7}}]


def test_rest_auth_protocol_strict_outer_json_and_no_value_status(service):
    server = Server()
    register_storage_migration_routes(RouteAPI(server), service, lambda r: DEVICE if r.headers.get('authorization') == 'fixture' else None)
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        assert client.post('/api/extension/storage-migrations', json={}).status_code == 401
        client.headers['authorization'] = 'fixture'
        duplicate = '{"protocolVersion":2,"protocolVersion":2}'
        result = client.post('/api/extension/storage-migrations', content=duplicate, headers={'content-type': 'application/json'})
        assert result.status_code == 400 and result.json()['code'] == 'migration_invalid_source'
        item = source('profile', fixture()); mid, digest, text = begin(service, [item])
        result = client.get('/api/extension/storage-migrations/' + mid)
        assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
        assert 'profileName' not in result.text


def test_admission_limits_before_body_and_releases_after_exception(service):
    async def run():
        async with service.admission():
            with pytest.raises(MigrationError, match='migration_limit'):
                async with service.admission(): pass
        with pytest.raises(RuntimeError):
            async with service.admission(): raise RuntimeError('synthetic failure')
        async with service.admission(): pass
    asyncio.run(run())


def answer(question, response):
    return dict(key=question, question=question, keywords=[question], appearances=1, response=response)


def test_pending_answers_use_verified_base_for_deletion_and_keep_remote_additions(service):
    pid = service.profiles.save(fixture())['id']; key = 'jobsResponses:' + pid
    old = [answer('old', 'remove this'), answer('keep', 'original')]
    service.management.write([dict(key=key, value=old, revision=0)])
    old = service.management.snapshot()[key]['value']
    remote = old + [answer('remote', 'new remote fact')]
    service.management.write([dict(key=key, value=remote, revision=1)])
    items = [source(key, [answer('keep', 'local edit')], area='session'),
             source('jobsManagementBaseV1', {key: {'value': old, 'revision': 1}}, area='session')]
    mid, digest = uploaded(service, items)
    plan = service.plan(DEVICE, mid)
    assert len(plan['conflicts']) == 1
    plan = decide(service, mid, 'answer_conflict', 'source:0')
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    actual = service.management.snapshot()[key]['value']
    assert {r['question']: r['response'] for r in actual} == {'keep': 'local edit', 'remote': 'new remote fact'}


def test_profile_three_way_merge_preserves_unrelated_server_edits(service):
    original = {**fixture(), 'applicationData': {'pronouns': 'original', 'aiNotes': 'base'}}
    saved = service.profiles.save(original); pid = saved['id']
    local = copy.deepcopy(original); local['applicationData']['pronouns'] = 'local'
    remote = copy.deepcopy(original); remote['applicationData']['aiNotes'] = 'server addition'
    service.profiles.save(remote, profile_id=pid, expected_sync=saved['last_sync'])
    item = source('jobsProfilePending', {'path': '/api/ext/sync/profile', 'body': {'id': pid, 'profile': local, 'expected_sync': saved['last_sync']}})
    mid, digest = uploaded(service, [item]); plan = decide(service, mid, 'profile_version', 'source:0')
    service.apply(DEVICE, mid, plan['revision'], digest)
    assert service.profiles.get(pid)['profile']['applicationData'] == {'pronouns': 'local', 'aiNotes': 'server addition'}


def application():
    return dict(jobTitle='Synthetic role', jobLink='https://boards.greenhouse.io/synthetic/jobs/1234567', companyName='Synthetic',
                companyLink='', date='2026-01-01', status='applied', profileName='Synthetic')


def test_legacy_application_import_is_unconfirmed_and_lost_reply_retry_is_once(service, monkeypatch):
    from jobs_radar.application_records import ApplicationRecords
    item = source('appliedList', [application()]); mid, digest = uploaded(service, [item])
    plan = decide(service, mid, 'application_identity', 'import')
    original = ApplicationRecords.mutate
    def lost(self, *a, **kw):
        original(self, *a, **kw)
        raise OSError('lost reply')
    monkeypatch.setattr(ApplicationRecords, 'mutate', lost)
    with pytest.raises(OSError): service.apply(DEVICE, mid, plan['revision'], digest)
    monkeypatch.setattr(ApplicationRecords, 'mutate', original)
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    with service.store.connect() as c:
        rows = c.execute('SELECT * FROM applications WHERE record IS NOT NULL').fetchall()
    assert len(rows) == 1 and rows[0]['status'] == 'submitted_unconfirmed' and rows[0]['confirmed_at'] is None
    assert json.loads(rows[0]['record'])['date'] == '2026-01-01'


def test_owner_undo_guard_is_inside_domain_write_transaction(service, monkeypatch):
    from jobs_radar.application_records import ApplicationRecords
    from jobs_radar.job_match import job_key
    item = source('appliedList', [application()]); mid, digest = uploaded(service, [item])
    plan = decide(service, mid, 'application_identity', 'import')
    original = ApplicationRecords.mutate
    def concurrent(self, *a, **kw):
        with service.store.connect(True) as c:
            c.execute('INSERT INTO applications(job_id,status,version,updated,job_key) VALUES(?,?,?,?,?)',
                      ('external:synthetic', 'not_started', 7, 1, job_key(application()['jobLink'])))
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES('external:synthetic','owner_submission_undo','owner',1,'{}')")
        return original(self, *a, **kw)
    monkeypatch.setattr(ApplicationRecords, 'mutate', concurrent)
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'required_input'
    with service.store.connect() as c:
        assert c.execute('SELECT count(*) FROM applications WHERE record IS NOT NULL').fetchone()[0] == 0


def test_restore_copy_failure_preserves_source_and_cannot_seal(service, monkeypatch):
    item = source('profile', fixture()); mid, digest, _ = begin(service, [item]); e, raw = item
    service.upload(DEVICE, mid, e['entryId'], raw, e['size'], e['sha256'])
    original = service._copy
    def broken(src, dst, *args):
        if dst.suffix == '.restore': raise OSError('synthetic disk failure')
        return original(src, dst, *args)
    monkeypatch.setattr(service, '_copy', broken)
    with pytest.raises(OSError): service.seal(DEVICE, mid, digest)
    assert 'backup' not in service.status(DEVICE, mid)
    assert service._path(mid, e['entryId'] + '.json').read_bytes() == raw.encode()
    monkeypatch.setattr(service, '_copy', original)
    assert service.seal(DEVICE, mid, digest)['backup']['restoreVerified']


def test_deadline_interrupts_synchronous_parser_and_releases_admission(service, monkeypatch):
    from jobs_radar import storage_migration_contract as contract
    async def run():
        async with service.admission():
            deadline = contract.DEADLINE.get()
            monkeypatch.setattr(contract.time, 'monotonic', lambda: deadline + 1)
            with pytest.raises(MigrationError, match='migration_limit'): strict_json('{"x":1}')
        monkeypatch.undo()
        async with service.admission(): pass
    asyncio.run(run())


@pytest.mark.parametrize('change', ['add', 'edit', 'remove', 'reorder'])
def test_normal_management_context_mutations_fail_as_one_atomic_batch(service, change):
    old = [{'configName': 'A', 'premiumSettings': {'responseContext': 'Synthetic'}}, {'configName': 'B'}]
    with service.store.connect(True) as c:
        c.execute('INSERT INTO management_documents VALUES(?,?,1)', ('configList', json.dumps(old)))
    value = copy.deepcopy(old)
    if change == 'add': value[1]['premiumSettings'] = {'responseContext': 'New'}
    if change == 'edit': value[0]['premiumSettings']['responseContext'] = 'Changed'
    if change == 'remove': value[0]['premiumSettings'].pop('responseContext')
    if change == 'reorder': value.reverse()
    with pytest.raises(ProfileConflict):
        service.management.write([dict(key='dailyGoal', revision=0, value=7), dict(key='configList', revision=1, value=value)])
    assert 'dailyGoal' not in service.management.snapshot()
    assert service.management.snapshot()['configList']['value'] == old
    service.management.write([dict(key='configList', revision=1, value=old)])


def test_explicit_context_removal_is_exact_hash_bound_and_cannot_add_new_context(service):
    old = {'premiumSettings': {'responseContext': 'Synthetic', 'keep': True}}
    with service.store.connect(True) as c:
        c.execute('INSERT INTO management_documents VALUES(?,?,1)', ('settings', json.dumps(old)))
    path = '/premiumSettings/responseContext'
    with pytest.raises(ProfileConflict):
        service.management.write([dict(key='settings', revision=1, value={'premiumSettings': {'keep': True}})], context_removals={'settings': {path: '0' * 64}})
    service.management.write([dict(key='settings', revision=1, value={'premiumSettings': {'keep': True}})], context_removals={'settings': {path: service.management._context_hash('Synthetic')}})
    with pytest.raises(ProfileConflict):
        service.management.write([dict(key='settings', revision=2, value=old)], context_removals={})


def test_lazy_preview_requires_full_pagination_and_never_returns_attachment_bytes(service):
    profile = fixture()
    profile['nameData'] = {f'legacy_{i}': 'Synthetic' for i in range(24)}
    profile['resumeData'] = {'resumeBase64': 'synthetic-binary-private', 'fileName': 'synthetic.pdf', 'fileSize': 1}
    mid, digest = uploaded(service, [source('profile', profile)])
    plan = service.plan(DEVICE, mid); conflict = plan['conflicts'][0]
    assert next(c for c in conflict['choices'] if c['id'] == 'new')['requiresPreview']
    with pytest.raises(MigrationError): service.resolve(DEVICE, mid, plan['revision'], conflict['id'], 'new')
    first = service.preview(DEVICE, mid, conflict['id'], 'new')
    assert not first['complete'] and 'previewId' not in first
    with pytest.raises(MigrationError): service.preview(DEVICE, mid, conflict['id'], 'new', 'guessed-cursor')
    last = service.preview(DEVICE, mid, conflict['id'], 'new', first['nextCursor'])
    assert last['complete']
    serialized = json.dumps([first, last])
    assert 'synthetic-binary-private' not in serialized
    assert any(row['type'] == 'attachment' for page in (first, last) for row in page['rows'])
    assert service.resolve(DEVICE, mid, plan['revision'], conflict['id'], 'new', last['previewId'])['revision'] > plan['revision']


def test_over_budget_preview_cannot_authorize_hidden_changes(service):
    profile = fixture(); profile['nameData'] = {f'legacy_{i}': 'value' for i in range(205)}
    mid, _ = uploaded(service, [source('profile', profile)])
    plan = service.plan(DEVICE, mid); conflict = plan['conflicts'][0]
    result = service.preview(DEVICE, mid, conflict['id'], 'new')
    assert result['blocked'] and not result['complete'] and 'previewId' not in result
    with pytest.raises(MigrationError): service.resolve(DEVICE, mid, plan['revision'], conflict['id'], 'new', 'forged')


def test_preview_proof_is_invalidated_by_new_server_facts(service):
    saved = service.profiles.save(fixture()); pid = saved['id']
    local = {**fixture(), 'applicationData': {'sponsorshipNow': False}}
    item = source('jobsProfilePending', {'path': '/api/ext/sync/profile', 'body': {'id': pid, 'profile': local}})
    mid, _ = uploaded(service, [item]); plan = service.plan(DEVICE, mid); conflict = plan['conflicts'][0]
    preview = service.preview(DEVICE, mid, conflict['id'], 'source:0')
    assert preview['complete']
    service.profiles.save({**fixture(), 'profileName': 'New server name'}, profile_id=pid, expected_sync=saved['last_sync'])
    with pytest.raises(MigrationError, match='migration_plan_stale'):
        service.resolve(DEVICE, mid, plan['revision'], conflict['id'], 'source:0', preview['previewId'])


def test_saga_never_loads_all_management_or_application_rows(service, monkeypatch):
    from jobs_radar import application_records
    pid = service.profiles.save(fixture())['id']
    mid, digest = uploaded(service, [source('jobsResponses:' + pid, [answer('q', 'Synthetic')]), source('appliedList', [application()])])
    plan = decide(service, mid, 'answer_conflict', 'source:0')
    plan = decide(service, mid, 'application_identity', 'import')
    monkeypatch.setattr(service.management, 'snapshot', lambda: pytest.fail('unbounded management snapshot'))
    monkeypatch.setattr(application_records, 'read', lambda _: pytest.fail('unbounded application rows'))
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'


def test_session_disappears_after_present_claim_without_fabricated_local_deletion(service):
    pid = service.profiles.save(fixture())['id']
    item = source('jobsResponses:' + pid, [], area='session')
    mid, digest = uploaded(service, [item]); plan = preserve(service, mid); service.apply(DEVICE, mid, plan['revision'], digest)
    entry = item[0]
    first = service.claim(DEVICE, mid, entry['entryId'], digest, entry['sha256'], 'synthetic-build')
    later = service.claim(DEVICE, mid, entry['entryId'], digest, entry['sha256'], 'synthetic-build', observed='session_absent')
    assert later['permitId'] != first['permitId']
    with pytest.raises(MigrationError): service.ack(DEVICE, mid, entry['entryId'], first['permitId'], digest, 'absent')
    assert service.ack(DEVICE, mid, entry['entryId'], later['permitId'], digest, 'session_expired')['cleaned'] == [entry['entryId']]


def test_completed_reply_retry_survives_later_owner_profile_edit(service):
    saved = service.profiles.save(fixture()); pid = saved['id']
    entry = source('jobsProfilesCache', {pid: {'id': pid, 'profile': fixture(), 'last_sync': saved['last_sync']}})
    mid, digest = uploaded(service, [entry]); plan = service.plan(DEVICE, mid)
    service.apply(DEVICE, mid, plan['revision'], digest)
    e = entry[0]; permit = service.claim(DEVICE, mid, e['entryId'], digest, e['sha256'], 'synthetic-build')
    service.ack(DEVICE, mid, e['entryId'], permit['permitId'], digest, 'absent')
    service.complete(DEVICE, mid, digest, 0)
    service.profiles.save({**fixture(), 'profileName': 'Later edit'}, profile_id=pid, expected_sync=saved['last_sync'])
    assert service.complete(DEVICE, mid, digest, 0)['phase'] == 'complete'


def test_common_http_rejects_large_chunk_before_copy_or_handler(monkeypatch):
    from jobs_radar import http_routes
    server = Server(); calls = []
    class GuardedBuffer(bytearray):
        def extend(self, value):
            calls.append('copied')
            return super().extend(value)
    monkeypatch.setattr(http_routes, 'bytearray', GuardedBuffer, raising=False)
    @RouteAPI(server).route('/bounded', ['POST'], lambda request: True, max_bytes=10)
    def handler(request, payload, principal):
        calls.append('handler'); return {'ok': True}
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        result = client.post('/bounded', content=b' ' * 1024 * 1024, headers={'content-type': 'application/json'})
    assert result.status_code == 413 and calls == []


def test_default_http_without_hooks_keeps_normal_behavior():
    server = Server()
    @RouteAPI(server).route('/normal', ['POST'], lambda request: 'owner')
    def handler(request, payload, principal): return {'value': payload, 'owner': principal}
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        assert client.post('/normal', json={'x': 3}).json() == {'value': {'x': 3}, 'owner': 'owner'}
        assert client.post('/normal', content='{bad', headers={'content-type': 'application/json'}).status_code == 400


def test_sqlite_write_lock_obeys_migration_budget_then_allows_retry(service):
    locked = sqlite3.connect(service.store.path)
    locked.execute('BEGIN IMMEDIATE')
    service.limits['requestTimeoutMs'] = 80
    async def blocked():
        async with service.admission():
            service.profiles.save(fixture())
    start = time.monotonic()
    try:
        with pytest.raises(MigrationError, match='migration_limit'): asyncio.run(blocked())
    finally:
        locked.rollback(); locked.close()
    assert time.monotonic() - start < 1
    assert service.profiles.list() == []
    service.limits['requestTimeoutMs'] = 20000
    async def retry():
        async with service.admission(): return service.profiles.save(fixture())
    assert asyncio.run(retry())['id']
    with service.store.connect() as c: assert c.execute('PRAGMA busy_timeout').fetchone()[0] == 30000


def test_long_sql_is_interrupted_and_write_transaction_rolls_back(service):
    service.limits['requestTimeoutMs'] = 40
    async def query():
        async with service.admission():
            with service.store.connect(True) as c:
                c.execute("INSERT INTO management_documents VALUES('dailyGoal','7',1)")
                c.execute('WITH RECURSIVE numbers(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM numbers WHERE x<100000000) SELECT sum(x) FROM numbers').fetchone()
    with pytest.raises(MigrationError, match='migration_limit'): asyncio.run(query())
    assert 'dailyGoal' not in service.management.snapshot()


def test_readback_conflict_remains_reviewable_instead_of_stuck_ready(service):
    saved = service.profiles.save(fixture()); pid = saved['id']
    item = source('jobsProfilePending', {'path': '/api/ext/sync/profile', 'body': {'id': pid, 'profile': {**fixture(), 'profileName': 'Chosen local'}}})
    mid, digest = uploaded(service, [item]); plan = decide(service, mid, 'profile_version', 'source:0')
    service.apply(DEVICE, mid, plan['revision'], digest)
    current = service.profiles.get(pid)
    service.profiles.save({**fixture(), 'profileName': 'New owner edit'}, profile_id=pid, expected_sync=current['last_sync'])
    assert service.verify(DEVICE, mid, digest)['phase'] == 'required_input'
    plan = preserve(service, mid)
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    assert service.profiles.get(pid)['profile']['profileName'] == 'New owner edit'


def test_inaccessible_existing_vault_never_disappears_from_capacity_accounting(service, monkeypatch):
    from jobs_radar import storage_migrations
    existing = service.vault / 'synthetic-existing'
    existing.mkdir(); (existing / 'original').write_bytes(b'Synthetic original')
    def inaccessible_walk(path, *, followlinks=False, onerror=None):
        if onerror: onerror(PermissionError('Synthetic inaccessible archive'))
        return iter(())
    monkeypatch.setattr(storage_migrations.os, 'walk', inaccessible_walk)
    with pytest.raises(MigrationError, match='migration_limit'): service._space(1)
    assert (existing / 'original').read_bytes() == b'Synthetic original'


def review_baseline(service, reason, *, with_label=True):
    """Use the real snapshot producer, with only fabricated historical inputs."""
    from datetime import datetime, timezone
    from jobs_radar.application_records import upsert
    from jobs_radar.application_progress import ApplicationProgress
    with service.store.connect(True) as c:
        row = upsert(c, {**application(), 'id': 'synthetic-review-candidate'})
    observed = time.time() - 60
    if reason == 'application_match_pending':
        ApplicationProgress(service.store).record_pending_email(
            'abcdef1234567890', datetime.fromtimestamp(observed, timezone.utc).isoformat(),
            'Synthetic employer', 'assessment', 'Synthetic unresolved progress.', candidate_ids=[row['id']])
    else:
        # Exact legacy initialize() projection at 257a15f, application_progress.py:307-310.
        # The applications-v2 migration preserves that payload as a pending event.
        payload = dict(job_id='synthetic-job', stage='received', message_id='abcdef1234567891',
                       received_at=observed, summary='Synthetic ambiguous records.', reason=reason,
                       candidates=[{name: row[name] for name in ('id', 'jobTitle', 'companyName', 'jobLink')}])
        with service.store.connect(True) as c:
            c.execute("INSERT INTO application_events(event_key,kind,payload,created) VALUES(?,'pending',?,?)",
                      ('pending:synthetic-job', json.dumps(payload), observed))
    baseline = service.management.snapshot()
    assert baseline['applicationProgressReview']['revision'] == 0
    if not with_label:
        # Pre-v2 pending_reviews returned these same stored payloads without a display label.
        for pending in baseline['applicationProgressReview']['value']: pending.pop('label', None)
    return baseline


def review_domain_rows(service):
    with service.store.connect() as c:
        return {table: [tuple(row) for row in c.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                for table in ('applications', 'application_events', 'management_documents', 'management_revisions')}


@pytest.mark.parametrize('reason', ['multiple_application_records', 'application_match_pending'])
@pytest.mark.parametrize('with_label', [False, True])
def test_server_review_baseline_restores_exact_bytes_without_domain_writes(service, reason, with_label, monkeypatch):
    baseline = review_baseline(service, reason, with_label=with_label)
    before = review_domain_rows(service)
    item = source('jobsManagementBaseV1', baseline); entry, raw = item
    restored = []
    original_copy = service._copy
    def observe_restore(source_path, destination, metadata, deadline):
        original_copy(source_path, destination, metadata, deadline)
        if destination.suffix == '.restore': restored.append(destination.read_bytes())
    monkeypatch.setattr(service, '_copy', observe_restore)
    mid, digest = uploaded(service, [item])
    assert restored == [raw.encode()]
    assert service._path(mid, entry['entryId'] + '.json').read_bytes() == raw.encode()
    assert service._path(mid, entry['entryId'] + '.backup').read_bytes() == raw.encode()
    plan = service.plan(DEVICE, mid)
    assert plan['conflicts'] == [] and [op['kind'] for op in plan['operations']] == ['preserve']
    with service.store.connect() as c:
        operation = json.loads(c.execute('SELECT metadata FROM installed_migration_operations WHERE migration_id=?', (mid,)).fetchone()[0])
    assert operation['sources'] == [dict(entryId=entry['entryId'], path=[], sha256=entry['sha256'])]
    assert service.apply(DEVICE, mid, plan['revision'], digest)['phase'] == 'ready_to_clean'
    assert service.verify(DEVICE, mid, digest)['phase'] == 'ready_to_clean'
    assert review_domain_rows(service) == before


@pytest.mark.parametrize('case', ['unknown_review_field', 'unknown_wrapper_field', 'nonzero_revision',
                                 'boolean_revision', 'wrong_reason', 'wrong_timestamp', 'wrong_candidate',
                                 'unknown_stage', 'wrong_label', 'wrong_mail_identity', 'wrong_assessment',
                                 'wrong_candidate_ids', 'credential', 'backup_source', 'unknown_document'])
def test_review_baseline_rejects_unproven_shapes_and_credentials_without_upload(service, case):
    baseline = review_baseline(service, 'application_match_pending')
    wrapper = baseline['applicationProgressReview']; review = wrapper['value'][0]
    key = 'jobsManagementBaseV1'
    if case == 'unknown_review_field': review['unexpected'] = 'synthetic'
    elif case == 'unknown_wrapper_field': wrapper['unexpected'] = 'synthetic'
    elif case == 'nonzero_revision': wrapper['revision'] = 1
    elif case == 'boolean_revision': wrapper['revision'] = False
    elif case == 'wrong_reason': review['reason'] = 'synthetic-other'
    elif case == 'wrong_timestamp': review['received_at'] = True
    elif case == 'wrong_candidate': review['candidates'][0]['unexpected'] = 'synthetic'
    elif case == 'unknown_stage': review['stage'] = 'synthetic-other'
    elif case == 'wrong_label': review['label'] = {}
    elif case == 'wrong_mail_identity': review['job_id'] = 'synthetic-other'
    elif case == 'wrong_assessment': review['assessment_type'] = 'synthetic-other'
    elif case == 'wrong_candidate_ids': review['candidate_job_ids'] = [False]
    elif case == 'credential': review['candidates'][0]['token'] = 'synthetic-not-a-credential'
    elif case == 'backup_source':
        key = 'jobsManagementBeforeMigrationV1'
        baseline = {'applicationProgressReview': wrapper['value']}
    elif case == 'unknown_document': baseline['unprovenSnapshotDocument'] = {'value': {}, 'revision': 0}
    before = review_domain_rows(service)
    item = source(key, baseline); entry, raw = item
    mid, _, _ = begin(service, [item])
    with pytest.raises(MigrationError) as caught:
        service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    assert caught.value.code == ('migration_credential_source' if case == 'credential' else 'migration_invalid_source')
    assert service.status(DEVICE, mid)['uploaded'] == []
    assert not service._path(mid, entry['entryId'] + '.json').exists()
    assert review_domain_rows(service) == before


def test_review_baseline_large_integer_timestamp_does_not_overflow_http_validation(service):
    baseline = review_baseline(service, 'application_match_pending')
    # Integers are finite without float conversion; this value is preserved only,
    # never interpreted as a new recruiting event or accepted submission.
    baseline['applicationProgressReview']['value'][0]['received_at'] = 10 ** 400
    before = review_domain_rows(service)
    item = source('jobsManagementBaseV1', baseline); entry, raw = item
    mid, _, _ = begin(service, [item])
    server = Server()
    register_storage_migration_routes(RouteAPI(server), service, lambda request: DEVICE)
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        result = client.put('/api/extension/storage-migrations/' + mid + '/entries/' + entry['entryId'],
                            json=dict(jsonText=raw, size=entry['size'], sha256=entry['sha256']))
    assert result.status_code == 200 and result.json()['stored'] is True
    assert service._path(mid, entry['entryId'] + '.json').read_bytes() == raw.encode()
    assert review_domain_rows(service) == before
