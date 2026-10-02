"""Synthetic explicit choices protect narrow CAS and conflict rejection.

The shipped manifest has no active private decisions. Tests inject their own
synthetic manifest through the runtime's file-location dependency only.
"""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobs_radar.application_schema import migrate_path
from jobs_radar import migration_duplicate_records
from jobs_radar.identity import stable_id
from test_migration_accounting import accounting
from jobs_radar.board import Board
from test_migration_duplicate_records import (
    INVENTORY_JOB, OFFICIAL_JOB, duplicate_legacy_records, migrated,
)

SYNTHETIC_OWNER = stable_id('synthetic-owner-resolution-owner')
SYNTHETIC_SOURCE = stable_id('synthetic-owner-resolution-source')


@pytest.fixture
def synthetic_resolution_manifest(tmp_path, monkeypatch):
    """Exercise the unchanged parser with an explicitly synthetic test file."""
    rule = dict(
        id='synthetic-screening-keep', authorization='synthetic-explicit-approval',
        owner_job_id=SYNTHETIC_OWNER, canonical_job_id=SYNTHETIC_OWNER,
        source_job_ids=[SYNTHETIC_SOURCE], kind='internship', decision='keep',
        expected=[
            dict(job_id=SYNTHETIC_OWNER, state='trash', version=2, manual_keep=0),
            dict(job_id=SYNTHETIC_SOURCE, state='keep', version=1, manual_keep=0),
        ],
    )
    raw = json.dumps(dict(schema_version=1, screening=[rule])).encode('utf-8')
    manifest_path = tmp_path/'migration-resolutions.json'
    manifest_path.write_bytes(raw)
    def test_module_location(value):
        assert value == migration_duplicate_records.__file__
        return manifest_path.with_name('synthetic_migration_duplicate_records.py')
    monkeypatch.setattr(migration_duplicate_records, 'Path', test_module_location)
    return raw


def test_shipped_resolution_manifest_is_empty_for_both_readers():
    raw = Path(migration_duplicate_records.__file__).with_name('migration-resolutions.json').read_bytes()
    assert json.loads(raw) == {'schema_version': 1, 'screening': []}
    assert accounting()._stream.resolution_manifest() == raw


def synthetic_screening_fixture(path, *, different_group=False):
    owner = SYNTHETIC_OWNER
    source = 'synthetic-other-source' if different_group else SYNTHETIC_SOURCE
    with sqlite3.connect(path) as c:
        for old, new in ((INVENTORY_JOB, owner), (OFFICIAL_JOB, source)):
            c.execute('UPDATE jobs SET id=? WHERE id=?', (new, old))
            for table in ('applications', 'observations', 'recruiting_progress'):
                c.execute('UPDATE ' + table + ' SET job_id=? WHERE job_id=?', (new, old))
        c.execute("UPDATE observations SET stream='simplify:internship',payload=json_set(payload,'$.kind','internship')")
        for jid, state, version in ((owner, 'trash', 2), (source, 'keep', 1)):
            c.execute("INSERT INTO job_screening VALUES(?,'internship',?,'synthetic-old-reason','Original synthetic decision',?, ?,100,200,?,0)",
                      (jid, state, json.dumps([{'synthetic_original': jid}]), 'old-' + jid, version))
        c.row_factory = sqlite3.Row
        return [dict(r) for r in c.execute('SELECT * FROM job_screening')]


def test_only_explicit_synthetic_owner_restore_is_applied_and_visible(duplicate_legacy_records, synthetic_resolution_manifest):
    path, *_ = duplicate_legacy_records
    before = synthetic_screening_fixture(path)
    store, _, report = migrated(duplicate_legacy_records)
    with store.connect() as c:
        current = dict(c.execute('SELECT * FROM job_screening').fetchone())
        archived = [json.loads(r[0])['row'] for r in c.execute("SELECT payload FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_job_screening_before'")]
    assert sorted(archived, key=lambda r:r['job_id']) == sorted(before, key=lambda r:r['job_id'])
    owner = next(r for r in before if r['job_id'] == SYNTHETIC_OWNER)
    assert current == {**owner, 'state':'keep', 'reason':'manual',
        'detail':'Owner explicitly kept this posting while reconciling duplicate history.',
        'evidence':'[]', 'reviewed_at':report['started_at'], 'expires_at':None,
        'version':3, 'manual_keep':1}
    visible = Board(store).list(kind='internship', status='submitted', screening='keep')['jobs']
    assert [r['id'] for r in visible] == [SYNTHETIC_OWNER]
    decision = report['duplicate_records'][0]['screening_resolutions'][0]
    assert decision['resolution_id'] == 'synthetic-screening-keep'
    assert decision['from_version'] == 2 and decision['to_version'] == 3
    assert decision['applied_at'] == report['started_at']
    assert len(decision['manifest_sha256']) == 64


