import json
import time

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.board import Board
from jobs_radar.submission_reporting_migration import migrate, VERSION
from test_application_model_v2 import model, receipt


def old_native_record(store, sync, device, *, proof='submit_attempt'):
    event=receipt(proof)
    result=sync.receive(device,event)
    with store.connect(True) as c:
        # Reproduce the persisted state from 283e939, not a new submission.
        c.execute("UPDATE applications SET status='submitted_unconfirmed',detail='已尝试提交，尚无网站确认' WHERE job_id=?",(result['job_id'],))
    return result['job_id'], event


def test_restore_native_records_preserves_facts_progress_and_undo(model):
    store,sync,device=model
    jid,event=old_native_record(store,sync,device)
    with store.connect(True) as c:
        before=dict(c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone())
        result=migrate(c)
        after=dict(c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone())
        assert result['job_ids']==[jid] and result['changed']==1
        for key in ('application_id','record','record_version','progress','evidence','attempted_at','confirmed_at'):
            assert after[key]==before[key]
        assert after['status']=='submitted' and after['confirmed_at'] is None
        assert migrate(c)['already_applied']
    board=Board(store).list(status='submitted')
    assert board['application_counts']['submitted']==1
    assert board['jobs'][0]['can_undo_submission']
    # The original transport replay cannot undo repaired state or fabricate proof.
    sync.receive(device,event)
    assert store.get_jobs([jid])[0]['status']=='submitted'
    Board(store).undo_submitted(jid,after['version'],'undo-restored-native')
    assert store.get_jobs([jid])[0]['status']=='not_started'


def test_tracker_after_explicit_error_restores_native_result_without_receipt(model):
    store,sync,device=model
    sync.receive(device,receipt())
    sync.receive(device,receipt('submit_validation_error',detail='Synthetic field rejection'))
    result=sync.receive(device,receipt('tracker_record'))
    assert result['state']=='submitted'
    row=ApplicationRecords(store).list()['applications'][0]
    assert row['submission']['error'] is None
    assert row['submission']['confirmed_at'] is None


def test_migration_skips_error_deleted_and_owner_undone_records(model):
    store,sync,device=model
    jid,event=old_native_record(store,sync,device)
    with store.connect(True) as c:
        for column,value in [('submission_error','Synthetic rejection'),('deleted',1)]:
            c.execute(f'UPDATE applications SET {column}=? WHERE job_id=?',(value,jid))
            assert migrate(c)['changed']==0
            c.execute('DELETE FROM schema_migrations WHERE name=?',(VERSION,))
            c.execute(f'UPDATE applications SET {column}=? WHERE job_id=?',(None if column=='submission_error' else 0,jid))
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'owner_submission_undo','owner',?,'{}')",(jid,time.time()+1))
        assert migrate(c)['changed']==0
        assert c.execute('SELECT status FROM applications WHERE job_id=?',(jid,)).fetchone()[0]=='submitted_unconfirmed'


def test_migration_requires_native_evidence_not_arbitrary_pending_status(model):
    store,sync,device=model
    jid,event=old_native_record(store,sync,device)
    with store.connect(True) as c:
        c.execute("UPDATE applications SET evidence='[]' WHERE job_id=?",(jid,))
        assert migrate(c)['changed']==0


def test_release_dryrun_does_not_change_live_native_records(model):
    from test_release_migration import implementation
    store,sync,device=model
    jid,event=old_native_record(store,sync,device)
    runner=implementation()
    assert runner.migrate(store.path)['submissionReporting']['changed']==1
    assert store.get_jobs([jid])[0]['status']=='submitted_unconfirmed'
    assert runner.migrate(store.path,dry_run=False)['submissionReporting']['changed']==1
    assert store.get_jobs([jid])[0]['status']=='submitted'
