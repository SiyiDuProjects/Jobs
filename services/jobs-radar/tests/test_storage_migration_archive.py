"""Synthetic retirement of superseded, never-sealed installed migrations."""
import json
import sqlite3
import time
import uuid

import pytest

from jobs_radar.storage_migration_contract import DEADLINE, MigrationError, sha
from test_profile_contract import fixture
from test_storage_migrations import DEVICE, begin, service, source


def incomplete(service, *, superseded=True):
    values = [source('profile', fixture()), source('responseList', [])]
    mid, digest, manifest = begin(service, values)
    entry, raw = values[0]
    service.upload(DEVICE, mid, entry['entryId'], raw, entry['size'], entry['sha256'])
    if superseded:
        service.supersede(DEVICE, mid, digest, str(uuid.uuid4()))
    return mid, digest, manifest, values


def online(service, mid):
    with service.store.connect() as c:
        session = c.execute('SELECT * FROM installed_migrations WHERE id=?', (mid,)).fetchone()
        entries = c.execute('SELECT * FROM installed_migration_entries WHERE migration_id=? ORDER BY rowid', (mid,)).fetchall()
    return {'session': dict(session) if session else None, 'entries': [dict(row) for row in entries]}


def archives(service):
    with service.store.connect() as c:
        return [dict(row) for row in c.execute('SELECT * FROM installed_migration_archives ORDER BY rowid')]


def domain(service):
    with service.store.connect() as c:
        return {name: [tuple(row) for row in c.execute(f'SELECT * FROM {name} ORDER BY rowid')]
                for name in ('owner_profiles', 'management_documents', 'applications')}


def archive(service, mid, digest, **kwargs):
    return service.archive_superseded_incomplete(DEVICE, mid, digest, administrator=True, **kwargs)


def test_archive_preserves_all_metadata_and_raw_bytes_then_frees_only_online_slot(service):
    service.profiles.save(fixture())
    mid, digest, manifest, values = incomplete(service)
    before, before_domain = online(service, mid), domain(service)
    result = archive(service, mid, digest)
    directory = service.vault / mid / 'archive'
    snapshot = json.loads((directory / 'snapshot.json').read_bytes())
    assert snapshot == {'version': 1, **before}
    assert (directory / 'manifest.json').read_bytes() == manifest.encode()
    entry, raw = values[0]
    assert (directory / (entry['entryId'] + '.json')).read_bytes() == raw.encode()
    assert service._path(mid, entry['entryId'] + '.json').read_bytes() == raw.encode()
    assert service._path(mid, 'manifest.json').read_bytes() == manifest.encode()
    assert not (directory / (values[1][0]['entryId'] + '.json')).exists()
    assert not list(directory.glob('*.restore'))
    assert online(service, mid) == {'session': None, 'entries': []}
    assert domain(service) == before_domain
    tombstone, = archives(service)
    assert (tombstone['id'], tombstone['device'], tombstone['manifest_hash']) == (mid, DEVICE, digest)
    assert tombstone['archive_sha256'] == result['archiveSha256'] == sha((directory / 'snapshot.json').read_bytes())
    assert result['migrationId'] == mid and result['archived'] and result['restoreVerified']
    assert (result['entries'], result['uploaded']) == (2, 1)
    service.limits['maxRetainedSessionsPerDevice'] = 1
    fresh_mid, _, _ = begin(service)
    assert fresh_mid != mid
    assert archives(service) == [tombstone]


@pytest.mark.parametrize('administrator', [None, False, 1, 'true'])
def test_archive_requires_explicit_administrator_true(service, administrator):
    mid, digest, _, _ = incomplete(service)
    before = online(service, mid)
    kwargs = {} if administrator is None else {'administrator': administrator}
    with pytest.raises(MigrationError, match='migration_auth_required') as error:
        service.archive_superseded_incomplete(DEVICE, mid, digest, **kwargs)
    assert error.value.status == 403
    assert online(service, mid) == before and archives(service) == []
    assert not (service.vault / mid / 'archive').exists()


@pytest.mark.parametrize('wrong', ['device', 'manifest'])
def test_archive_cannot_cross_device_or_manifest_identity(service, wrong):
    mid, digest, _, _ = incomplete(service)
    before = online(service, mid)
    with pytest.raises(MigrationError):
        service.archive_superseded_incomplete('other-device' if wrong == 'device' else DEVICE,
                                             mid, sha(b'synthetic different manifest') if wrong == 'manifest' else digest,
                                             administrator=True)
    assert online(service, mid) == before and archives(service) == []


@pytest.mark.parametrize('condition', ['receiving', 'complete', 'backup', 'server_manifest',
                                       'operation', 'permit', 'preview', 'cleaned'])
def test_archive_rejects_every_session_with_unresolved_or_cleanup_capability(service, condition):
    mid, digest, _, values = incomplete(service)
    with service.store.connect(True) as c:
        if condition in {'receiving', 'complete'}:
            c.execute('UPDATE installed_migrations SET phase=? WHERE id=?', (condition, mid))
        elif condition == 'backup':
            c.execute('UPDATE installed_migrations SET backup_id=? WHERE id=?', (str(uuid.uuid4()), mid))
        elif condition == 'server_manifest':
            c.execute('UPDATE installed_migrations SET server_manifest_hash=? WHERE id=?', (sha(b'synthetic server'), mid))
        elif condition == 'operation':
            c.execute('INSERT INTO installed_migration_operations VALUES(?,?,?)', (mid, 'synthetic-operation', '{}'))
        elif condition == 'permit':
            c.execute('INSERT INTO installed_migration_permits(migration_id,entry_id,id,expires) VALUES(?,?,?,?)',
                      (mid, values[0][0]['entryId'], 'synthetic-permit', time.time() + 30))
        elif condition == 'preview':
            c.execute('INSERT INTO installed_migration_previews VALUES(?,?,?,?)', (mid, 'synthetic-operation', 'preserve', '{}'))
        else:
            c.execute('UPDATE installed_migration_entries SET cleaned=1 WHERE migration_id=?', (mid,))
    before = online(service, mid)
    with pytest.raises(MigrationError):
        archive(service, mid, digest)
    assert online(service, mid) == before and archives(service) == []


