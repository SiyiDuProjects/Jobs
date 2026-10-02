"""Synthetic screening provenance remains exact across one posting merge."""
import json
import hashlib
import sqlite3

import pytest

from jobs_radar.application_records import write_state
from jobs_radar.board import Board
from jobs_radar.identity import stable_id
from jobs_radar.screening_progress import ScreeningProgress
from test_migration_duplicate_records import (
    INVENTORY_JOB, OFFICIAL_JOB, INVENTORY_UPDATED, duplicate_legacy_records, migrated,
)
from test_store import observation

TABLES = ('screening_seen', 'screening_batch_items', 'screening_rechecks',
          'screening_batches', 'screening_checkpoint')
UNRELATED = stable_id('synthetic-unrelated-pending')


def seed_screening(path):
    with sqlite3.connect(path) as c:
        c.executescript('''
            CREATE TABLE screening_checkpoint(id INTEGER PRIMARY KEY,cutoff REAL,initialized INTEGER);
            CREATE TABLE screening_batches(id TEXT PRIMARY KEY,since REAL,cutoff REAL,status TEXT,completed REAL);
            CREATE TABLE screening_seen(job_id TEXT,kind TEXT,fingerprint TEXT,present INTEGER,PRIMARY KEY(job_id,kind));
            CREATE TABLE screening_batch_items(run_id TEXT,job_id TEXT,kind TEXT,PRIMARY KEY(run_id,job_id,kind));
            CREATE TABLE screening_rechecks(source_run TEXT,job_id TEXT,kind TEXT,review_version INTEGER,PRIMARY KEY(source_run,job_id,kind));
            INSERT INTO screening_checkpoint VALUES(1,10,1);
            INSERT INTO screening_batches VALUES('complete-original',1,10,'complete',11);
            INSERT INTO screening_batches VALUES('active-original',10,20,'active',NULL);
        ''')
        c.execute("INSERT INTO jobs VALUES(?,'synthetic:unrelated',12,13)", (UNRELATED,))
        c.execute("INSERT INTO applications VALUES(?,'not_started',0,13,'','[]',NULL)", (UNRELATED,))
        source = {**observation(url='https://example.org/jobs/unrelated'), 'source_id': UNRELATED}
        c.execute('INSERT INTO observations VALUES(?,?,?,?,12,13,1)',
                  ('simplify:newgrad', UNRELATED, UNRELATED, json.dumps(source)))
        for index, jid in enumerate((OFFICIAL_JOB, INVENTORY_JOB, UNRELATED)):
            c.execute("INSERT INTO screening_seen VALUES(?,'newgrad',?,?)", (jid, f'original-fingerprint-{index}', index % 2))
            c.execute("INSERT INTO screening_batch_items VALUES('active-original',?,'newgrad')", (jid,))
            c.execute("INSERT INTO screening_batch_items VALUES('complete-original',?,'newgrad')", (jid,))
            c.execute("INSERT INTO screening_rechecks VALUES('complete-original',?,'newgrad',?)", (jid, index + 3))
        return {table: list(c.execute('SELECT * FROM ' + table + ' ORDER BY rowid')) for table in TABLES}


def test_screening_original_rows_and_global_membership_are_unchanged(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    before = seed_screening(path)
    store, _, report = migrated(duplicate_legacy_records)
    with store.connect() as c:
        assert {table: [tuple(r) for r in c.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                for table in TABLES} == before
        # They remain directly readable as provenance; no rewritten substitute
        # or second archive is needed to reconstruct the original membership.
        assert not c.execute("SELECT 1 FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table') LIKE 'duplicate_screening_%'").fetchone()
    policies = {r['table']: r for r in report['duplicate_records'][0]['references']}
    for table, count in (('screening_seen', 2), ('screening_batch_items', 4), ('screening_rechecks', 2)):
        assert policies[table] == {'table': table, 'count': count, 'policy': 'retain_original_reference'}


def test_retained_screening_history_cannot_requeue_confirmed_or_owner_reset_job(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    seed_screening(path)
    store, _, _ = migrated(duplicate_legacy_records)
    progress = ScreeningProgress(store)
    assert {r['id'] for r in Board(store)._rows('newgrad')} == {INVENTORY_JOB, UNRELATED}
    assert [r['id'] for r in progress.queue('active-original', 'newgrad')['jobs']] == [UNRELATED]
    assert progress.manage('status')['remaining'] == {'newgrad': 1, 'internship': 0}
    # An explicit later owner reset advances version, so the historical
    # version-zero screening backlog still cannot become executable.
    with store.connect(True) as c:
        write_state(c, INVENTORY_JOB, {'status': 'not_started'}, version_step=1, reason='owner_undo')
    assert [r['id'] for r in progress.queue('active-original', 'newgrad')['jobs']] == [UNRELATED]


@pytest.mark.parametrize('offset', [-1, 0])
def test_expired_undo_is_retained_without_changing_guard_or_snapshot(duplicate_legacy_records, monkeypatch, offset):
    from jobs_radar.board import Board
    started = INVENTORY_UPDATED + 10000
    monkeypatch.setattr('time.time', lambda: started)
    path, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        c.row_factory = sqlite3.Row
        original = dict(c.execute('SELECT * FROM applications WHERE job_id=?', (INVENTORY_JOB,)).fetchone())
        c.execute('INSERT INTO owner_submission_undo VALUES(?,7,?,?,?)',
                  (INVENTORY_JOB, started + offset, json.dumps(original), '[]'))
        before = [tuple(r) for r in c.execute('SELECT * FROM owner_submission_undo')]
    store, _, report = migrated(duplicate_legacy_records)
    assert report['started_at'] == started
    with store.connect() as c:
        assert [tuple(r) for r in c.execute('SELECT * FROM owner_submission_undo')] == before
    policy = next(r for r in report['duplicate_records'][0]['references'] if r['table'] == 'owner_submission_undo')
    assert policy == {'table': 'owner_submission_undo', 'count': 1, 'policy': 'retain_expired_reference'}
    with pytest.raises(ValueError, match='撤销期限已过'):
        Board(store).undo_submitted(INVENTORY_JOB, 7, 'synthetic-expired-undo')


@pytest.mark.parametrize('expiry', [0, -1, None, 'invalid', float('inf'), 'expires-during-migration'])
def test_invalid_or_initially_live_undo_still_rolls_back(duplicate_legacy_records, monkeypatch, expiry):
    from jobs_radar import application_schema
    started = INVENTORY_UPDATED + 10000
    clock = [started]
    monkeypatch.setattr('time.time', lambda: clock[0])
    archive = application_schema._archive
    def advance_after_start(*args):
        clock[0] = started + 100
        return archive(*args)
    monkeypatch.setattr(application_schema, '_archive', advance_after_start)
    path, *_ = duplicate_legacy_records
    value = started + 1 if expiry == 'expires-during-migration' else expiry
    with sqlite3.connect(path) as c:
        c.execute('INSERT INTO owner_submission_undo VALUES(?,7,?,?,?)', (INVENTORY_JOB, value, '{}', '[]'))
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='requires review'):
        application_schema.migrate_path(path, dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
