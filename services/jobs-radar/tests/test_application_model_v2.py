import hashlib
import json
import sqlite3
import time
import uuid
from datetime import datetime, timezone

import pytest

from jobs_radar.application_records import ApplicationRecords, read
from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.application_schema import migrate_path
from jobs_radar.board import Board
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.management import Management
from jobs_radar.profiles import ProfileConflict
from jobs_radar.store import Store
from test_store import observation


def record(url=None):
    return dict(jobTitle='Software Engineer',jobLink=url or observation()['apply_url'],
                companyName='Example',companyLink='',date=datetime.now(timezone.utc).isoformat(),
                status='applied',profileName='Newgrad')


@pytest.fixture
def model(tmp_path):
    store=Store(tmp_path/'model.sqlite')
    store.ingest('simplify:newgrad',[observation()],'test')
    sync=ExtensionSync(store);device=str(uuid.uuid4());sync.pair(device,EXTENSION_ID)
    return store,sync,device


def receipt(proof='submit_attempt', **values):
    return dict(event_id=str(uuid.uuid4()),job_url=observation()['apply_url'],job_title='Software Engineer',
                company='Example',observed_at=datetime.now(timezone.utc).isoformat(),proof=proof,**values)


def test_attempt_error_confirmation_are_distinct_and_never_requeue(model):
    store,sync,device=model
    attempt=receipt();first=sync.receive(device,attempt)
    assert first['state']=='submitted'
    assert sync.receive(device,attempt)==first
    assert Board(store).list(status='unsubmitted')['jobs']==[]
    assert not sync.resolve({'url':attempt['job_url']})['queue']['allowed']
    error=sync.receive(device,receipt('submit_validation_error',detail='Required field was rejected'))
    row=ApplicationRecords(store).list()['applications'][0]
    assert row['submission']['confirmed_at'] is None
    assert row['submission']['error']=='Required field was rejected'
    assert row['submission']['status']=='submitted_unconfirmed'
    assert error['retryable'] is False
    assert Board(store).list(status='unsubmitted')['jobs']==[]
    sync.receive(device,receipt('ats_confirmation'))
    row=ApplicationRecords(store).list()['applications'][0]
    assert row['submission']['attempted_at'] and row['submission']['confirmed_at']
    assert row['submission']['error'] is None
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='extension'").fetchone()[0]==3


def test_pre_submit_validation_cannot_manufacture_attempt(model):
    store,sync,device=model
    with pytest.raises(ValueError,match='follow'):
        sync.receive(device,receipt('submit_validation_error'))
    with store.connect() as c:
        assert c.execute("SELECT status FROM applications").fetchone()[0]=='not_started'
        assert c.execute('SELECT count(*) FROM application_events').fetchone()[0]==0


def test_row_edit_conflict_and_delete_preserve_submission(model):
    store,sync,device=model
    sync.receive(device,receipt())
    rows=ApplicationRecords(store);row=rows.list()['applications'][0]
    edited={**row,'jobTitle':'Edited title'}
    change=dict(action='update',application_id=row['id'],expected_version=row['version'],value=edited)
    result=rows.mutate([change],'edit-once')
    assert rows.mutate([change],'edit-once')==result
    with pytest.raises(ProfileConflict):rows.mutate([change],'stale-edit')
    fresh=rows.list()['applications'][0]
    rows.mutate([dict(action='delete',application_id=fresh['id'],expected_version=fresh['version'])],'delete-record')
    assert rows.list()['applications']==[]
    assert Board(store).list(status='unsubmitted')['jobs']==[]
    assert not sync.resolve({'url':row['jobLink']})['queue']['allowed']


def test_whole_document_write_is_rejected(model):
    store,_,_=model
    with pytest.raises(ValueError,match='Unsupported'):
        Management(store).write([dict(key='appliedList',value=[record()],revision=0)])


def test_external_record_attaches_on_later_ingestion_without_changing_id(model):
    store,sync,device=model
    url='https://jobs.lever.co/other/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    event={**receipt(), 'job_url':url}
    result=sync.receive(device,event)
    aid=result['application_id']
    store.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=url)],'later')
    row=next(r for r in ApplicationRecords(store).list()['applications'] if r['id']==aid)
    assert not row['job_id'].startswith('external:')
    assert sync.receive(device,event)==result
    assert not sync.resolve({'url':url})['queue']['allowed']


def test_owner_undo_blocks_old_distinct_receipt(model):
    store,sync,device=model
    first=receipt('ats_confirmation');result=sync.receive(device,first)
    Board(store).undo_submitted(result['job_id'],1,'undo-receipt')
    stale=sync.receive(device,{**first,'event_id':str(uuid.uuid4())})
    assert stale['state']=='ignored_after_undo'
    assert store.get_jobs([result['job_id']])[0]['status']=='not_started'
    assert ApplicationRecords(store).list()['applications']==[]


