"""Read-path regressions: indexed browsing, current writes, bounded hydration."""
import json
import sqlite3
import time
from datetime import datetime, timezone
from contextlib import contextmanager

import pytest
from jobs_radar.board import Board
from jobs_radar.store import Store
from jobs_radar.management import Management
from jobs_radar.application_records import counts
from test_store import observation


def source(i=0, **changes):
    return {**observation(url=f'https://example.org/role/{i}'), 'source_id':str(i),
            'kind':'newgrad','posted_at':time.time()-1000, **changes}


def test_first_collection_survives_source_cleanup_and_rediscovery(tmp_path, monkeypatch):
    now=time.time();first=now;monkeypatch.setattr(time,'time',lambda:now)
    store=Store(tmp_path/'rediscovery.sqlite');board=Board(store)
    row=source();store.ingest('simplify:newgrad',[row],'first')
    jid=board.list()['jobs'][0]['id']
    with store.connect(True) as c:
        c.execute('DELETE FROM search_index WHERE job_id=?',(jid,))
        c.execute('DELETE FROM observations WHERE job_id=?',(jid,))
    now+=2*86400
    store.ingest('simplify:newgrad',[{**row,'posted_at':now-10}],'rediscovered')
    assert board.list()['jobs'][0]['added_at']==first
    assert board.list(added_since=first+86400)['total']==0
    # A full version-triggered index rebuild must retain the same timestamp.
    with store.connect(True) as c:
        c.execute('DELETE FROM board_index_version')
    assert Board(Store(store.path)).list()['jobs'][0]['added_at']==first


@pytest.mark.parametrize('stream,kind',[
    ('simplify:newgrad','newgrad'),
    ('simplify:internship','internship'),
    ('jobright:newgrad:us:swe','newgrad'),
])
def test_first_collection_uses_all_sources_even_outside_current_kind_or_scope(tmp_path,stream,kind):
    store=Store(tmp_path/'earliest.sqlite');board=Board(store)
    row=source();store.ingest('simplify:newgrad',[row],'current')
    rows=[{**row,'source_id':'older','kind':kind}]
    if stream=='simplify:newgrad': rows.append(row)
    store.ingest(stream,rows,'other')
    earliest=time.time()-7*86400
    with store.connect(True) as c:
        c.execute("UPDATE observations SET first_seen=?,present=0 WHERE source_id='older'",(earliest,))
    assert board.list()['jobs'][0]['added_at']==earliest


def test_collection_order_is_identical_with_without_range_and_across_pages(tmp_path,monkeypatch):
    now=time.time();start=now;monkeypatch.setattr(time,'time',lambda:now)
    store=Store(tmp_path/'dates.sqlite');board=Board(store)
    earlier=source(1,posted_at=start-10)
    store.ingest('simplify:newgrad',[earlier],'earlier')
    now+=86400
    later=[source(i,posted_at=start-60*86400) for i in (2,3)]
    store.ingest('simplify:newgrad',[earlier,*later],'later')
    expected=board.list(status='unsubmitted')['jobs']
    assert [r['added_at'] for r in expected]==[now,now,start]
    assert [r['id'] for r in expected[:2]]==sorted(r['id'] for r in expected[:2])
    for filters in ({},{'added_since':start},{'added_before':now+1},
                    {'added_since':start,'added_before':now+1}):
        rows=[board.list(status='unsubmitted',page=p,page_size=1,**filters)['jobs'][0] for p in (1,2,3)]
        assert [r['id'] for r in rows]==[r['id'] for r in expected]
    assert board.list(added_since=now,added_before=now+1)['total']==2
    assert board.list(added_since=start,added_before=now)['total']==1
    # Updating the publisher's date must not move a previously collected job.
    store.ingest('simplify:newgrad',[{**earlier,'posted_at':now-1},*later],'publication-updated')
    assert [r['id'] for r in board.list()['jobs']]==[r['id'] for r in expected]


def test_repeated_lists_and_counts_do_not_rebuild_sources_or_query_each_progress(tmp_path, monkeypatch):
    store=Store(tmp_path/'indexed.sqlite');board=Board(store)
    sources=[source(i) for i in range(170)]
    store.ingest('simplify:newgrad',sources,'seed')
    def unexpected(*args,**kwargs):
        pytest.fail('Browsing and unchanged ingestion must reuse stored job fields')
    monkeypatch.setattr('jobs_radar.board.fingerprint',unexpected)
    store.ingest('simplify:newgrad',sources,'unchanged')
    statements=[];connect=store.connect
    @contextmanager
    def traced(*args,**kwargs):
        with connect(*args,**kwargs) as c:
            c.set_trace_callback(statements.append)
            yield c
    monkeypatch.setattr(store,'connect',traced)
    first=board.list(status='recent',page_size=7)
    first['jobs'][0]['locations'].append('Never retained')
    second=board.list(status='recent',page_size=7,page=2)
    assert first['total']==second['total']==170
    assert len(first['jobs'])==len(second['jobs'])==7
    assert not {r['id'] for r in first['jobs']} & {r['id'] for r in second['jobs']}
    assert board.filter_counts(status='recent')['newgrad']['total']==170
    assert all('Never retained' not in r['locations'] for r in board.list(status='recent',page_size=7)['jobs'])
    assert not any('SELECT progress FROM applications WHERE job_id=' in sql for sql in statements)
    assert len([sql for sql in statements if sql.lstrip().upper().startswith(('SELECT','WITH'))])<70


