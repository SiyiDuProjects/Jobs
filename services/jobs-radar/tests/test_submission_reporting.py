
from jobs_radar.application_records import ApplicationRecords
from test_application_model_v2 import model as model, receipt


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


def test_attempt_confirmation_and_error_labels_agree_across_list_and_resolve(model):
    store,sync,device=model
    attempt=receipt()
    sync.receive(device,attempt)
    def check(label):
        listed=ApplicationRecords(store).list()['applications'][0]['submission']
        resolved=sync.resolve({'url':attempt['job_url']})['application']
        assert listed['label']==resolved['label']==label
        assert listed['confirmed']==resolved['confirmed']
    check('已尝试提交')
    error={**receipt('submit_validation_error'), 'event_id':attempt['event_id']+'-validation'}
    sync.receive(device,error)
    check('提交后报错，待核实')
    sync.receive(device,receipt('ats_confirmation'))
    check('网站已确认')
    # Late attempts/errors cannot demote a confirmed receipt.
    sync.receive(device,receipt('submit_attempt'))
    sync.receive(device,receipt('submit_validation_error'))
    check('网站已确认')






