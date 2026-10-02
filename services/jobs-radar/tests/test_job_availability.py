import json
import time
import uuid
from datetime import datetime, timezone

import pytest
from jobs_radar.board import Board
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.job_availability import JobAvailability
from jobs_radar.store import Store
from test_store import observation

URL='https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Test/Engineer_R123'


@pytest.fixture
def setup(tmp_path):
    store=Store(tmp_path/'availability.sqlite')
    store.ingest('simplify:newgrad',[observation(url=URL)],'availability')
    device=str(uuid.uuid4());sync=ExtensionSync(store);sync.pair(device,EXTENSION_ID)
    jid=store.search()['jobs'][0]['id']
    return store,sync,device,jid


def payload(**kw):
    return dict(event_id=str(uuid.uuid4()),proof='ats_unavailable',job_url=URL,
        observed_at=datetime.now(timezone.utc).isoformat(),code='page_missing',
        quote="The page you are looking for doesn't exist.",**kw)


def undo(event):
    return dict(event_id=str(uuid.uuid4()),proof='undo_unavailable',removal_event=event)


def manual():
    return {**payload(), 'proof':'manual_remove', 'code':'manual', 'quote':'用户在插件中手动删除岗位'}


def test_manual_delete_is_exact_idempotent_and_restorable_without_terminal_text(setup):
    store,sync,device,jid=setup
    wrong={**manual(),'job_url':URL.replace('R123','R124'),'website_job_id':jid}
    assert sync.receive(device,wrong)['state']=='unmatched'
    p={**manual(),'detail':'岗位方向不匹配：产品管理和数据分析'};result=sync.receive(device,p)
    assert result['state']=='removed' and result['removal_reason']=='manual'
    assert result['removal_detail']==p['detail']
    assert Board(store).list(view='trash')['jobs'][0]['review']['detail']==p['detail']
    assert sync.receive(device,p)==result
    assert Board(store).list()['total']==0 and store.search()['jobs']==[]
    store.ingest('simplify:newgrad',[observation(url=URL)],'manual-reimport')
    assert store.search()['jobs']==[]
    assert sync.receive(device,undo(p['event_id']))['state']=='restored'
    assert Board(store).list()['total']==1
    # Owner may explicitly delete again after restoring; passive detection may not.
    assert sync.receive(device,payload())['reason']=='manually_kept'
    assert sync.receive(device,manual())['state']=='removed'
    assert store.get_jobs([jid])[0]['status']=='not_started'


def test_legacy_source_aliases_delete_and_restore_together(tmp_path):
    from test_job_duplicates import legacy_pair, URL as SOURCE
    store=Store(tmp_path/'aliases.db');ids=legacy_pair(store)
    sync=ExtensionSync(store);device=str(uuid.uuid4());sync.pair(device,EXTENSION_ID)
    p={**manual(),'job_url':SOURCE+'/apply/applyManually','website_job_id':ids[1]}
    result=sync.receive(device,p)
    assert result['state']=='removed' and set(result['job_ids'])==set(ids)
    assert len(result['removed'])==2 and store.search()['jobs']==[]
    assert sync.receive(device,p)==result
    assert sync.receive(device,undo(p['event_id']))['state']=='restored'
    assert len(store.search()['jobs'])==2


def test_alias_removal_rolls_back_entire_group_if_any_alias_is_protected(tmp_path):
    from test_job_duplicates import legacy_pair, URL as SOURCE
    store=Store(tmp_path/'aliases.db');first,second=legacy_pair(store)
    sync=ExtensionSync(store);device=str(uuid.uuid4());sync.pair(device,EXTENSION_ID)
    with store.connect(True) as c:c.execute("UPDATE applications SET status='submitted' WHERE job_id=?",(second,))
    p={**manual(),'job_url':SOURCE,'website_job_id':first}
    assert sync.receive(device,p)['state']=='protected'
    with store.connect() as c:assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0


@pytest.mark.parametrize('protection',['submitted','submitted_unconfirmed'])
def test_manual_delete_preserves_applications_and_active_claims(setup,protection):
    store,sync,device,jid=setup
    with store.connect(True) as c:c.execute("UPDATE applications SET status=?,version=1 WHERE job_id=?",(protection,jid))
    assert sync.receive(device,manual())['state']=='protected'
    assert Board(store).list(view='trash')['total']==0


