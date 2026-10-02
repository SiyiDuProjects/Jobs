import json
import time
import pytest
from starlette.testclient import TestClient
from jobs_radar.board import Board
from jobs_radar.store import Store
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from test_store import observation


@pytest.fixture
def subject(tmp_path):
    store=Store(tmp_path/'tracking.sqlite')
    store.ingest('simplify:newgrad',[observation()],'tracking')
    board=Board(store)
    return board,board.list()['jobs'][0]['id']


def test_opened_is_not_submission_and_survives_filters_sync_and_restart(subject):
    b,jid=subject
    before=b.store.get_jobs([jid])[0]
    b.opened(jid,'newgrad')
    b.store.ingest('simplify:newgrad',[observation()],'next-sync')
    b=Board(Store(b.store.path))
    filtered=b.list(text='no matching company',added_since=time.time()+1)
    assert filtered['total']==0
    assert filtered['recent_opened'][0]['id']==jid
    after=b.store.get_jobs([jid])[0]
    for key in ['status','version','detail','evidence']:
        assert after[key]==before[key]
    assert b.list(kind='internship')['recent_opened']==[]
    b.opened(jid,'newgrad',dismiss=True)
    assert b.list()['recent_opened']==[]


def test_one_click_confirmation_idempotence_and_undo(subject):
    b,jid=subject
    b.opened(jid,'newgrad')
    done=b.mark_submitted(jid,0,key='one-click-test')
    assert b.mark_submitted(jid,0,key='one-click-test')==done
    assert b.list()['recent_opened']==[]
    assert b.list()['total']==0
    assert b.list(status='submitted')['jobs'][0]['can_undo_submission']
    with b.store.connect() as c:
        evidence=json.loads(c.execute('SELECT evidence FROM applications').fetchone()[0])
        assert evidence[0]['type']=='owner_confirmation'
    undone=b.undo_submitted(jid,1,'undo-one-click')
    assert b.undo_submitted(jid,1,'undo-one-click')==undone
    assert undone['status']=='not_started' and undone['version']==2
    assert b.list()['recent_opened'][0]['application_version']==2
    assert b.list()['jobs'][0]['can_undo_submission'] is False
    with pytest.raises(ValueError): b.mark_submitted(jid,0,key='stale-click')


def test_status_counts_cover_all_filtered_jobs_before_pagination(subject):
    b,_=subject
    states=['not_started','submitted','needs_input','skipped','submitted_unconfirmed','in_progress','retryable_failure']
    sources=[{**observation(url='https://example.org/count/'+state),'source_id':state,'company':'Counted'} for state in states]
    b.store.ingest('simplify:newgrad',sources,'all-statuses')
    with b.store.connect(True) as c:
        for row in c.execute('SELECT job_id,source_id FROM observations WHERE source_id IN (%s)' % ','.join('?' for _ in states),states).fetchall():
            c.execute('UPDATE applications SET status=? WHERE job_id=?',(row['source_id'],row['job_id']))
    first=b.list(text='Counted',status='recent',page_size=2)
    second=b.list(text='Counted',status='recent',page_size=2,page=2)
    assert len(first['jobs'])==2 and first['total']==7
    assert first['application_counts']==second['application_counts']==dict.fromkeys(states,1)
    assert sum(first['application_counts'].values())==first['total']
    only=b.list(text='Counted',status='needs_input')
    assert only['total']==1 and sum(only['application_counts'].values())==1
    # The owner's simple "unsubmitted" view includes stopped/skipped attempts,
    # without changing the workflow states or allowing automatic retries.
    unsubmitted=b.list(text='Counted',status='unsubmitted',page_size=100)
    assert unsubmitted['total']==5
    assert {r['status'] for r in unsubmitted['jobs']}==set(states)-{'submitted','submitted_unconfirmed'}
    with b.store.connect() as c:
        assert {r[0] for r in c.execute('SELECT DISTINCT status FROM applications')}==set(states)


def test_undo_restores_uncertain_application_and_evidence(subject):
    b,jid=subject
    with b.store.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted_unconfirmed',version=7,detail='Await official receipt',evidence='[{}]',owner_run_id='worker-a'")
    b.mark_submitted(jid,7,key='owner-confirms-unknown')
    b.undo_submitted(jid,8,'undo-unknown')
    with b.store.connect() as c:
        app=c.execute('SELECT * FROM applications').fetchone()
        assert (app['status'],app['version'],app['detail'],app['evidence'],app['owner_run_id'])==('submitted_unconfirmed',9,'Await official receipt','[{}]','worker-a')
    from jobs_radar.extension_sync import ExtensionSync
    assert not ExtensionSync(b.store).resolve({'url':observation()['apply_url']})['queue']['allowed']


def test_owner_can_delete_after_undo_but_automation_stays_protected(subject):
    b,jid=subject
    b.mark_submitted(jid,0,key='confirm-before-delete')
    b.undo_submitted(jid,1,'undo-before-delete')
    row=b.list()['jobs'][0]
    evidence=[{'url':row['apply_url'],'quote':row['title'],'observed_at':'test'}]
    with pytest.raises(ValueError,match='protected'):
        b.review(jid,'newgrad','trash','off_target_role','Automated removal',evidence,row['fingerprint'],0,'auto-delete-after-undo')
    result=b.review(jid,'newgrad','trash','manual','Owner no longer interested',evidence,row['fingerprint'],0,'owner-delete-after-undo',actor='web-owner')
    assert result['state']=='trash'
    assert b.list()['total']==0
    assert b.list(view='trash')['jobs'][0]['id']==jid
    assert b.store.get_jobs([jid])[0]['version']==2


