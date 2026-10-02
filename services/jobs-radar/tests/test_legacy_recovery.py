"""First-v2 recovery preserves later writes without enabling the old writer."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

import pytest

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from test_application_model_v2 import receipt
from test_profiles import profile
from test_store import observation


DEPLOY = Path(__file__).parents[1] / 'deploy'


def load(name):
    sys.path.insert(0, str(DEPLOY))
    try:
        spec = importlib.util.spec_from_file_location(name, DEPLOY / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


recovery = load('recover_legacy')
migration = load('migrate_release')


@pytest.fixture
def databases(tmp_path):
    prechange, current = tmp_path / 'prechange.sqlite', tmp_path / 'current.sqlite'
    with sqlite3.connect(prechange) as db:
        db.executescript((Path(__file__).parent / 'fixtures' / 'legacy-release-schema.sql').read_text())
        db.execute("INSERT INTO management_documents VALUES('appliedList','[]',5)")
        db.execute("INSERT INTO management_documents VALUES('settings','{\"automatic\":false}',2)")
        db.execute("INSERT INTO oauth_tokens VALUES('revoked-after-migration','access','{}',99999999999,'family')")
        db.execute("INSERT INTO claims VALUES('old-job','old-lease','old-owner',99999999999,3)")
        db.execute("INSERT INTO claim_purposes VALUES('old-job','apply')")
        db.execute("INSERT INTO historical VALUES('https://example.invalid/historic','submitted_unconfirmed','old receipt')")
        db.commit()
        with sqlite3.connect(current) as copy:
            db.backup(copy)
    migration.migrate(current, dry_run=False)
    store = Store(current)
    profiles = Profiles(store)
    saved = profiles.save(profile('Before edit'))
    changed = profile('After migration')
    changed['resumeData'] = {'resumeBase64': base64.b64encode(b'%PDF-1.7\n' + b'0' * 1015).decode(), 'fileSize': 1, 'fileName': 'fixture.pdf'}
    saved = profiles.save(changed, profile_id=saved['id'], expected_sync=saved['last_sync'])
    deleted = profiles.save(profile('Later deleted'))
    profiles.delete(deleted['id'], expected_sync=deleted['last_sync'])
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    urls = ['https://job-boards.greenhouse.io/example/jobs/' + str(number) for number in (10001, 10002, 10003)]
    store.ingest('simplify:newgrad', [{**observation(url=url), 'source_id': str(index)} for index, url in enumerate(urls)], 'new collection')
    confirmed = sync.receive(device, {**receipt('ats_confirmation'), 'job_url': urls[0]})
    ApplicationProgress(store).update(confirmed['application_id'], 'interview', 0, 'interview-after-migration', 'Recorded interview', interview_round=2)
    unknown = sync.receive(device, {**receipt('submit_attempt'), 'job_url': urls[1]})
    sync.receive(device, {**receipt('submit_validation_error', detail='Page rejected a required answer'), 'job_url': urls[1]})
    removed = sync.receive(device, {**receipt('ats_confirmation'), 'job_url': urls[2]})
    records = ApplicationRecords(store)
    removed_row = next(row for row in records.list()['applications'] if row['id'] == removed['application_id'])
    records.mutate([dict(action='delete', application_id=removed_row['id'], expected_version=removed_row['version'])], 'delete-after-migration')
    ApplicationProgress(store).record_pending_email('abcdef1234567890', time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime()),
        'Example', 'interview', 'Exact role still requires matching', candidate_ids=[confirmed['application_id']])
    with store.connect(True) as db:
        db.execute("DELETE FROM oauth_tokens WHERE hash='revoked-after-migration'")
        db.execute("INSERT INTO oauth_tokens VALUES('new-grant','access','{}',99999999999,'new-family')")
        db.execute("UPDATE management_documents SET value='{\"automatic\":true}',revision=3 WHERE key='settings'")
        db.execute("INSERT INTO browser_control_sessions VALUES('device','session',1,1,'[]')")
        db.execute("INSERT INTO browser_control_commands VALUES('queued','device','session',1,0,'doc',1,'click','{}','h','queued',1,99999999999,NULL,NULL)")
        db.execute("INSERT INTO browser_control_commands VALUES('sent','device','session',1,0,'doc',1,'click','{}','h','dispatched',1,99999999999,2,NULL)")
        db.execute("INSERT INTO browser_diagnostic_history VALUES('new-history','device','https://example.invalid/job',1,2,?)", (json.dumps({'schemaVersion': 2, 'runId': 'after-migration'}),))
    return dict(prechange=prechange, current=current, store=store, confirmed=confirmed,
                unknown=unknown, removed=removed, profile=saved, deleted_profile=deleted)


def test_offline_candidate_preserves_new_writes_and_never_resurrects_old_rows(databases, tmp_path):
    data = databases
    before = {name: recovery.fingerprint(data[name]) for name in ('prechange', 'current')}
    bundle = tmp_path / 'recovery'
    report = recovery.recover(data['prechange'], data['current'], bundle)
    assert report['mode'] == 'offline-only' and not report['onlineRollbackReady']
    assert recovery.fingerprint(bundle / 'current-v2.sqlite') == before['current']
    assert {name: recovery.fingerprint(data[name]) for name in before} == before
    assert report['applicationProjection'] == dict(confirmedRecords=1, heldUnknownRecords=1, deletedRecords=1, heldExternalRecords=0)
    assert report['eventKinds']['extension'] == 4
    assert report['archivedOnlyTables']['application_events'] > 4
    assert 'After migration' not in json.dumps(report) and 'Page rejected' not in json.dumps(report)
    with sqlite3.connect(bundle / 'candidate.sqlite') as db:
        assert db.execute("SELECT hash FROM oauth_tokens").fetchall() == [('new-grant',)]
        assert db.execute("SELECT value,revision FROM management_documents WHERE key='settings'").fetchone() == ('{"automatic":true}', 3)
        assert json.loads(db.execute('SELECT profile FROM owner_profiles WHERE id=?', (data['profile']['id'],)).fetchone()[0])['profileName'] == 'After migration'
        assert db.execute('SELECT deleted FROM owner_profiles WHERE id=?', (data['deleted_profile']['id'],)).fetchone()[0] == 1
        assert db.execute('SELECT count(*) FROM owner_profile_revisions').fetchone()[0] >= 1
        assert db.execute('SELECT count(*) FROM claims').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM owner_submission_undo').fetchone()[0] == 0
        assert db.execute('SELECT active FROM browser_control_sessions').fetchone()[0] == 0
        assert dict(db.execute('SELECT id,state FROM browser_control_commands')) == {'queued': 'cancelled', 'sent': 'unknown'}
        inventory = json.loads(db.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()[0])
        assert [row['id'] for row in inventory] == [data['confirmed']['application_id']]
        assert inventory[0]['status'] == 'interview'
        assert db.execute('SELECT status FROM applications WHERE job_id=?', (data['unknown']['job_id'],)).fetchone()[0] == 'submitted_unconfirmed'
        assert db.execute('SELECT count(*) FROM application_progress_events').fetchone()[0] == 1
        assert db.execute('SELECT count(*) FROM application_progress_pending').fetchone()[0] == 1
        assert db.execute('SELECT count(*) FROM extension_receipts').fetchone()[0] == 4
        assert len(db.execute('PRAGMA table_info(jobs)').fetchall()) == 4
        assert len(db.execute('PRAGMA table_info(applications)').fetchall()) == 7


def test_old_application_mutations_are_frozen_but_profile_settings_writes_work(databases, tmp_path):
    data = databases
    bundle = tmp_path / 'recovery'
    recovery.recover(data['prechange'], data['current'], bundle)
    with sqlite3.connect(bundle / 'candidate.sqlite') as db:
        for sql in ["UPDATE applications SET status='submitted'", 'DELETE FROM applications',
                    "INSERT INTO claims VALUES('x','lease','owner',99999999999,1)",
                    "UPDATE management_documents SET value='[]' WHERE key='appliedList'",
                    "UPDATE management_documents SET key='renamed' WHERE key='appliedList'",
                    "DELETE FROM management_documents WHERE key='appliedList'",
                    "INSERT INTO management_revisions VALUES('appliedList',9,'[]',0)"]:
            with pytest.raises(sqlite3.IntegrityError, match='Offline recovery'):
                db.execute(sql)
        db.execute("UPDATE management_documents SET value='{\"automatic\":false}' WHERE key='settings'")
        db.execute("UPDATE owner_profiles SET last_sync='offline-edit' WHERE deleted=0")
    assert recovery.fingerprint(bundle / 'current-v2.sqlite') == recovery.fingerprint(data['current'])


def test_unreviewed_schema_change_fails_after_verified_backup_without_candidate(databases, tmp_path):
    data = databases
    with sqlite3.connect(data['current']) as db:
        db.execute('ALTER TABLE oauth_tokens ADD COLUMN unreviewed TEXT')
    before = recovery.fingerprint(data['current'])
    bundle = tmp_path / 'failed-recovery'
    with pytest.raises(ValueError, match='Unreviewed schema difference: oauth_tokens'):
        recovery.recover(data['prechange'], data['current'], bundle)
    assert recovery.fingerprint(bundle / 'current-v2.sqlite') == before
    assert (bundle / 'FAILED').is_file()
    assert not (bundle / 'candidate.sqlite').exists()


def test_existing_bundle_and_same_input_are_refused(databases, tmp_path):
    bundle = tmp_path / 'existing'
    bundle.mkdir()
    marker = bundle / 'keep'
    marker.write_text('keep')
    with pytest.raises(FileExistsError):
        recovery.recover(databases['prechange'], databases['current'], bundle)
    with pytest.raises(ValueError, match='Separate'):
        recovery.recover(databases['current'], databases['current'], tmp_path / 'same')
    assert marker.read_text() == 'keep'


def test_backup_includes_uncheckpointed_wal(databases, tmp_path):
    # Hold a reader so SQLite cannot collapse the later write into the main file.
    path = databases['current']
    with sqlite3.connect(path) as writer, sqlite3.connect(path) as reader:
        writer.execute('PRAGMA journal_mode=WAL')
        reader.execute('BEGIN')
        reader.execute('SELECT * FROM oauth_tokens').fetchall()
        writer.execute("INSERT INTO oauth_tokens VALUES('wal-grant','access','{}',99999999999,'wal-family')")
        writer.commit()
        assert Path(str(path) + '-wal').stat().st_size > 0
        bundle = tmp_path / 'wal-recovery'
        recovery.recover(databases['prechange'], path, bundle)
        with sqlite3.connect(bundle / 'candidate.sqlite') as restored:
            assert restored.execute("SELECT count(*) FROM oauth_tokens WHERE hash='wal-grant'").fetchone()[0] == 1


def test_mail_and_external_unknown_projection_preserves_proof_without_confirmation(databases, tmp_path):
    data = databases
    store = data['store']
    mailbox = 'synthetic@example.invalid'
    with store.connect(True) as db:
        db.execute('INSERT INTO recruiting_sync VALUES(?,NULL,?)', (mailbox, 'fixture mailbox'))
        app = dict(db.execute('SELECT * FROM applications WHERE job_id=?', (data['confirmed']['job_id'],)).fetchone())
        # Historical evidence remains recoverable after the mail-confirmation
        # runtime writer is removed. Seed the exact old event shape explicitly.
        legacy_mail = dict(mailbox=mailbox,message_id='1111aaaabbbb2222',job_id=app['job_id'],
            stage='offer',received_at=time.time(),summary='Recorded offer',match_reason='Exact application identity',
            created=time.time(),applied=True,application_before=app)
        db.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,'mail',?,?)",
            ('mail:'+mailbox+':1111aaaabbbb2222',app['application_id'],app['job_id'],json.dumps(legacy_mail),legacy_mail['created']))
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    external = sync.receive(device, {**receipt('submit_attempt'), 'job_url': 'https://jobs.lever.co/outside/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})
    bundle = tmp_path / 'mail-recovery'
    report = recovery.recover(data['prechange'], data['current'], bundle)
    assert report['applicationProjection']['heldExternalRecords'] == 1
    with sqlite3.connect(bundle / 'candidate.sqlite') as db:
        stored = db.execute('SELECT mailbox,message_id,application_before FROM recruiting_events').fetchone()
        assert stored[:2] == (mailbox, '1111aaaabbbb2222')
        assert set(json.loads(stored[2])) == set(recovery.LEGACY_APPLICATION_COLUMNS)
        assert db.execute('SELECT status FROM applications WHERE job_id=?', (external['job_id'],)).fetchone()[0] == 'submitted_unconfirmed'
        assert external['application_id'] not in db.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()[0]


def test_actual_old_runtime_reads_candidate_and_writes_only_non_application_data(databases, tmp_path):
    # This optional acceptance runs the actual archived release, not a retyped
    # reader. CI can run the five deterministic tests without the old runtime.
    legacy = os.environ.get('JOBS_LEGACY_REHEARSAL_SOURCE')
    python = os.environ.get('JOBS_LEGACY_REHEARSAL_PYTHON')
    if not legacy or not python:
        pytest.skip('Actual old release runtime supplied during offline acceptance')
    bundle = tmp_path / 'old-runtime'
    recovery.recover(databases['prechange'], databases['current'], bundle)
    before = recovery.fingerprint(bundle / 'candidate.sqlite')
    result = subprocess.run([python, '-X', 'utf8', str(DEPLOY / 'verify_legacy_recovery.py'), str(bundle)],
        env={**os.environ, 'PYTHONPATH': legacy}, cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    result = json.loads(result.stdout)
    assert result['oldRuntime'] == result['nonApplicationWrites'] == result['applicationWriteGuard'] == 'passed'
    assert result['confirmedRecords'] == result['profilesRead'] == 1
    assert not result['onlineRollbackReady']
    assert recovery.fingerprint(bundle / 'candidate.sqlite') == before
    assert not list(bundle.glob('old-runtime-check-*'))
    assert recovery.fingerprint(bundle / 'current-v2.sqlite') == recovery.fingerprint(databases['current'])