def test_source_changes_from_another_connection_and_rollback_are_immediate(tmp_path):
    store=Store(tmp_path/'writes.sqlite');board=Board(store)
    row=source();store.ingest('simplify:newgrad',[row],'seed')
    jid=board.list()['jobs'][0]['id']
    with sqlite3.connect(store.path) as c:
        c.execute('UPDATE observations SET payload=? WHERE job_id=?',(json.dumps({**row,'title':'Backend Developer'}),jid))
    assert board.list(text='Backend')['total']==1
    assert board.list(text='Software')['total']==0
    with pytest.raises(RuntimeError):
        with store.connect(True) as c:
            c.execute('UPDATE observations SET payload=? WHERE job_id=?',(json.dumps({**row,'title':'Rolled back'}),jid))
            raise RuntimeError('abort writer')
    assert board.list(text='Backend')['total']==1
    other=Store(store.path)
    with other.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted',version=version+1 WHERE job_id=?",(jid,))
    assert board.list(status='unsubmitted')['total']==0
    assert board.list(status='submitted')['total']==1


def test_future_source_and_expired_undo_are_rechecked_without_a_write(tmp_path,monkeypatch):
    now=time.time();monkeypatch.setattr(time,'time',lambda:now)
    store=Store(tmp_path/'clock.sqlite');board=Board(store)
    store.ingest('simplify:newgrad',[source(posted_at=now+20)],'future')
    assert board.list(status='recent')['total']==0
    now+=21
    row=board.list(status='recent')['jobs'][0]
    board.mark_submitted(row['id'],0,'Synthetic successful application','clock-receipt')
    assert board.list(status='submitted')['jobs'][0]['can_undo_submission']
    now+=86400
    assert not board.list(status='submitted')['jobs'][0]['can_undo_submission']


def test_company_exception_tracks_other_source_disappearance(tmp_path):
    store=Store(tmp_path/'company.sqlite');board=Board(store)
    store.ingest('simplify:newgrad',[source(company='Example Corporation',locations=['Miami, FL'])],'base')
    store.ingest('simplify:internship',[source(1,kind='internship',company='Example Corporation',section='FAANG+')],'flag')
    assert board.list(region='focus_remote')['total']==1
    store.ingest('simplify:internship',[source(2,kind='internship',company='Other')],'gone')
    assert board.list(region='focus_remote')['total']==0


def test_header_counts_do_not_build_records_and_light_snapshot_omits_progress(tmp_path,monkeypatch):
    store=Store(tmp_path/'totals.sqlite');management=Management(store)
    now=time.time();today=now-3600;week=today-3*86400
    store.ingest('simplify:newgrad',[source(i) for i in range(5)],'seed')
    with store.connect(True) as c:
        ids=[r[0] for r in c.execute('SELECT job_id FROM applications ORDER BY job_id')]
        for jid,stamp,deleted in zip(ids,[now-10,today-10,week-10,now+100,now-10],[0,0,0,0,1]):
            c.execute('UPDATE applications SET record=?,deleted=? WHERE job_id=?',
                (json.dumps({'date':datetime.fromtimestamp(stamp,timezone.utc).isoformat()}),deleted,jid))
    monkeypatch.setattr('jobs_radar.application_records.read',lambda *args:pytest.fail('No full application history'))
    assert counts(store,today,week)=={'today':1,'week':2}
    assert 'appliedList' not in management.snapshot(include_applications=False)
    for start in (float('nan'),float('inf'),now+86400):
        with pytest.raises(ValueError):counts(store,start,week)


@pytest.mark.parametrize('path,method',[('/api/jobs','list'),('/api/filter-counts','filter_counts')])
def test_slow_board_reads_do_not_block_session_requests(tmp_path,monkeypatch,path,method):
    from threading import Event
    from concurrent.futures import ThreadPoolExecutor
    from starlette.testclient import TestClient
    from jobs_radar.server import create_server
    from jobs_radar.web import WebAccess
    store=Store(tmp_path/'threads.sqlite');origin='https://radar.test'
    server=create_server(store,origin)
    entered=Event();release=Event();original=getattr(Board,method)
    def slow(self,*args,**kwargs):
        entered.set()
        assert release.wait(5)
        return original(self,*args,**kwargs)
    with TestClient(server.streamable_http_app(),base_url=origin,headers={'X-Jobs-Protocol':'2'}) as client:
        rid=client.get('/api/session').json()['request_id'];WebAccess(store,origin).approve(rid)
        monkeypatch.setattr(Board,method,slow)
        with ThreadPoolExecutor(max_workers=2) as pool:
            request=pool.submit(client.get,path)
            try:
                assert entered.wait(2)
                session=pool.submit(client.get,'/api/session').result(timeout=1)
                assert session.json()['authenticated']
            finally:
                release.set()
            assert request.result(timeout=2).status_code==200


def test_summary_endpoint_keeps_auth_and_does_not_serialize_application_records(tmp_path,monkeypatch):
    from starlette.testclient import TestClient
    from jobs_radar.server import create_server
    from jobs_radar.web import WebAccess
    store=Store(tmp_path/'api.sqlite');origin='https://radar.test'
    server=create_server(store,origin)
    with TestClient(server.streamable_http_app(),base_url=origin,headers={'X-Jobs-Protocol':'2'}) as client:
        path='/api/application-counts?today=1&week=0'
        assert client.get(path).status_code==401
        assert client.get('/api/manage/state?applications=0').status_code==401
        rid=client.get('/api/session').json()['request_id'];WebAccess(store,origin).approve(rid)
        assert client.get(path).json()=={'today':0,'week':0}
        monkeypatch.setattr('jobs_radar.application_records.read',lambda *args:pytest.fail('Full history on a lightweight read'))
        assert 'appliedList' not in client.get('/api/manage/state?applications=0').json()
        assert client.get('/api/application-counts?today=nan&week=0').status_code==400
