import pytest
from starlette.testclient import TestClient
from jobs_radar.board import Board
from jobs_radar.store import Store
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from test_store import observation


def test_company_exclusion_before_counts_pagination_and_without_mutation(tmp_path):
    store=Store(tmp_path/'exclude.sqlite');board=Board(store)
    for kind in ('newgrad','internship'):
        store.ingest('simplify:'+kind,[{
            **observation(company=company,url=f'https://example.org/{kind}/{i}'),
            'source_id':str(i),'kind':kind,
            'title':'Engineer for TikTok integrations' if company=='Apple' else 'Software Engineer',
        } for i,company in enumerate(['TikTok',' TIKTOK ','Apple','TikTok Contractor Agency'])],'fixture')
    before=store.progress()
    filters=dict(status='recent',exclude_companies='tiktok')
    for kind in ('newgrad','internship'):
        result=board.list(kind=kind,**filters,page_size=1)
        assert result['total']==2 and len(result['jobs'])==1
        assert result['application_counts']['not_started']==2
        all_rows=board.list(kind=kind,**filters)['jobs']
        assert {r['company'] for r in all_rows}=={'Apple','TikTok Contractor Agency'}
        assert board.list(kind=kind,status='recent',exclude_companies='TikTok，Apple')['total']==1
        assert board.list(kind=kind,status='recent')['total']==4
    assert board.filter_counts(**filters)['total']==4
    assert store.progress()==before
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0
    origin='http://127.0.0.1:8796'
    with TestClient(create_server(store,origin).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        WebAccess(store,origin).approve(client.get('/api/session').json()['request_id'])
        params={**filters,'kind':'internship','group':'faang'}
        result=client.get('/api/jobs',params=params)
        assert result.status_code==200 and result.json()['total']==1
        assert result.json()['jobs'][0]['company']=='Apple'
        assert client.get('/api/filter-counts',params=params).json()['total']==2
    with pytest.raises(ValueError):board.list(exclude_companies=','.join('company'+str(i) for i in range(21)))
