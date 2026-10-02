import json
import time
import pytest
from starlette.testclient import TestClient
from jobs_radar.store import Store
from jobs_radar.board import Board
from jobs_radar.web import WebAccess
from jobs_radar.server import create_server
from test_store import observation

ORIGIN='http://127.0.0.1:8796'


def test_filter_counts_use_the_list_predicate_without_page_or_health_work(tmp_path,monkeypatch):
    store=Store(tmp_path/'counts.sqlite');board=Board(store)
    for kind in ('newgrad','internship'):
        store.ingest('simplify:'+kind,[{**observation(url='https://example.org/'+kind),'kind':kind}],'counts')
    expected={kind:board.list(kind=kind,status='recent',text='Software')['total'] for kind in ('newgrad','internship')}
    monkeypatch.setattr(store,'health',lambda:pytest.fail('Counts must not build source health or inspect disk usage'))
    result=board.filter_counts(status='recent',text='Software',page=9)
    assert result['total']==sum(expected.values())
    assert all(result[kind]['total']==expected[kind] for kind in expected)


def test_chronological_mixed_list_and_independent_faang_filter(tmp_path):
    store=Store(tmp_path/'group-pages.sqlite');board=Board(store);now=time.time()
    rows=[{**observation(company='Google' if i<19 else 'Other Employer',url=f'https://example.org/group-{i}'),
           'source_id':str(i),'kind':'internship','posted_at':now-86400*(i%7)-i}
          for i in range(146)]
    store.ingest('simplify:internship',rows,'test',scoped_only=True)
    first=board.list(kind='internship',status='recent',page_size=50)
    assert first['groups']=={'faang':19,'other':127}
    assert {r['group'] for r in first['jobs']}=={'faang','other'}
    dates=[r['posted_at'] for r in first['jobs']]
    assert dates==sorted(dates,reverse=True)
    pages=[board.list(kind='internship',status='recent',page=p,page_size=50) for p in (1,2,3)]
    assert len({r['id'] for page in pages for r in page['jobs']})==146
    assert sum(len(page['jobs']) for page in pages)==146
    assert all(page['groups']==first['groups'] for page in pages)
    faang=board.list(kind='internship',status='recent',group='faang',page_size=50)
    assert faang['total']==19 and len(faang['jobs'])==19
    assert all(r['company']=='Google' for r in faang['jobs'])
    counts=board.filter_counts(status='recent',group='faang')
    assert counts['internship']['total']==19

@pytest.fixture
def board(tmp_path):
    store=Store(tmp_path/'board.sqlite')
    for kind in ['newgrad','internship']:
        store.ingest('simplify:'+kind,[{**observation(url='https://example.org/same'), 'title':'Data Scientist', 'kind':kind,'category':'AI/ML/Data'}],'test')
    return Board(store)

def decision(board,kind='newgrad',reason='data_science',state='trash',key='screen-test-001'):
    row=board._rows(kind)[0]
    return board.review(row['id'],kind,state,reason,'Explicit authorized test rule',
        [{'url':'https://example.org/same','quote':'Data Scientist','observed_at':'2026-09-15T10:00:00Z'}],row['fingerprint'],row['review_version'],key)

def test_trash_mcp_sync_idempotence_and_no_resurrection(board):
    row=board._rows('newgrad')[0]
    args=(row['id'],'newgrad','trash','data_science','Data Scientist role',
          [{'url':'https://example.org/same','quote':'Data Scientist','observed_at':'2026-09-15T10:00:00Z'}],row['fingerprint'],0,'idem-screen-001')
    result=board.review(*args)
    assert board.review(*args)==result
    assert not board.store.search(kind='newgrad')['jobs']
    assert len(board.store.search(kind='internship')['jobs'])==1
    assert board.list(kind='newgrad')['total']==0
    assert board.list(kind='newgrad',view='trash')['total']==1
    board.store.ingest('simplify:newgrad',[{**observation(url='https://example.org/same'),'title':'Data Scientist','kind':'newgrad','category':'AI/ML/Data'}],'refresh')
    assert board.list(kind='newgrad')['total']==0
    with board.store.connect(True) as c:c.execute('UPDATE job_screening SET expires_at=?',(time.time()-1,))
    assert board.list(kind='newgrad',view='trash')['total']==0
    assert board.list(kind='newgrad')['total']==0
    with pytest.raises(ValueError,match='persistent'):decision(board,state='keep',key='no-implicit-restore')
    with pytest.raises(ValueError,match='expired'):decision(board,state='restore',key='expired-restore')

def test_sponsorship_internship_guard_and_manual_restore(board):
    with pytest.raises(ValueError,match='internships'):decision(board,kind='internship',reason='no_sponsorship')
    decision(board)
    decision(board,state='restore',key='restore-001')
    assert board.list()['jobs'][0]['review']['manual_keep']==1
    with pytest.raises(ValueError,match='Manually'):decision(board,key='repeat-trash-001')

def test_protected_application_and_changed_source(board):
    row=board._rows('newgrad')[0]
    with board.store.connect(True) as c:c.execute("UPDATE applications SET status='in_progress' WHERE job_id=?",(row['id'],))
    with pytest.raises(ValueError,match='protected'):decision(board)

def test_no_graduation_or_salary_removal_rule(board):
    with pytest.raises(ValueError,match='authorized'):decision(board,reason='graduation_date')
    with pytest.raises(ValueError,match='authorized'):decision(board,reason='salary')

def test_content_change_requeues_but_age_change_does_not(board):
    decision(board,state='keep')
    assert not board.queue('newgrad')['jobs']
    source={**observation(url='https://example.org/same'),'title':'Data Scientist','kind':'newgrad','category':'AI/ML/Data','posting_age':'50d'}
    board.store.ingest('simplify:newgrad',[source],'age-update')
    assert not board.queue('newgrad')['jobs']
    source['description']='Requires active security clearance'
    board.store.ingest('simplify:newgrad',[source],'material-update')
    assert len(board.queue('newgrad')['jobs'])==1

def test_private_browser_login_csrf_and_manual_submission(board):
    server=create_server(board.store,ORIGIN)
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as client:
        assert client.get('/').status_code==200
        assert 'Data Scientist' not in client.get('/').text
        assert client.get('/api/jobs').status_code==401
        pending=client.get('/api/session').json()
        assert not pending['authenticated']
        assert client.get('/api/jobs').status_code==401
        WebAccess(board.store,ORIGIN).approve(pending['request_id'])
        assert client.get('/api/session').json()['authenticated']
        row=client.get('/api/jobs').json()['jobs'][0]
        body={'action':'submitted','job_id':row['id'],'version':row['application_version'],'reference':'Owner saw official success page','key':'manual-success-001'}
        assert client.post('/api/actions',json=body).status_code==403
        done=client.post('/api/actions',json=body,headers={'Origin':ORIGIN})
        assert done.status_code==200,done.text
        assert board.store.get_jobs([row['id']])[0]['status']=='submitted'
        assert board.store.progress()['counts']['submitted']==1
        assert client.get('/assets/board.js').status_code==200
        assert client.delete('/api/session',headers={'Origin':ORIGIN}).status_code==200
        assert client.get('/api/jobs').status_code==401


def test_closed_application_history_remains_visible(board):
    row=board._rows('newgrad')[0]
    board.mark_submitted(row['id'],0,'Test owner receipt','closed-history')
    board.store.ingest('simplify:newgrad',[{**observation(url='https://example.org/same'),'title':'Data Scientist','kind':'newgrad','active':False}],'closed')
    result=board.list(status='submitted')
    assert result['total']==1 and result['jobs'][0]['active'] is False