def test_copy_failure_leaves_original_and_online_rows_then_can_retry(service, monkeypatch):
    mid, digest, _, values = incomplete(service)
    before = online(service, mid)
    original = service._copy
    copies = 0

    def interrupted(*args, **kwargs):
        nonlocal copies
        copies += 1
        if copies == 2:
            raise OSError('Synthetic interrupted archive')
        return original(*args, **kwargs)

    monkeypatch.setattr(service, '_copy', interrupted)
    with pytest.raises(OSError, match='Synthetic interrupted archive'):
        archive(service, mid, digest)
    assert online(service, mid) == before and archives(service) == []
    assert service._path(mid, values[0][0]['entryId'] + '.json').read_bytes() == values[0][1].encode()
    monkeypatch.setattr(service, '_copy', original)
    assert archive(service, mid, digest)['restoreVerified']


def test_database_failure_rolls_back_retirement_after_archive_readback(service):
    mid, digest, _, _ = incomplete(service)
    before = online(service, mid)
    with service.store.connect(True) as c:
        c.execute("CREATE TRIGGER synthetic_archive_failure BEFORE INSERT ON installed_migration_archives "
                  "BEGIN SELECT RAISE(ABORT, 'Synthetic retirement blocked'); END")
    with pytest.raises(sqlite3.IntegrityError, match='Synthetic retirement blocked'):
        archive(service, mid, digest)
    assert online(service, mid) == before and archives(service) == []
    with service.store.connect(True) as c:
        c.execute('DROP TRIGGER synthetic_archive_failure')
    assert archive(service, mid, digest)['restoreVerified']


@pytest.mark.parametrize('file_kind', ['entry', 'manifest'])
def test_source_corruption_never_retires_online_session(service, file_kind):
    mid, digest, _, values = incomplete(service)
    before = online(service, mid)
    name = values[0][0]['entryId'] + '.json' if file_kind == 'entry' else 'manifest.json'
    service._path(mid, name).write_bytes(b'{}')
    with pytest.raises(MigrationError):
        archive(service, mid, digest)
    assert online(service, mid) == before and archives(service) == []


def test_retry_is_idempotent_and_tombstone_never_allows_old_id_reuse(service):
    mid, digest, manifest, _ = incomplete(service)
    first = archive(service, mid, digest)
    saved = archives(service)
    assert archive(service, mid, digest) == first
    assert archives(service) == saved
    for device in (DEVICE, 'other-device'):
        with pytest.raises(MigrationError):
            service.create(device, manifest, digest)
    assert online(service, mid) == {'session': None, 'entries': []}


@pytest.mark.parametrize('location', ['source', 'archive', 'snapshot'])
def test_retry_revalidates_archived_and_original_bytes_without_recreating_online_rows(service, location):
    mid, digest, _, values = incomplete(service)
    archive(service, mid, digest)
    saved = archives(service)
    name = values[0][0]['entryId'] + '.json'
    target = (service.vault / mid / 'archive' / ('snapshot.json' if location == 'snapshot' else name)
              if location != 'source' else service._path(mid, name))
    target.write_bytes(b'{}')
    with pytest.raises(MigrationError):
        archive(service, mid, digest)
    assert archives(service) == saved and online(service, mid) == {'session': None, 'entries': []}


@pytest.mark.parametrize('limit', ['deadline', 'maxVaultBytesIncludingTemporaryCopies', 'maxEntryBytes', 'maxJsonNodes'])
def test_archive_obeys_existing_request_and_storage_limits(service, limit):
    mid, digest, _, _ = incomplete(service)
    before = online(service, mid)
    assert service.limits['requestTimeoutMs'] == 20000
    token = DEADLINE.set(time.monotonic() - 1) if limit == 'deadline' else None
    if limit != 'deadline':
        service.limits[limit] = 1
    try:
        with pytest.raises(MigrationError, match='migration_limit'):
            archive(service, mid, digest)
    finally:
        if token is not None:
            DEADLINE.reset(token)
    assert online(service, mid) == before and archives(service) == []


def test_full_retained_slots_do_not_supersede_current_session_or_remove_permits(service):
    retired = [incomplete(service) for _ in range(3)]
    mid, digest, _, values = incomplete(service, superseded=False)
    with service.store.connect(True) as c:
        c.execute('INSERT INTO installed_migration_permits(migration_id,entry_id,id,expires) VALUES(?,?,?,?)',
                  (mid, values[0][0]['entryId'], 'synthetic-live-permit', time.time() + 30))
    before = online(service, mid)
    replacement = str(uuid.uuid4())
    with pytest.raises(MigrationError, match='migration_limit'):
        service.supersede(DEVICE, mid, digest, replacement)
    assert online(service, mid) == before
    with service.store.connect() as c:
        assert c.execute('SELECT id FROM installed_migration_permits WHERE migration_id=?', (mid,)).fetchone()['id'] == 'synthetic-live-permit'
    archive(service, retired[0][0], retired[0][1])
    assert service.supersede(DEVICE, mid, digest, replacement)['phase'] == 'superseded'
    new_mid, _, _ = begin(service, mid=replacement)
    assert new_mid == replacement