@pytest.mark.parametrize('protected',['submitted','submitted_unconfirmed'])
def test_owner_delete_still_protects_submitted_or_claimed(subject,protected):
    b,jid=subject
    with b.store.connect(True) as c:
        c.execute('UPDATE applications SET status=?,version=1',(protected,))
    row=b._rows('newgrad')[0]
    with pytest.raises(ValueError,match='protected'):
        b.review(jid,'newgrad','trash','manual','Owner delete',
                 [{'url':row['apply_url'],'quote':row['title'],'observed_at':'test'}],
                 row['fingerprint'],0,'blocked-owner-delete',actor='web-owner')




def test_undo_cannot_overwrite_newer_version_or_expired_window(subject):
    b,jid=subject
    b.mark_submitted(jid,0,key='version-confirm')
    with b.store.connect(True) as c: c.execute("UPDATE applications SET version=2,detail='Later reconciliation'")
    assert not b.list(status='submitted')['jobs'][0]['can_undo_submission']
    with pytest.raises(ValueError,match='已更新'): b.undo_submitted(jid,1,'stale-undo')
    with b.store.connect(True) as c: c.execute('UPDATE owner_submission_undo SET expires=0')
    with pytest.raises(ValueError,match='期限'): b.undo_submitted(jid,2,'expired-undo')


def test_undo_restores_deleted_tag(subject):
    b,jid=subject
    row=b.list()['jobs'][0]
    b.review(jid,'newgrad','trash','manual','Not interested',[{'url':row['apply_url'],'quote':row['title'],'observed_at':'test'}],row['fingerprint'],0,'owner-trash',actor='web-owner')
    b.mark_submitted(jid,0,key='confirm-trashed')
    assert b.list(status='submitted')['jobs'][0]['review']['manual_keep']==1
    b.undo_submitted(jid,1,'undo-trashed')
    assert b.list()['total']==0
    restored=b.list(view='trash')['jobs'][0]['review']
    assert restored['state']=='trash' and restored['manual_keep']==0 and restored['version']==3


def test_private_http_actions_no_receipt_prompt(subject):
    b,jid=subject
    origin='http://127.0.0.1:8796'
    with TestClient(create_server(b.store,origin).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        payload={'action':'opened','job_id':jid,'kind':'newgrad'}
        assert client.post('/api/actions',json=payload,headers={'Origin':origin}).status_code==401
        WebAccess(b.store,origin).approve(client.get('/api/session').json()['request_id'])
        assert client.post('/api/actions',json=payload).status_code==403
        assert client.post('/api/actions',json=payload,headers={'Origin':origin}).status_code==200
        assert client.get('/api/jobs').json()['recent_opened'][0]['id']==jid
        done=client.post('/api/actions',json={'action':'submitted','job_id':jid,'version':0,'key':'http-one-click'},headers={'Origin':origin})
        assert done.status_code==200,done.text
        assert client.get('/api/jobs').json()['total']==0
        assert client.post('/api/actions',json={'action':'undo_submitted','job_id':jid,'version':1,'key':'http-undo'},headers={'Origin':origin}).status_code==200
        assert client.get('/api/jobs').json()['jobs'][0]['status']=='not_started'


def test_recent_view_keeps_submitted_position_and_counts_across_pages(subject):
    b,jid=subject
    sources=[{**observation(url='https://example.org/role/'+str(i)), 'source_id':str(i), 'posted_at':time.time()-i*60} for i in range(3)]
    b.store.ingest('simplify:newgrad',sources,'recent-view')
    before=b.list(status='recent')
    target=before['jobs'][1]
    b.mark_submitted(target['id'],target['application_version'],key='visible-completion')
    after=b.list(status='recent')
    assert [r['id'] for r in before['jobs']]==[r['id'] for r in after['jobs']]
    assert after['jobs'][1]['status']=='submitted'
    assert after['total']==3
    paged=b.list(status='recent',page_size=1)
    assert paged['application_counts']=={'submitted':1,'not_started':2}
    assert b.list(status='not_started')['total']==2
    assert b.list(status='submitted')['total']==1
    assert b.list(status='recent',added_since=time.time()-3600)['total']==3


def test_default_view_keeps_old_open_roles_and_history_keeps_closed_roles(subject):
    b,jid=subject
    b.mark_submitted(jid,0,key='old-history-completion')
    b.store.ingest('simplify:newgrad',[{**observation(),'posted_at':time.time()-8*86400}],'old-source')
    assert b.list(status='recent')['jobs'][0]['id']==jid
    b.store.ingest('simplify:newgrad',[{**observation(),'posted_at':time.time()-8*86400,'active':False}],'closed-source')
    assert b.list(status='recent')['jobs']==[]
    assert b.list(status='submitted')['jobs'][0]['id']==jid


@pytest.mark.parametrize('status',['in_progress','needs_input','retryable_failure','skipped'])
def test_owner_trashes_unsubmitted_draft_but_automatic_screening_cannot(subject,status):
    b,jid=subject
    with b.store.connect(True) as c:c.execute('UPDATE applications SET status=?,version=2',(status,))
    row=b._rows('newgrad')[0]
    args=(jid,'newgrad','trash','manual','Not suitable',
        [{'url':row['apply_url'],'quote':row['title'],'observed_at':'test'}],row['fingerprint'],0)
    with pytest.raises(ValueError,match='authorized removal reason'):b.review(*args,'automatic-draft')
    assert b.review(*args,'owner-draft',actor='web-owner')['state']=='trash'
    assert b.store.get_jobs([jid])[0]['status']==status
