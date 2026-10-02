import hashlib
import json
from pathlib import Path
import sqlite3
import time

import pytest

from jobs_radar.application_schema import migrate_path
from jobs_radar.application_records import seed_progress
from jobs_radar.board import Board, fingerprint
from jobs_radar.extension_sync import ExtensionSync
from jobs_radar.identity import stable_id
from jobs_radar.job_match import job_key
from jobs_radar.store import Store
from test_application_model_v2 import record
from test_store import observation


URLS = [
    'https://example.wd1.myworkdayjobs.com/Career_Site_1/job/Place/Data-Engineer-I_R2026001',
    'https://example.wd1.myworkdayjobs.com/Career_Site_1/job/Place/Software-Engineer_R2026002',
]
OLD_ID = stable_id('example.wd1.myworkdayjobs.com:SITE_1')


def legacy(path, review_url='https://example.invalid/old-list', review_state='keep', two_anchors=False):
    with sqlite3.connect(path) as c:
        c.executescript((Path(__file__).parent / 'fixtures' / 'legacy-release-schema.sql').read_text())
        now = time.time()
        c.execute('INSERT INTO jobs VALUES(?,?,?,?)', (OLD_ID, 'example.wd1.myworkdayjobs.com:SITE_1', now-50, now))
        evidence = [{'type': 'official_success', 'reference': URLS[0]}]
        if two_anchors:
            evidence.append({'type': 'official_success', 'reference': URLS[1]})
        c.execute("INSERT INTO applications VALUES(?,'submitted',8,?,'ATS confirmed',?,'original-run')", (OLD_ID, now, json.dumps(evidence)))
        for index, url in enumerate(URLS):
            source = {**observation(url=url), 'source_id': str(index), 'source_url': url}
            c.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,1)', ('simplify:newgrad', str(index), OLD_ID, json.dumps(source), now-50, now))
            c.execute('INSERT INTO search_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                ('simplify:newgrad', str(index), OLD_ID, 'simplify', 'newgrad', '', 'engineer example', 'CA', None, 1, 1, now-1))
        inventory = [{**record(URLS[0]), 'id': 'retained-application-id'}]
        c.execute("INSERT INTO management_documents VALUES('appliedList',?,5)", (json.dumps(inventory),))
        progress = seed_progress('retained-application-id', 'interview', 'owner')
        progress.update(version=2, round=2)
        c.execute('INSERT INTO application_progress VALUES(?,?)', (progress['application_id'], json.dumps(progress)))
        review_evidence = json.dumps([{'url': review_url, 'quote': 'Original review evidence', 'observed_at': '2026-09-20T00:00:00Z'}])
        c.execute('INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (OLD_ID, 'newgrad', review_state, 'manual', 'Old complete review detail', review_evidence, 'old-compound-fingerprint', now-20, now+1000 if review_state == 'trash' else None, 4, 1 if review_state == 'keep' else 0))
        c.execute('INSERT INTO job_role_family VALUES(?,?,?,?,?,?)', (OLD_ID, 'newgrad', 'software_engineering', 'old-compound-fingerprint', review_evidence, now-20))
        c.execute('INSERT INTO web_opened VALUES(?,?,?)', (OLD_ID, 'newgrad', now))
        c.execute('INSERT INTO owner_submission_undo VALUES(?,?,?,?,?)', (OLD_ID, 8, now+500, '{}', '[]'))


def test_split_holds_new_jobs_until_real_rescreen_and_preserves_anchor(tmp_path):
    path = tmp_path / 'old.sqlite'
    legacy(path)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    rehearsal = migrate_path(path)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original
    split = rehearsal['identity_splits'][0]
    assert split['old_job_id'] == OLD_ID and len(split['postings']) == 2
    assert len(split['archived_reviews']) == 2 and len(split['screening_required']) == 2
    migrated = migrate_path(path, dry_run=False)
    assert migrated['identity_splits'] == rehearsal['identity_splits']
    store = Store(path)
    new_id = stable_id(job_key(URLS[1]))
    with store.connect() as c:
        original_app = dict(c.execute('SELECT * FROM applications WHERE job_id=?', (OLD_ID,)).fetchone())
        new_app = dict(c.execute('SELECT * FROM applications WHERE job_id=?', (new_id,)).fetchone())
        assert original_app['status'] == 'submitted' and original_app['version'] == 8
        assert original_app['application_id'] == 'retained-application-id'
        assert json.loads(original_app['progress'])['round'] == 2
        assert original_app['job_key'] == job_key(URLS[0])
        assert new_app['status'] == 'not_started' and new_app['version'] == 0
        assert new_app['record'] is new_app['confirmed_at'] is new_app['attempted_at'] is None
        assert c.execute('SELECT count(*) FROM observations o JOIN search_index s USING(stream,source_id) WHERE o.job_id!=s.job_id').fetchone()[0] == 0
        assert dict(c.execute('SELECT source_id,job_id FROM observations')) == {'0': OLD_ID, '1': new_id}
        assert c.execute('SELECT count(*) FROM web_opened').fetchone()[0] == 0
        assert c.execute('SELECT job_id,version FROM owner_submission_undo').fetchone()[:] == (OLD_ID, 8)
        evidence = [json.loads(row[0]) for row in c.execute("SELECT payload FROM application_events WHERE kind='migration_evidence'")]
        old_review = next(item['row'] for item in evidence if item['table'] == 'job_screening')
        assert old_review['detail'] == 'Old complete review detail' and old_review['manual_keep'] == 1
    sync = ExtensionSync(store)
    assert sync.resolve({'url': URLS[0]})['queue']['reason'] == 'application_history'
    queue = sync.resolve({'url': URLS[1]})['queue']
    assert not queue['allowed'] and queue['reason'] == 'screening_required'
    board = Board(store)
    row = next(row for row in board._rows('newgrad') if row['id'] == new_id)
    assert row['screening'] == 'pending'
    board.review(new_id, 'newgrad', 'keep', '', 'Independent role was re-screened', [], row['fingerprint'], row['review_version'], 'split-screening-approved')
    assert sync.resolve({'url': URLS[1]})['queue']['allowed'] is True
    # A normal never-reviewed source is not retroactively blocked by this fix.
    ordinary = 'https://example.invalid/ordinary'
    store.ingest('simplify:newgrad', [{**observation(url=ordinary), 'source_id': 'ordinary'}], 'later')
    assert sync.resolve({'url': ordinary})['queue']['allowed'] is True


@pytest.mark.parametrize('state', ['keep', 'trash'])
def test_only_uniquely_referenced_review_moves_to_specific_posting(tmp_path, state):
    path = tmp_path / 'old.sqlite'
    legacy(path, review_url=URLS[1], review_state=state)
    report = migrate_path(path, dry_run=False)
    new_id = stable_id(job_key(URLS[1]))
    assert len(report['identity_splits'][0]['moved_reviews']) == 2
    assert report['identity_splits'][0]['archived_reviews'] == []
    store = Store(path)
    with store.connect() as c:
        review = dict(c.execute('SELECT * FROM job_screening WHERE job_id=?', (new_id,)).fetchone())
        assert review['state'] == state
        assert review['manual_keep'] == int(state == 'keep')
        assert review['detail'] == 'Old complete review detail'
        sources = [json.loads(row[0]) for row in c.execute('SELECT payload FROM observations WHERE job_id=?', (new_id,))]
        assert review['fingerprint'] == fingerprint(sources)
    queue = ExtensionSync(store).resolve({'url': URLS[1]})['queue']
    assert queue['allowed'] is (state == 'keep')


@pytest.mark.parametrize('mode', ['two_anchors', 'no_anchor', 'collision'])
def test_ambiguous_or_colliding_splits_rollback_every_table(tmp_path, mode):
    path = tmp_path / 'old.sqlite'
    legacy(path, two_anchors=mode == 'two_anchors')
    with sqlite3.connect(path) as c:
        if mode == 'no_anchor':
            c.execute("UPDATE applications SET evidence='[]'")
        if mode == 'collision':
            c.execute('INSERT INTO jobs VALUES(?,?,0,0)', (stable_id(job_key(URLS[1])), 'pre-existing',))
    with sqlite3.connect(path) as c:
        before = list(c.iterdump())
    with pytest.raises(ValueError, match='evidence anchor|collides'):
        migrate_path(path, dry_run=False)
    with sqlite3.connect(path) as c:
        assert list(c.iterdump()) == before


def test_receipt_url_can_anchor_but_conflicting_receipt_refuses_split(tmp_path):
    path = tmp_path / 'old.sqlite'
    legacy(path)
    with sqlite3.connect(path) as c:
        c.execute("UPDATE applications SET evidence='[]',status='submitted_unconfirmed'")
        c.execute('INSERT INTO extension_receipts VALUES(?,?,?,?,?,?,?,?,?)',
            ('receipt-old', 'device', 'checksum', json.dumps({'job_url': URLS[0]}), 1, 1, 'submitted_unconfirmed', OLD_ID, '{}'))
    report = migrate_path(path, dry_run=True)
    assert report['identity_splits'][0]['anchor_job_key'] == job_key(URLS[0])
    with sqlite3.connect(path) as c:
        c.execute('INSERT INTO extension_receipts VALUES(?,?,?,?,?,?,?,?,?)',
            ('receipt-conflict', 'device', 'checksum', json.dumps({'job_url': URLS[1]}), 1, 1, 'submitted_unconfirmed', OLD_ID, '{}'))
    with pytest.raises(ValueError, match='exactly one evidence anchor'):
        migrate_path(path, dry_run=False)


def test_undo_keeps_guard_snapshot_and_expiry_without_replaying_ambiguous_review(tmp_path):
    path = tmp_path / 'old.sqlite'
    legacy(path)
    with sqlite3.connect(path) as c:
        c.row_factory = sqlite3.Row
        prior_review = dict(c.execute('SELECT * FROM job_screening').fetchone())
        prior_review.update(state='trash', version=3, manual_keep=0)
        original_snapshot = json.dumps(dict(job_id=OLD_ID, status='not_started', version=7,
            updated=12345, detail='before attempt', evidence='[]', owner_run_id=None))
        c.execute('UPDATE owner_submission_undo SET application=?,reviews=?', (original_snapshot, json.dumps([prior_review])))
        original_undo = dict(c.execute('SELECT * FROM owner_submission_undo').fetchone())
    report = migrate_path(path, dry_run=False)
    assert report['identity_splits'][0]['undo_reviews_archived'] == 1
    store = Store(path)
    with store.connect() as c:
        undo = dict(c.execute('SELECT * FROM owner_submission_undo').fetchone())
        assert {key: undo[key] for key in undo if key != 'reviews'} == {key: original_undo[key] for key in original_undo if key != 'reviews'}
        assert json.loads(undo['reviews']) == []
        archived = [json.loads(row[0]) for row in c.execute("SELECT payload FROM application_events WHERE kind='migration_evidence'")]
        assert next(item['row'] for item in archived if item['table'] == 'owner_submission_undo') == original_undo
    result = Board(store).undo_submitted(OLD_ID, 8, 'checked-original-undo')
    assert result['status'] == 'not_started'
    with store.connect() as c:
        assert c.execute('SELECT state FROM job_screening WHERE job_id=?', (OLD_ID,)).fetchone()[0] == 'pending'
    assert ExtensionSync(store).resolve({'url': URLS[0]})['queue']['reason'] == 'screening_required'


@pytest.mark.parametrize('reference', ['alias', 'unknown_table'])
def test_unreviewed_non_application_references_stop_migration(tmp_path, reference):
    path = tmp_path / 'old.sqlite'
    legacy(path)
    with sqlite3.connect(path) as c:
        if reference == 'alias':
            c.execute("INSERT INTO job_aliases VALUES('alias',?,0)", (OLD_ID,))
        else:
            c.execute('CREATE TABLE unexpected_reference(job_id TEXT)')
            c.execute('INSERT INTO unexpected_reference VALUES(?)', (OLD_ID,))
    with pytest.raises(ValueError, match='alias review|unreviewed reference table'):
        migrate_path(path, dry_run=False)
