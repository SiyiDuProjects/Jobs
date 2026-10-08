import json
import time

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.board import Board
from test_application_model_v2 import model, receipt


def old_native_record(store, sync, device, *, proof='submit_attempt'):
    event=receipt(proof)
    result=sync.receive(device,event)
    with store.connect(True) as c:
        # Reproduce the persisted state from 283e939, not a new submission.
        c.execute("UPDATE applications SET status='submitted_unconfirmed',detail='已尝试提交，尚无网站确认' WHERE job_id=?",(result['job_id'],))
    return result['job_id'], event




def test_tracker_after_explicit_error_restores_native_result_without_receipt(model):
    store,sync,device=model
    sync.receive(device,receipt())
    sync.receive(device,receipt('submit_validation_error',detail='Synthetic field rejection'))
    result=sync.receive(device,receipt('tracker_record'))
    assert result['state']=='submitted'
    row=ApplicationRecords(store).list()['applications'][0]
    assert row['submission']['error'] is None
    assert row['submission']['confirmed_at'] is None






