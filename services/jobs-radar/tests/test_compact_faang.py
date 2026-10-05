from starlette.testclient import TestClient
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from test_compact_screening import seed, mark


def test_independent_region_company_filters_and_kind_specific_counts(tmp_path):
    store,board=seed(tmp_path)
    for kind in ('newgrad','internship'):
        for row in board._rows(kind): mark(board,row,row['company'] in {'xAI','Duolingo'})
        assert board.list(kind=kind,region='focus_remote')['total']==4
        assert board.list(kind=kind,company_filter='1')['total']==2
        assert board.list(kind=kind,company_filter='1',region='ca')['total']==1
        assert board.list(kind=kind,company_filter='1',group='faang')['total']==0
        assert board.list(kind=kind,company_filter='1',exclude_companies='xAI')['total']==1
    before=store.progress()
    origin='http://127.0.0.1:8796'
    with TestClient(create_server(store,origin).streamable_http_app(),headers={'X-Jobs-Protocol':'2'},base_url=origin) as client:
        WebAccess(store,origin).approve(client.get('/api/session').json()['request_id'])
        params={'company_newgrad':'','company_internship':'1','region':'focus_remote','page_size':1}
        counts=client.get('/api/filter-counts',params=params).json()
        assert counts['total']==6
        for kind,expected in [('newgrad',4),('internship',2)]:
            result=client.get('/api/jobs',params={**params,'kind':kind}).json()
            assert result['total']==counts[kind]['total']==expected
            assert len(result['jobs'])==1
        assert client.get('/api/jobs?company_internship=bad').status_code==400
    assert store.progress()==before
