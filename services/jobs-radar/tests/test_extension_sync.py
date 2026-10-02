import json
import uuid
import pytest


def test_one_receipt_updates_all_validated_legacy_source_aliases(tmp_path):
    from test_job_duplicates import legacy_pair, URL
    store=Store(tmp_path/'aliases.db');ids=legacy_pair(store)
    sync=ExtensionSync(store);sync.pair(DEVICE,EXTENSION_ID)
    result=sync.receive(DEVICE,{**receipt(),'job_url':URL+'/apply/applyManually'})
    assert result['state']=='submitted' and set(result['job_ids'])==set(ids)
    assert {r['status'] for r in store.get_jobs(ids)}=={'submitted'}
from starlette.testclient import TestClient
from jobs_radar.store import Store
from jobs_radar.board import Board
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from test_store import observation

ORIGIN='https://radar.test'
DEVICE=str(uuid.uuid4())

def receipt(**overrides):
    return dict(event_id=str(uuid.uuid4()), job_url=observation()['apply_url']+'/apply?source=test',
                job_title='Software Engineer', company='Test Employer', observed_at='2026-09-17T12:00:00Z',
                proof='ats_confirmation', **overrides)

@pytest.fixture
def setup(tmp_path):
    store=Store(tmp_path/'jobs.sqlite');store.ingest('simplify:newgrad',[observation()],'test')
    sync=ExtensionSync(store);pair=sync.pair(DEVICE,EXTENSION_ID)
    return store,sync,pair

def test_confirmation_idempotency_privacy_and_undo(setup):
    store,sync,pair=setup
    assert sync.authenticate(pair['token'])==DEVICE
    with store.connect() as c:
        assert pair['token'] not in str(tuple(c.execute('SELECT * FROM extension_devices').fetchone()))
    p=receipt();result=sync.receive(DEVICE,p)
    assert result['state']=='submitted'
    assert sync.receive(DEVICE,p)==result
    b=Board(store);job=store.get_jobs([result['job_id']])[0]
    assert job['version']==1 and job['status']=='submitted'
    assert job['evidence'][0]['type']=='extension_confirmation'
    assert sync.receive(DEVICE,{**p,'event_id':str(uuid.uuid4())})['state']=='already_submitted'
    assert store.get_jobs([result['job_id']])[0]['version']==1
    b.undo_submitted(result['job_id'],1,'undo-extension')
    assert store.get_jobs([result['job_id']])[0]['status']=='not_started'
    # A retried receipt never reverses the owner's undo.
    assert sync.receive(DEVICE,p)==result
    assert store.get_jobs([result['job_id']])[0]['status']=='not_started'
    with pytest.raises(ValueError):sync.receive(DEVICE,{**p,'company':'different'})

@pytest.mark.parametrize('proof',['tracker_record','submit_attempt'])
def test_native_applied_record_syncs_directly_with_honest_provenance(setup,proof):
    store,sync,_=setup;p={**receipt(),'proof':proof}
    result=sync.receive(DEVICE,p)
    assert result['state']=='submitted' and not result['retryable']
    job=store.get_jobs([result['job_id']])[0]
    assert job['status']=='submitted' and job['evidence'][0]['type']==proof
    board=Board(store).list(status='submitted')
    assert [row['id'] for row in board['jobs']]==[result['job_id']]
    assert board['application_counts']['submitted']==1
    assert Board(store).list(status='unsubmitted')['jobs']==[]
    with store.connect() as c:
        app=c.execute('SELECT * FROM applications WHERE job_id=?',(result['job_id'],)).fetchone()
        assert app['confirmed_at'] is None
        from jobs_radar.application_records import submission_state
        assert submission_state(app)['label']=='已投递'
    assert sync.receive(DEVICE,p)==result
    assert sync.status()['pending']==0


@pytest.mark.parametrize('proof',['ats_confirmation','tracker_record'])
@pytest.mark.parametrize('observed',['2020-01-01T00:00:00Z','','invalid'])
def test_distinct_delayed_receipts_respect_owner_undo_but_new_evidence_can_apply(setup,proof,observed):
    from datetime import datetime, timezone
    store,sync,_=setup
    first=sync.receive(DEVICE,receipt())
    Board(store).undo_submitted(first['job_id'],1,'undo-before-delayed-receipt')
    stale={**receipt(),'proof':proof,'observed_at':observed}
    if observed in {'','invalid'}:
        with pytest.raises(ValueError,match='timestamp'):sync.receive(DEVICE,stale)
        assert store.get_jobs([first['job_id']])[0]['status']=='not_started'
        return
    result=sync.receive(DEVICE,stale)
    assert result['state']=='ignored_after_undo' and not result['retryable']
    assert sync.receive(DEVICE,stale)==result
    assert store.get_jobs([first['job_id']])[0]['status']=='not_started'
    fresh={**receipt(),'proof':proof,'observed_at':datetime.now(timezone.utc).isoformat()}
    assert sync.receive(DEVICE,fresh)['state']=='submitted'