@pytest.mark.parametrize('drift', ['other_group','owner_state','owner_version','source_version','manual_keep','kind'])
def test_resolution_rejects_changed_or_unapproved_rows(duplicate_legacy_records, drift, synthetic_resolution_manifest):
    path, *_ = duplicate_legacy_records
    synthetic_screening_fixture(path, different_group=drift=='other_group')
    with sqlite3.connect(path) as c:
        if drift=='owner_state':c.execute("UPDATE job_screening SET state='review' WHERE job_id=?", (SYNTHETIC_OWNER,))
        if drift=='owner_version':c.execute('UPDATE job_screening SET version=3 WHERE job_id=?', (SYNTHETIC_OWNER,))
        if drift=='source_version':c.execute('UPDATE job_screening SET version=2 WHERE job_id=?', (SYNTHETIC_SOURCE,))
        if drift=='manual_keep':c.execute('UPDATE job_screening SET manual_keep=1 WHERE job_id=?', (SYNTHETIC_OWNER,))
        if drift=='kind':c.execute("UPDATE job_screening SET kind='newgrad'")
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='requires review'):
        migrate_path(path, dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


@pytest.mark.parametrize('canonical_present', [True, False])
def test_opened_keeps_canonical_time_or_moves_unique_source(duplicate_legacy_records, canonical_present):
    path, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        c.execute("INSERT INTO web_opened VALUES(?,'newgrad',100)", (OFFICIAL_JOB,))
        if canonical_present:c.execute("INSERT INTO web_opened VALUES(?,'newgrad',50)", (INVENTORY_JOB,))
        c.row_factory=sqlite3.Row
        before=[dict(r) for r in c.execute('SELECT * FROM web_opened')]
    store, _, report = migrated(duplicate_legacy_records)
    with store.connect() as c:
        assert [tuple(r) for r in c.execute('SELECT * FROM web_opened')] == [(INVENTORY_JOB,'newgrad',50 if canonical_present else 100)]
        archived=[json.loads(r[0])['row'] for r in c.execute("SELECT payload FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_web_opened_before'")]
    assert sorted(archived,key=lambda r:r['job_id']) == sorted(before,key=lambda r:r['job_id'])
    policy=next(r for r in report['duplicate_records'][0]['references'] if r['table']=='web_opened')
    assert policy=={'table':'web_opened','count':len(before),'policy':'preserve_canonical_opened'}


@pytest.mark.parametrize('conflict', ['extra_column','multiple_sources'])
def test_opened_does_not_resolve_unknown_metadata_or_multiple_sources(duplicate_legacy_records, conflict):
    path, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        c.execute("INSERT INTO web_opened VALUES(?,'newgrad',100)", (OFFICIAL_JOB,))
        if conflict=='extra_column':
            c.execute("INSERT INTO web_opened VALUES(?,'newgrad',50)", (INVENTORY_JOB,))
            c.execute('ALTER TABLE web_opened ADD COLUMN future_metadata TEXT')
            c.execute("UPDATE web_opened SET future_metadata='different' WHERE job_id=?", (OFFICIAL_JOB,))
        else:
            extra='synthetic-second-confirmed-source'
            c.execute("INSERT INTO jobs SELECT ?,'synthetic:another-confirmed',first_seen,last_seen FROM jobs WHERE id=?",(extra,OFFICIAL_JOB))
            c.execute('INSERT INTO applications SELECT ?,status,version,updated,detail,evidence,owner_run_id FROM applications WHERE job_id=?',(extra,OFFICIAL_JOB))
            c.execute('INSERT INTO observations SELECT stream,?,?,payload,first_seen,last_seen,present FROM observations WHERE job_id=?',(extra,extra,OFFICIAL_JOB))
            c.execute("INSERT INTO web_opened VALUES(?,'newgrad',100)", (extra,))
    before=hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError,match='requires review'):
        migrate_path(path,dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest()==before


def test_empty_shipped_manifest_rejects_unapproved_screening_conflict(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    synthetic_screening_fixture(path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='requires review'):
        migrate_path(path, dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_independent_auditor_rejects_choice_without_shipped_approval(duplicate_legacy_records):
    from test_duplicate_migration_accounting import explicit_screening_pair
    before, after, _ = explicit_screening_pair(duplicate_legacy_records)
    # No test approval is injected here: the real committed manifest is empty.
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_references' in result['summary']['failures']