@pytest.mark.parametrize('status',['in_progress','needs_input','retryable_failure','skipped'])
def test_owner_can_remove_draft_preserving_history_and_restore_without_resuming(setup,status):
    store,sync,device,jid=setup
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status=?,version=3,detail='draft history' WHERE job_id=?",(status,jid))
        before=dict(c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone())
    assert sync.resolve({'url':URL})['removal']=={'allowed':True,'removed':False}
    assert sync.receive(device,payload())['state']=='protected'
    p={**manual(),'detail':'Not a suitable role'}
    result=sync.receive(device,p)
    assert result['state']=='removed'
    assert sync.receive(device,p)==result
    assert sync.resolve({'url':URL})['removal']['removed']
    assert not sync.resolve({'url':URL})['queue']['allowed']
    with store.connect() as c:
        assert dict(c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone())==before
    assert sync.receive(device,undo(p['event_id']))['state']=='restored'
    assert not sync.resolve({'url':URL})['queue']['allowed']


@pytest.mark.parametrize('column,value',[('attempted_at',1),('confirmed_at',1),('submission_error','Uncertain attempt')])
def test_draft_status_cannot_hide_submission_evidence(setup,column,value):
    store,sync,device,jid=setup
    with store.connect(True) as c:
        c.execute(f"UPDATE applications SET status='in_progress',{column}=? WHERE job_id=?",(value,jid))
    assert not sync.resolve({'url':URL})['removal']['allowed']
    assert sync.receive(device,manual())['state']=='protected'


def test_late_submission_receipt_preserves_manual_removal_and_real_evidence(setup):
    store,sync,device,jid=setup
    p=manual()
    assert sync.receive(device,p)['state']=='removed'
    receipt={k:v for k,v in payload().items() if k not in {'code','quote'}}
    receipt.update(proof='ats_confirmation',job_title='Engineer',company='Acme')
    assert sync.receive(device,receipt)['state']=='submitted'
    assert store.get_jobs([jid])[0]['status']=='submitted'
    assert sync.resolve({'url':URL})['removal']['removed']
    assert not sync.resolve({'url':URL})['queue']['allowed']
    assert sync.receive(device,undo(p['event_id']))['state']=='restored'
    assert not sync.resolve({'url':URL})['queue']['allowed']


def test_manual_event_requires_owner_auth_and_cannot_claim_automatic_evidence(setup):
    store,sync,device,_=setup
    with pytest.raises(ValueError):sync.receive('unknown-device',manual())
    with pytest.raises(ValueError):sync.receive(device,{**manual(),'code':'page_missing'})
    with pytest.raises(ValueError):sync.receive(device,{**payload(),'quote':'用户在插件中手动删除岗位'})
    assert len(store.search()['jobs'])==1


@pytest.mark.parametrize('detail',['','   ','x'*501,42])
def test_invalid_manual_reason_never_deletes(setup,detail):
    store,sync,device,_=setup
    with pytest.raises(ValueError):sync.receive(device,{**manual(),'detail':detail})
    assert len(store.search()['jobs'])==1


def test_legacy_queued_manual_removal_still_works_and_does_not_invent_reason(setup):
    store,sync,device,_=setup
    result=sync.receive(device,manual())
    assert result['state']=='removed'
    assert Board(store).list(view='trash')['jobs'][0]['review']['detail']=='用户在插件中手动删除岗位'


def test_removal_uses_existing_trash_actual_reason_queue_suppression_and_restore(setup):
    store,sync,device,jid=setup;p=payload()
    r=sync.receive(device,p)
    assert r['state']=='removed' and r['removal_reason']=='DNE'
    assert store.search()['jobs']==[]
    b=Board(store);assert b.list()['total']==0
    row=b.list(view='trash')['jobs'][0]
    assert row['review']['reason']=='DNE' and row['review']['detail']==p['quote']
    assert row['review']['evidence'][0]['url']==URL
    assert store.get_jobs([jid])[0]['status']=='not_started'
    store.ingest('simplify:newgrad',[observation(url=URL)],'again')
    assert store.search()['jobs']==[]
    assert sync.receive(device,p)==r
    u=undo(p['event_id']);assert sync.receive(device,u)['state']=='restored'
    assert b.list()['total']==1
    assert sync.receive(device,u)['state']=='restored'
    assert sync.receive(device,payload())['reason']=='manually_kept'
    assert b.list()['total']==1


