"""Synthetic history regression: evidence is exact without retaining whole tables."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import tracemalloc

import pytest

from jobs_radar.application_schema import migrate_path


SCHEMA = Path(__file__).parent / 'fixtures' / 'legacy-release-schema.sql'
LIMIT = 448 * 1024**2


def database(path):
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript(SCHEMA.read_text(encoding='utf-8'))
        db.execute("INSERT INTO management_documents VALUES('appliedList','[]',1)")
        db.execute("INSERT INTO management_revisions VALUES('settings',1,?,1)",
                   (json.dumps({'keep': 'synthetic unrelated history'}),))
    return path


def revision_value(number, size):
    return json.dumps([{'id': f'synthetic-{number}', 'notes': 'x' * size}], ensure_ascii=False)


def add_history(path, count, size):
    with closing(sqlite3.connect(path)) as db, db:
        for number in reversed(range(count)):
            db.execute('INSERT INTO management_revisions VALUES(?,?,?,?)',
                       ('appliedList', number, revision_value(number, size), number + .25))


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(256 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def archived(db, table):
    return db.execute("SELECT event_key,payload FROM application_events WHERE kind='migration_evidence' "
                      "AND json_extract(payload,'$.table')=? ORDER BY rowid", (table,))


def expected_key(table, index, row):
    raw = json.dumps(row, ensure_ascii=False, sort_keys=True)
    return f'migration:{table}:{index}:' + hashlib.sha256(raw.encode()).hexdigest()


def test_archive_preserves_original_query_order_complete_rows_hashes_and_reapply(tmp_path):
    path = database(tmp_path / 'history.sqlite')
    add_history(path, 5, 256)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("UPDATE management_revisions SET value=? WHERE key='appliedList' AND revision=2",
                   (' [ { "note": "合成☃", "value": 2 } ] ',))
        db.row_factory = sqlite3.Row
        before = [dict(row) for row in db.execute("SELECT * FROM management_revisions WHERE key='appliedList'")]
    migrate_path(path, dry_run=False)
    with closing(sqlite3.connect(path)) as db:
        rows = list(archived(db, 'management_revisions'))
        assert len(rows) == len(before)
        for index, ((key, raw), original) in enumerate(zip(rows, before)):
            assert key == expected_key('management_revisions', index, original)
            assert raw == json.dumps({'table': 'management_revisions', 'row': original}, ensure_ascii=False)
        assert db.execute("SELECT value FROM management_revisions WHERE key='settings'").fetchone()[0] == json.dumps({'keep': 'synthetic unrelated history'})
        assert not db.execute("SELECT 1 FROM management_revisions WHERE key='appliedList'").fetchone()
        evidence = list(db.execute('SELECT * FROM application_events ORDER BY rowid'))
    assert migrate_path(path, dry_run=False)['already_applied'] is True
    with closing(sqlite3.connect(path)) as db:
        assert list(db.execute('SELECT * FROM application_events ORDER BY rowid')) == evidence


def test_revision_history_python_peak_depends_on_row_size_not_total_history(tmp_path):
    path = database(tmp_path / 'history.sqlite')
    add_history(path, 64, 256 * 1024)  # >16 MiB history; every row is only 256 KiB.
    # Resolve imports before measuring the concrete row-buffering regression.
    from jobs_radar import application_records, application_progress, migration_identity_split, migration_duplicate_records
    tracemalloc.start()
    try:
        migrate_path(path, dry_run=False)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024**2, f'Whole history retained in Python: {peak} bytes'
    with closing(sqlite3.connect(path)) as db:
        assert sum(1 for _ in archived(db, 'management_revisions')) == 64


def test_retired_receipts_remain_reiterable_and_archive_without_whole_table_buffer(tmp_path):
    path = database(tmp_path / 'receipts.sqlite')
    payload = json.dumps({'detail': 'synthetic receipt ' + 'x' * (64 * 1024)})
    with closing(sqlite3.connect(path)) as db, db:
        for number in range(128):
            db.execute('INSERT INTO extension_receipts VALUES(?,?,?,?,?,?,?,?,?)',
                       (f'event-{number}', 'synthetic-device', f'checksum-{number}', payload,
                        number + .1, number + .2, 'received', None, '{}'))
        db.row_factory = sqlite3.Row
        first = dict(db.execute('SELECT * FROM extension_receipts LIMIT 1').fetchone())
    from jobs_radar import application_records, application_progress, migration_identity_split, migration_duplicate_records
    tracemalloc.start()
    try:
        report = migrate_path(path, dry_run=False)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 4 * 1024**2, f'Whole retired table retained in Python: {peak} bytes'
    assert report['source_counts']['extension_receipts'] == 128
    with closing(sqlite3.connect(path)) as db:
        assert sum(1 for _ in archived(db, 'extension_receipts')) == 128
        key, raw = next(iter(archived(db, 'extension_receipts')))
        assert key == expected_key('extension_receipts', 0, first)
        assert json.loads(raw)['row'] == first
        rows = db.execute("SELECT event_key,payload,checksum,created,updated,state,result FROM application_events WHERE kind='extension' ORDER BY rowid")
        for number, row in enumerate(rows):
            assert row == (f'event-{number}', payload, f'checksum-{number}', number + .1, number + .2, 'received', '{}')
        assert number == 127


def test_failure_after_streamed_archive_rolls_back_every_row_and_schema(tmp_path, monkeypatch):
    from jobs_radar import migration_identity_split
    path = database(tmp_path / 'failure.sqlite')
    add_history(path, 6, 1024)
    with closing(sqlite3.connect(path)) as db:
        before = list(db.iterdump())
    def fail(*_):
        raise RuntimeError('synthetic failure after evidence archive')
    monkeypatch.setattr(migration_identity_split, 'split_legacy_identities', fail)
    with pytest.raises(RuntimeError, match='synthetic failure'):
        migrate_path(path, dry_run=False)
    with closing(sqlite3.connect(path)) as db:
        assert list(db.iterdump()) == before


def test_streamed_history_dry_run_preserves_original_bytes(tmp_path):
    path = database(tmp_path / 'dry.sqlite')
    add_history(path, 8, 8192)
    before = file_hash(path)
    assert migrate_path(path, dry_run=True)['dry_run']
    assert file_hash(path) == before
    assert not list(tmp_path.glob('.applications-migration-*'))


def stress_child(path, count, size):
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (LIMIT, LIMIT))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 125))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    started = time.monotonic()
    migrate_path(path, dry_run=False)
    with closing(sqlite3.connect(path)) as db:
        actual = archived(db, 'management_revisions')
        seen = 0
        for index, (key, raw) in enumerate(actual):
            expected = {'key': 'appliedList', 'revision': index,
                        'value': revision_value(index, size), 'created': index + .25}
            assert key == expected_key('management_revisions', index, expected)
            assert json.loads(raw) == {'table': 'management_revisions', 'row': expected}
            seen += 1
        assert seen == count
    # A second invocation may not duplicate or rewrite any evidence bytes.
    before = file_hash(path)
    assert migrate_path(path, dry_run=False)['already_applied'] is True
    assert file_hash(path) == before
    print(json.dumps({'verified': True, 'historyRows': seen, 'historyValueBytes': count * size,
                      'addressSpaceLimitBytes': LIMIT, 'peakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                      'wallSeconds': round(time.monotonic() - started, 3)}))


@pytest.mark.skipif(sys.platform != 'linux', reason='Actual RLIMIT_AS boundary requires Linux')
def test_large_history_migrates_under_actual_448mib_address_space_limit(tmp_path):
    path = database(tmp_path / 'bounded.sqlite')
    count, size = 260, 2 * 1024**2  # 520 MiB cannot fit in the 448 MiB Python process.
    add_history(path, count, size)
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--stress-child',
                             str(path), str(count), str(size)], capture_output=True, text=True,
                            timeout=240, env={**os.environ, 'PYTHONPATH': str(Path(__file__).parents[1])})
    assert result.returncode == 0, result.stderr[-4000:]
    proof = json.loads(result.stdout)
    assert proof['verified'] and proof['historyRows'] == count
    assert proof['addressSpaceLimitBytes'] == LIMIT
    assert proof['peakRssKiB'] < 448 * 1024
    print(json.dumps(proof, sort_keys=True))


if __name__ == '__main__':
    assert len(sys.argv) == 5 and sys.argv[1] == '--stress-child'
    stress_child(Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
