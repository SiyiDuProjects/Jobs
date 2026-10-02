"""Only an authenticated ATS observation may alter the list's display title."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import time
import uuid

import pytest
from starlette.testclient import TestClient

from jobs_radar.application_records import seed_progress
from jobs_radar.board import Board
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.identity import stable_id
from jobs_radar.job_titles import JobTitles
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_store import observation

PROTECTED = ('applications','application_events','owner_submission_undo','job_screening',
             'job_role_family','observations','snapshots','search_index')


def iso(stamp):
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat()


@pytest.fixture
def title_client(tmp_path):
    store=Store(tmp_path/'titles.sqlite')
    source=observation()
    store.ingest('simplify:newgrad',[source],'synthetic')
    device=str(uuid.uuid4())
    extension=ExtensionSync(store)
    token=extension.pair(device,EXTENSION_ID)['token']
    jid=store.search()['jobs'][0]['id']
    headers={'Authorization':'Bearer '+token,'X-Jobs-Protocol':'2'}
    body={'url':source['apply_url'],'title':'Actual ATS Software Engineer','title_source':'existing_adapter','observed_at':iso(time.time()-10)}
    server=create_server(store,'https://jobs.siyidu.com')
    with TestClient(server.streamable_http_app(),base_url='https://jobs.siyidu.com') as client:
        yield store,client,device,jid,headers,body


def snapshot(store,tables=PROTECTED):
    with store.connect() as c:
        return {table:[tuple(r) for r in c.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in tables}


def post(fixture,body=None,headers=None):
    _,client,_,_,authorized,original=fixture
    return client.post('/api/extension/job-title',json=original if body is None else body,headers=authorized if headers is None else headers)


def token_hash(fixture):
    return hashlib.sha256(fixture[4]['Authorization'][7:].encode()).hexdigest()


def test_title_only_changes_list_and_resolve_display_and_survives_reingest(title_client):
    store,_,_,jid,_,body=title_client
    with store.connect(True) as c:
        c.execute('UPDATE applications SET application_id=?,record=?,progress=?,version=4,status=\'needs_input\' WHERE job_id=?',
            ('synthetic-title-app',json.dumps({'jobTitle':'Historical application title'}),json.dumps(seed_progress('synthetic-title-app','applied','owner')),jid))
        c.execute("INSERT INTO owner_submission_undo VALUES(?,4,1,'{}','[]')",(jid,))
    before=snapshot(store)
    original=Board(store)._rows('newgrad')[0]
    result=post(title_client)
    assert result.status_code==200 and result.json()['changed']
    assert snapshot(store)==before
    shown=Board(store)._rows('newgrad')[0]
    assert shown=={**original,'title':body['title']}
    assert ExtensionSync(store).resolve({'url':body['url']})['title']==body['title']
    assert Board(store).list(status='needs_input')['jobs'][0]['title']==body['title']
    metadata=snapshot(store,('job_title_overrides',))
    store.ingest('simplify:newgrad',[{**observation(),'title':'Later collector title'}],'reingest')
    assert snapshot(store,('job_title_overrides',))==metadata
    assert Board(store)._rows('newgrad')[0]['title']==body['title']
    with store.connect() as c:
        assert json.loads(c.execute('SELECT record FROM applications WHERE job_id=?',(jid,)).fetchone()[0])['jobTitle']=='Historical application title'


def test_duplicate_watermark_prevents_late_different_title(title_client):
    store,_,_,_,_,body=title_client
    start=int(time.time())-100
    first={**body,'title':'A','observed_at':iso(start)}
    assert post(title_client,first).json()['changed']
    initial=snapshot(store,('job_title_overrides','audit'))
    duplicate=post(title_client,{**first,'observed_at':iso(start+30)})
    assert duplicate.json()['reason']=='duplicate' and not duplicate.json()['changed']
    latest=snapshot(store,('job_title_overrides','audit'))
    assert latest['audit']==initial['audit']
    old,new=initial['job_title_overrides'][0],latest['job_title_overrides'][0]
    assert new==(*old[:5],start+30,old[6])
    assert post(title_client,{**first,'title':'B','observed_at':iso(start+20)}).json()['reason']=='stale'
    assert post(title_client,{**first,'title':'C','observed_at':iso(start+30)}).json()['reason']=='stale'
    assert post(title_client,{**first,'observed_at':iso(start+30)}).json()['reason']=='duplicate'
    assert snapshot(store,('job_title_overrides','audit'))==latest
    assert post(title_client,{**first,'title':'D','observed_at':iso(start+31)}).json()['changed']


@pytest.mark.parametrize('mode', ['old_protocol','anonymous','expired','revoked'])
def test_http_access_and_protocol_fail_without_any_data_change(title_client,mode):
    store,_,device,_,headers,_=title_client
    headers=dict(headers)
    if mode=='old_protocol':headers.pop('X-Jobs-Protocol')
    if mode=='anonymous':headers.pop('Authorization')
    if mode in {'expired','revoked'}:
        with store.connect(True) as c:
            c.execute('UPDATE extension_devices SET '+('expires=1' if mode=='expired' else 'revoked=1')+' WHERE device_id=?',(device,))
    before=snapshot(store,(*PROTECTED,'job_title_overrides','audit','extension_devices'))
    assert post(title_client,headers=headers).status_code==(426 if mode=='old_protocol' else 401)
    assert snapshot(store,(*PROTECTED,'job_title_overrides','audit','extension_devices'))==before


@pytest.mark.parametrize('bad', [{'title':''},{'title':' '},{'title':'x'*501},{'title':'A\x00B'},
    {'title_source':'ai'},{'observed_at':'2026-09-26T01:02:03'}, {'observed_at':'invalid'},
    {'observed_at':'2099-01-01T00:00:00Z'},{'website_job_id':'not-a-job-id'},{'unknown':'field'}])
def test_invalid_observation_is_rejected_without_write(title_client,bad):
    store,*_=title_client
    before=snapshot(store,(*PROTECTED,'job_title_overrides','audit'))
    assert post(title_client,{**title_client[-1],**bad}).status_code==400
    assert snapshot(store,(*PROTECTED,'job_title_overrides','audit'))==before


def test_wrong_hint_cannot_retitle_another_job_or_guess_unknown_page(title_client):
    store,_,_,jid,_,body=title_client
    other={**observation(url='https://jobs.lever.co/other/99999999-2222-4333-8444-555555555555'),'source_id':'other'}
    store.ingest('simplify:newgrad',[observation(),other],'second')
    other_id=next(r['id'] for r in store.search()['jobs'] if r['id']!=jid)
    result=post(title_client,{**body,'website_job_id':other_id})
    assert result.json()['job_id']==jid
    before=snapshot(store,('job_title_overrides','audit'))
    unknown={**body,'url':'https://jobs.lever.co/other/aaaaaaaa-2222-4333-8444-555555555555','website_job_id':other_id}
    assert post(title_client,unknown).json()['reason']=='unmatched'
    assert snapshot(store,('job_title_overrides','audit'))==before
    assert next(r for r in Board(store)._rows('newgrad') if r['id']==other_id)['title']==other['title']


def test_ambiguous_identity_is_held_even_with_hint(title_client):
    store,_,_,jid,_,body=title_client
    with store.connect(True) as c:
        c.execute("INSERT INTO jobs(id,identity,first_seen,last_seen,job_key) SELECT ?,'synthetic:ambiguous',1,2,job_key FROM jobs WHERE id=?",(stable_id('synthetic-title-ambiguous'),jid))
    before=snapshot(store,('job_title_overrides','audit'))
    assert post(title_client,{**body,'website_job_id':jid}).json()['reason']=='ambiguous'
    assert snapshot(store,('job_title_overrides','audit'))==before


def test_page_query_credentials_are_not_persisted_and_authorization_is_rechecked(title_client):
    store,_,device,_,_,body=title_client
    assert post(title_client,{**body,'url':body['url']+'?session_token=synthetic-secret-sentinel'}).json()['changed']
    assert 'synthetic-secret-sentinel' not in json.dumps(snapshot(store,('job_title_overrides','audit')))
    with store.connect(True) as c:c.execute('UPDATE extension_devices SET revoked=1 WHERE device_id=?',(device,))
    before=snapshot(store,('job_title_overrides','audit'))
    with pytest.raises(ValueError,match='authorization expired'):
        JobTitles(store).update(device,{**body,'title':'Forbidden after revoke'},expected_token_hash=token_hash(title_client))
    assert snapshot(store,('job_title_overrides','audit'))==before


def test_expired_first_observation_cannot_create_override(title_client):
    store,*_=title_client
    before=snapshot(store,('job_title_overrides','audit'))
    assert post(title_client,{**title_client[-1],'observed_at':iso(time.time()-86401)}).status_code==400
    assert snapshot(store,('job_title_overrides','audit'))==before


def test_device_expiring_while_waiting_for_writer_lock_cannot_write(title_client,monkeypatch):
    store,_,device,_,_,body=title_client
    clock=[time.time()]
    with store.connect(True) as c:
        c.execute('UPDATE extension_devices SET expires=? WHERE device_id=?',(clock[0]+1,device))
    before=snapshot(store,('job_title_overrides','audit'))
    connect=store.connect
    @contextmanager
    def delayed(write=False):
        if write:clock[0]+=2
        with connect(write) as c:yield c
    monkeypatch.setattr(store,'connect',delayed)
    monkeypatch.setattr('time.time',lambda:clock[0])
    with pytest.raises(ValueError,match='authorization expired'):
        JobTitles(store).update(device,body,expected_token_hash=token_hash(title_client))
    assert snapshot(store,('job_title_overrides','audit'))==before


def test_actual_extension_transport_body_crosses_real_http(title_client):
    from test_real_client_http import capture_clients, request
    store,client,device,jid,headers,body=title_client
    captured=capture_clients({'title_only':True,'device_id':device,
        'receipt_token':headers['Authorization'].removeprefix('Bearer '),
        'job_url':body['url'],'title':'Title from the actual extension transport','website_job_id':jid})['job-title']
    before=snapshot(store,(*PROTECTED,'job_title_overrides','audit'))
    assert request(client,captured,protocol=False).status_code==426
    assert snapshot(store,(*PROTECTED,'job_title_overrides','audit'))==before
    response=request(client,captured)
    assert response.status_code==200 and response.json()['changed']
    assert Board(store)._rows('newgrad')[0]['title']=='Title from the actual extension transport'


def test_repairing_device_rotates_old_inflight_token_out_of_title_access(title_client,monkeypatch):
    store,*_=title_client
    authenticate=ExtensionSync.authenticate
    def rotate_after_auth(self,token):
        principal=authenticate(self,token)
        if principal:self.pair(principal,EXTENSION_ID)
        return principal
    monkeypatch.setattr(ExtensionSync,'authenticate',rotate_after_auth)
    before=snapshot(store,('job_title_overrides','audit'))
    assert post(title_client).status_code in {400,401}
    assert snapshot(store,('job_title_overrides','audit'))==before