def test_metadata_edit_does_not_replace_recruiting_progress(model):
    store,sync,device=model
    sync.receive(device,receipt('ats_confirmation'))
    rows=ApplicationRecords(store);row=rows.list()['applications'][0]
    ApplicationProgress(store).update(row['id'],'interview',0,'interview-progress','Confirmed first interview',interview_round=1)
    rows.mutate([dict(action='update',application_id=row['id'],expected_version=row['version'],value={**row,'jobTitle':'Changed'})],'edit-title')
    fresh=rows.list()['applications'][0]
    assert fresh['status']=='interview'
    assert fresh['progress']['next_stages']['next_interview']=='下一轮面试'
    assert fresh['progress']['label']=='Interview · 第 1 轮'


def legacy_database(path):
    store=Store(path)
    store.ingest('simplify:newgrad',[observation()],'old')
    jid=store.search()['jobs'][0]['id']
    with store.connect(True) as c:
        c.execute('DELETE FROM schema_migrations')
        c.execute('CREATE TABLE management_documents(key TEXT PRIMARY KEY,value TEXT,revision INTEGER)')
        c.execute("INSERT INTO management_documents VALUES('appliedList',?,4)",(json.dumps([{**record(),'id':'old-record'}]),))
        c.execute('CREATE TABLE claims(job_id TEXT PRIMARY KEY,lease_id TEXT,owner TEXT,expires REAL,fence INTEGER)')
        c.execute('INSERT INTO claims VALUES(?,?,?,?,?)',(jid,'old-lease','old-owner',time.time()+100,9))
        c.execute('CREATE TABLE recruiting_events(mailbox TEXT,message_id TEXT,job_id TEXT,stage TEXT,received_at REAL,summary TEXT,match_reason TEXT,created REAL,applied INTEGER,application_before TEXT)')
        c.execute('INSERT INTO recruiting_events VALUES(?,?,?,?,?,?,?,?,?,?)',('test@example.test','123456789abcdef',jid,'received',time.time(),'Receipt','Exact role',time.time(),1,'{}'))
    return jid


