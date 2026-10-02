import time

import pytest
from starlette.testclient import TestClient

from jobs_radar.board import Board
from jobs_radar.identity import identity, stable_id
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_store import observation


def test_date_filter_uses_first_repo_sync_not_publication_or_jobright_history(tmp_path):
    store=Store(tmp_path/'dates.sqlite');board=Board(store)
    now=time.time();start=now-3600;end=start+86400
    rows=[{**observation(url='https://example.org/'+key),'source_id':key,'posted_at':now-3*86400}
          for key in ['yesterday','today','later']]
    store.ingest('simplify:newgrad',rows,'sync')
    ids={r['source_id']:stable_id(identity(r['apply_url'])) for r in rows}
    with store.connect(True) as c:
        for key,added in [('yesterday',start-1),('today',start),('later',start+100)]:
            c.execute('UPDATE observations SET first_seen=? WHERE job_id=?',(added,ids[key]))
        # Earlier retired Jobright discovery cannot hide today's first approved-repo appearance.
        c.execute('UPDATE jobs SET first_seen=?',(start-86400,))
    def selected(lo,hi):
        return [r['id'] for r in board.list(added_since=lo,added_before=hi)['jobs']]
    assert selected(start,end)==[ids['later'],ids['today']]
    assert selected(start-86400,start)==[ids['yesterday']]
    store.ingest('simplify:newgrad',rows,'another-hour')
    assert selected(start,end)==[ids['later'],ids['today']]
    assert board.list()['total']==3
    # A newly arriving role appears without changing the selected calendar day.
    new={**observation(url='https://example.org/new'),'source_id':'new'}
    store.ingest('simplify:newgrad',[*rows,new],'late-arrival')
    assert len(selected(start,end))==3


def test_private_date_api_parses_bounds_and_rejects_invalid_dates(tmp_path):
    store=Store(tmp_path/'api.sqlite')
    store.ingest('simplify:newgrad',[observation()],'sync')
    origin='http://127.0.0.1:8796';server=create_server(store,origin)
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        pending=client.get('/api/session').json()
        WebAccess(store,origin).approve(pending['request_id'])
        start=time.time()-100;end=start+86400
        assert client.get('/api/jobs',params={'added_since':start,'added_before':end}).json()['total']==1
        assert client.get('/api/jobs',params={'added_since':start-86400,'added_before':start}).json()['total']==0
        for params in [{'added_since':'nan'},{'added_before':'inf'},{'added_since':end,'added_before':start}]:
            assert client.get('/api/jobs',params=params).status_code==400


def test_all_dates_and_optional_day_week_bounds_include_older_open_roles(tmp_path):
    store=Store(tmp_path/'history.sqlite');board=Board(store)
    now=time.time()
    for kind in ('newgrad','internship'):
        rows=[{**observation(url=f'https://example.org/{kind}-{age}'),
               'source_id':str(age),'kind':kind,'posted_at':now-90*86400}
              for age in (0.5,3,30)]
        store.ingest('simplify:'+kind,rows,'backfill',scoped_only=True)
        with store.connect(True) as c:
            for row,age in zip(rows,(0.5,3,30)):
                c.execute('UPDATE observations SET first_seen=? WHERE stream=? AND source_id=?',
                          (now-age*86400,'simplify:'+kind,row['source_id']))
        assert board.list(kind=kind,status='recent')['total']==3
        assert board.list(kind=kind,added_since=now-86400,added_before=now)['total']==1
        assert board.list(kind=kind,added_since=now-7*86400,added_before=now)['total']==2
        assert board.list(kind=kind,added_since=now-31*86400,added_before=now-29*86400)['total']==1
    assert board.filter_counts(status='recent')['total']==6
    assert board.filter_counts(status='recent',added_since=now-7*86400,added_before=now)['total']==4