@pytest.mark.parametrize('quote,code,reason',[
    ('This job has been closed.','job_missing','job_closed'),
    ('This position was not found.','job_missing','DNE'),
    ('This job is no longer accepting applications.','applications_closed','applications_closed'),
])
def test_actual_reason(setup,quote,code,reason):
    store,sync,device,_=setup
    assert sync.receive(device,{**payload(),'code':code,'quote':quote})['removal_reason']==reason


@pytest.mark.parametrize('quote',[
    'Sign in to apply','Your session has expired.','Something went wrong','404',
    "Our handbook says: The page you are looking for doesn't exist.",
    'No jobs match your search.','This job is accepting applications.',
])
def test_generic_failures_never_remove(setup,quote):
    store,sync,device,_=setup
    with pytest.raises(ValueError):sync.receive(device,{**payload(),'quote':quote})
    assert len(store.search()['jobs'])==1


def test_matching_requires_same_job_even_with_website_hint(setup):
    store,sync,device,jid=setup
    for url in [URL.replace('acme.','other.'),URL.replace('R123','R124'),URL.split('/job/')[0]]:
        assert sync.receive(device,{**payload(),'job_url':url,'website_job_id':jid})['state']=='unmatched'
    assert len(store.search()['jobs'])==1


@pytest.mark.parametrize('protection',['submitted','version','in_progress','manual'])
def test_existing_protections(setup,protection):
    store,sync,device,jid=setup
    if protection=='in_progress':
        with store.connect(True) as c:c.execute("UPDATE applications SET status='in_progress' WHERE job_id=?",(jid,))
    elif protection=='manual':
        b=Board(store);row=b.list()['jobs'][0]
        b.review(jid,'newgrad','trash','manual','test',[{'url':URL,'quote':'test','observed_at':'today'}],row['fingerprint'],0,'availability-trash',actor='web-owner')
        row=b.list(view='trash')['jobs'][0]
        b.review(jid,'newgrad','restore','owner_restore','test',[],row['fingerprint'],1,'availability-restore',actor='web-owner')
    else:
        with store.connect(True) as c:
            c.execute("UPDATE applications SET status=?,version=1 WHERE job_id=?",('submitted' if protection=='submitted' else 'not_started',jid))
    assert sync.receive(device,payload())['state']=='protected'
    assert Board(store).list(view='trash')['total']==0


def test_undo_expiry_device_fencing_and_receipt_integrity(setup):
    store,sync,device,jid=setup;p=payload();sync.receive(device,p)
    with pytest.raises(ValueError):sync.receive(device,{**p,'quote':'The page you are looking for does not exist.'})
    other=str(uuid.uuid4());sync.pair(other,EXTENSION_ID)
    with pytest.raises(ValueError):sync.receive(other,undo(p['event_id']))
    with store.connect(True) as c:
        old=json.loads(c.execute('SELECT result FROM job_availability_events WHERE event_id=?',(p['event_id'],)).fetchone()[0])
        old['expires_at']=time.time()-1
        c.execute('UPDATE job_availability_events SET result=? WHERE event_id=?',(json.dumps(old),p['event_id']))
    assert sync.receive(device,undo(p['event_id']))['state']=='restore_expired'
    assert store.search()['jobs']==[]


def test_stale_observation_and_changed_trash_cannot_be_overwritten(setup):
    store,sync,device,jid=setup
    assert sync.receive(device,{**payload(),'observed_at':'2020-01-01T00:00:00Z'})['state']=='expired'
    p=payload();sync.receive(device,p)
    with store.connect(True) as c:c.execute('UPDATE job_screening SET version=version+1 WHERE job_id=?',(jid,))
    assert sync.receive(device,undo(p['event_id']))['state']=='restore_conflict'


@pytest.mark.parametrize('event',[payload,manual])
def test_existing_http_receipt_endpoint_accepts_remove_and_restore_without_expanding_public_access(setup,event):
    from starlette.testclient import TestClient
    from jobs_radar.server import create_server
    store,sync,device,_=setup
    pair=sync.pair(device,EXTENSION_ID)
    server=create_server(store,origin='https://radar.test')
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as client:
        p=event()
        assert client.post('/api/extension/events',json=p).status_code==401
        headers={'authorization':'Bearer '+pair['token']}
        r=client.post('/api/extension/events',json=p,headers=headers)
        assert r.status_code==200 and r.json()['state']=='removed'
        assert client.post('/api/extension/events',json=undo(p['event_id']),headers=headers).json()['state']=='restored'
        assert client.get('/api/jobs',headers=headers).status_code==401