@pytest.mark.parametrize('proof',['ats_confirmation','tracker_record'])
def test_unmatched_same_title_never_merges_and_retries_after_ingest(setup,proof):
    store,sync,_=setup
    url='https://jobs.lever.co/other/11111111-2222-3333-4444-555555555555'
    p={**receipt(),'job_url':url,'proof':proof}
    original=sync.receive(DEVICE,p)
    assert original['state']=='submitted'
    assert original['job_ids']==[]
    assert store.search()['jobs'][0]['status']=='not_started'
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM jobs').fetchone()[0]==1
    store.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=url)],'added')
    assert sync.receive(DEVICE,p)==original
    assert not sync.resolve({'url':url})['queue']['allowed']

def test_website_click_is_a_hint_not_permission_to_override_mismatched_job(setup):
    store,sync,_=setup;jid=store.search()['jobs'][0]['id']
    mismatch={**receipt(),'website_job_id':jid,'job_url':'https://jobs.ashbyhq.com/other/11111111-2222-3333-4444-555555555555'}
    assert sync.receive(DEVICE,mismatch)['job_ids']==[]
    assert store.get_jobs([jid])[0]['status']=='not_started'
    result=sync.receive(DEVICE,{**receipt(),'website_job_id':jid})
    assert result['state']=='submitted'
    assert result['job_id']==jid


def test_numeric_workday_alias_matches_after_dismissing_opened_reminder(setup):
    store,sync,_=setup
    url='https://hpe.wd5.myworkdayjobs.com/en-US/jobsathpe/job/San-Jose-California/AI-Workflow-Specialist-Graduate_1211885'
    store.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=url)],'numeric')
    with store.connect() as c:
        from jobs_radar.job_match import job_key
        jid=c.execute('SELECT id FROM jobs WHERE job_key=?',(job_key(url),)).fetchone()['id']
    Board(store).opened(jid,'newgrad')
    Board(store).opened(jid,'newgrad',dismiss=True)
    payload={**receipt(),'job_url':url.replace('San-Jose-California','San-Jose%2C-California'),
             'proof':'tracker_record','website_job_id':jid}
    wrong={**payload,'event_id':str(uuid.uuid4()),'job_url':payload['job_url'].replace('_1211885','_1211886')}
    assert sync.receive(DEVICE,wrong)['job_ids']==[]
    other={**payload,'event_id':str(uuid.uuid4()),'job_url':payload['job_url'].replace('hpe.wd5','other.wd5')}
    assert sync.receive(DEVICE,other)['job_ids']==[]
    result=sync.receive(DEVICE,payload)
    assert result['state']=='submitted' and result['job_id']==jid
    assert sync.receive(DEVICE,payload)==result

def test_pair_rotation_revocation_and_validation(setup):
    _,sync,pair=setup
    newer=sync.pair(DEVICE,EXTENSION_ID)
    assert sync.authenticate(pair['token']) is None
    assert sync.authenticate(newer['token'])==DEVICE
    for addition in [{'resume':'private'},{'profileName':'private'},{'job_url':'file:///private'}, {'job_url':'https://user:pass@host.test/job'}, {'proof':'submit_click'}]:
        with pytest.raises(ValueError): sync.receive(DEVICE,{**receipt(),**addition})
    sync.disconnect(DEVICE)
    assert sync.authenticate(newer['token']) is None
    assert sync.status()['connected_devices']==0
    with pytest.raises(ValueError):sync.receive(DEVICE,receipt())

def test_http_pair_requires_owner_cookie_and_origin_and_bearer_is_narrow(tmp_path):
    store=Store(tmp_path/'api.sqlite');store.ingest('simplify:newgrad',[observation()],'test')
    server=create_server(store,origin=ORIGIN)
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as client:
        body={'device_id':DEVICE,'extension_id':EXTENSION_ID}
        assert client.post('/api/extension/connect',json=body,headers={'origin':ORIGIN}).status_code==401
        request_id=client.get('/api/session').json()['request_id']
        WebAccess(store,ORIGIN).approve(request_id)
        assert client.post('/api/extension/connect',json=body,headers={'origin':'https://evil.test'}).status_code==403
        assert client.post('/api/extension/connect',json={**body,'extension_id':'bad'},headers={'origin':ORIGIN}).status_code==400
        token=client.post('/api/extension/connect',json=body,headers={'origin':ORIGIN}).json()['token']
        assert client.post('/api/extension/events',json=receipt()).status_code==401
        headers={'authorization':'Bearer '+token,'origin':'chrome-extension://'+EXTENSION_ID}
        assert client.post('/api/extension/events',json=receipt(),headers=headers).json()['state']=='submitted'
        assert client.get('/api/extension/status').json()['connected_devices']==1
        client.cookies.clear()
        assert client.get('/api/jobs',headers=headers).status_code==401
        assert client.post('/api/extension/disconnect',json={'device_id':DEVICE},headers=headers).status_code==401