def test_migration_is_explicit_lossless_dry_run_and_idempotent(tmp_path):
    path=tmp_path/'old.sqlite';jid=legacy_database(path)
    before=hashlib.sha256(path.read_bytes()).hexdigest()
    report=migrate_path(path,dry_run=True)
    assert report['dry_run'] and report['source_counts']['claims']==1
    assert hashlib.sha256(path.read_bytes()).hexdigest()==before
    with pytest.raises(ValueError,match='migration required'):Store(path)
    applied=migrate_path(path,dry_run=False)
    assert not applied['dry_run']
    store=Store(path)
    with store.connect() as c:
        tables={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert not {'claims','historical','recruiting_events','application_progress','extension_receipts'} & tables
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='migration_evidence'").fetchone()[0]==3
        assert c.execute("SELECT count(*) FROM management_documents WHERE key='appliedList'").fetchone()[0]==0
        app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        assert app['application_id']=='old-record'
        assert app['status']=='submitted_unconfirmed' and app['confirmed_at'] is None
    assert migrate_path(path,dry_run=False)['already_applied']


def test_migration_failure_rolls_back_all_changes(tmp_path):
    path=tmp_path/'invalid.sqlite';legacy_database(path)
    with sqlite3.connect(path) as c:
        c.execute("UPDATE management_documents SET value=?",(json.dumps([{'invalid':'record'}]),))
    with pytest.raises(ValueError,match='Invalid application record'):migrate_path(path,dry_run=False)
    with sqlite3.connect(path) as c:
        assert c.execute('SELECT count(*) FROM claims').fetchone()[0]==1
        assert c.execute('SELECT count(*) FROM schema_migrations').fetchone()[0]==0
        assert c.execute('SELECT count(*) FROM application_events').fetchone()[0]==0


def test_original_schema_columns_pending_reviews_and_cleanup(tmp_path):
    path=tmp_path/'original.sqlite';legacy_database(path)
    with sqlite3.connect(path) as c:
        c.execute('CREATE TABLE original_applications AS SELECT job_id,status,version,updated,detail,evidence,owner_run_id FROM applications')
        c.execute('DROP TABLE applications')
        c.execute('ALTER TABLE original_applications RENAME TO applications')
        c.execute('CREATE TABLE original_jobs AS SELECT id,identity,first_seen,last_seen FROM jobs')
        c.execute('DROP TABLE jobs')
        c.execute('ALTER TABLE original_jobs RENAME TO jobs')
        c.execute('CREATE TABLE application_progress_pending(job_id TEXT PRIMARY KEY,payload TEXT)')
        c.execute('INSERT INTO application_progress_pending VALUES(?,?)',('email:pending',json.dumps({'job_id':'email:pending','stage':'interview','message_id':'123456789abc','candidates':[]})))
    migrate_path(path,dry_run=True)
    assert list(tmp_path.glob('.applications-migration-*'))==[]
    migrate_path(path,dry_run=False)
    store=Store(path)
    assert ApplicationProgress(store).list()['unresolved_matches'][0]['message_id']=='123456789abc'
    with store.connect() as c:
        assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='application_progress_pending'").fetchone()


def test_concurrent_event_replay_has_one_effect(model):
    from concurrent.futures import ThreadPoolExecutor
    store,sync,device=model;event=receipt()
    with ThreadPoolExecutor(2) as executor:
        results=list(executor.map(lambda _:sync.receive(device,event),range(2)))
    assert results[0]==results[1]
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='extension'").fetchone()[0]==1
        assert c.execute('SELECT version FROM applications').fetchone()[0]==1


def test_event_append_failure_rolls_back_state(model):
    store,sync,device=model
    with store.connect(True) as c:
        c.execute("CREATE TRIGGER fail_event BEFORE INSERT ON application_events WHEN NEW.kind='extension' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END")
    with pytest.raises(sqlite3.IntegrityError,match='disk failure'):sync.receive(device,receipt())
    with store.connect() as c:
        row=c.execute('SELECT * FROM applications').fetchone()
        assert row['status']=='not_started' and row['attempted_at'] is None and row['record'] is None
        assert c.execute('SELECT count(*) FROM application_events').fetchone()[0]==0


def test_delayed_attempt_cannot_downgrade_confirmation(model):
    store,sync,device=model
    sync.receive(device,receipt('ats_confirmation'))
    sync.receive(device,receipt())
    row=ApplicationRecords(store).list()['applications'][0]
    assert row['submission']['status']=='submitted' and row['submission']['confirmed_at']


def test_runtime_state_writers_are_centralized():
    import re
    from pathlib import Path
    root=Path(__file__).parents[1]/'jobs_radar'
    for path in root.glob('*.py'):
        # Explicit transactional migrations are not runtime lifecycle writers.
        if path.name in {'application_records.py','application_schema.py','migration_duplicate_records.py'}:continue
        assert not re.search(r'UPDATE applications SET[^\n]*(?:status|progress)\s*=',path.read_text(encoding='utf-8')),path.name


def test_mail_cannot_create_a_record_or_change_unrelated_record_version(model):
    store,sync,device=model
    first=sync.receive(device,receipt())
    before=ApplicationRecords(store).list()['applications'][0]
    other={**observation(url='https://jobs.lever.co/example/another'),'source_id':'second'}
    store.ingest('simplify:newgrad',[observation(),other],'test')
    with store.connect() as c:
        jid=c.execute('SELECT job_id FROM observations WHERE source_id=?',('second',)).fetchone()[0]
    with pytest.raises(ValueError,match='Application not found'):
        ApplicationProgress(store).update(jid,'interview',0,'mail-for-unapplied-job','Synthetic email',
            source='email',reference='aaaaaaaaaaaa0001',observed_at=datetime.now(timezone.utc).isoformat())
    with store.connect() as c:
        app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        assert app['record'] is None and app['attempted_at'] is None and app['confirmed_at'] is None
    after=next(row for row in ApplicationRecords(store).list()['applications'] if row['id']==before['id'])
    assert after==before


@pytest.mark.parametrize('old_state',['unmatched','held','needs_confirmation','recorded'])
def test_migrated_pending_receipt_resolves_once_without_claims(model,old_state):
    store,sync,device=model;p=receipt('ats_confirmation')
    raw=json.dumps(p,sort_keys=True,separators=(',',':'));checksum=hashlib.sha256(raw.encode()).hexdigest()
    with store.connect(True) as c:
        c.execute("INSERT INTO application_events(event_key,kind,payload,created,device_id,checksum,state,result) VALUES(?,'extension',?,?,?,?,?,?)",
            (p['event_id'],raw,time.time(),device,checksum,old_state,json.dumps({'state':old_state})))
    result=sync.receive(device,p)
    assert result['state']=='submitted'
    assert sync.receive(device,p)==result
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='extension'").fetchone()[0]==1
        assert c.execute('SELECT version FROM applications').fetchone()[0]==1


def test_migrated_pending_receipt_still_respects_owner_undo(model):
    store,sync,device=model;p=receipt('ats_confirmation')
    first=sync.receive(device,receipt('ats_confirmation'))
    Board(store).undo_submitted(first['job_id'],1,'undo-before-migrated-replay')
    raw=json.dumps(p,sort_keys=True,separators=(',',':'));checksum=hashlib.sha256(raw.encode()).hexdigest()
    with store.connect(True) as c:
        c.execute("INSERT INTO application_events(event_key,kind,payload,created,device_id,checksum,state,result) VALUES(?,'extension',?,?,?,?,?,?)",
            (p['event_id'],raw,time.time(),device,checksum,'held',json.dumps({'state':'held'})))
    assert sync.receive(device,p)['state']=='ignored_after_undo'
    with store.connect() as c:
        assert c.execute('SELECT status FROM applications').fetchone()[0]=='not_started'
