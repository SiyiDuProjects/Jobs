import pytest
from starlette.testclient import TestClient

from jobs_radar.board import Board
from jobs_radar.intern_companies import COMPANIES, EXCLUDED_COMPANIES, recommended_intern_company, matches_company_review
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_store import observation


def seed(tmp_path):
    store=Store(tmp_path/'companies.sqlite')
    for kind in ('newgrad','internship'):
        store.ingest('simplify:'+kind,[{
            **observation(company=company,url=f'https://example.org/{kind}/{i}'),
            'source_id':str(i),'kind':kind,
        } for i,company in enumerate(['Google','Perpay','Veeam','Unreviewed Employer','Viam'])],'company-filter-test')
    return store,Board(store)


def test_reviewed_names_and_aliases_only():
    assert len(COMPANIES)==118
    assert len(EXCLUDED_COMPANIES)==143
    assert matches_company_review('Apple')
    assert matches_company_review('Unreviewed Employer')
    assert not matches_company_review('Perpay')
    assert recommended_intern_company('  veeam  ')
    assert recommended_intern_company('VEEAM SOFTWARE')
    assert recommended_intern_company('MSD')
    assert not recommended_intern_company('GSK Internships & Co-ops powered by Atrium')
    assert not recommended_intern_company('Google Contractor Agency')
    assert not recommended_intern_company('Perpay')


def test_every_reviewed_alias_obeys_the_browsing_policy():
    # The historical review report is not a checkout dependency. Exercise the
    # shipped decisions and alias boundaries without loading private archives.
    for company, aliases in COMPANIES.items():
        for name in [company, *aliases]:
            assert recommended_intern_company(name), name
            assert matches_company_review(name), name
            assert recommended_intern_company('  '+name.upper()+'  '), name
            assert not recommended_intern_company(name+' Contractor Agency'), name
    for company, aliases in EXCLUDED_COMPANIES.items():
        for name in [company, *aliases]:
            assert not recommended_intern_company(name), name
            assert not matches_company_review('  '+name.upper()+'  '), name
            assert matches_company_review(name+' Unreviewed Subsidiary'), name


def test_company_filter_is_internship_only_before_pagination(tmp_path):
    store,board=seed(tmp_path)
    for flag in ('','1'):
        full=board.list(kind='newgrad',intern_companies=flag,page_size=1)
        assert full['total']==5
    selected=board.list(kind='internship',intern_companies='1',page_size=1)
    assert selected['total']==4 and len(selected['jobs'])==1
    assert board.list(kind='internship')['total']==5
    assert {j['company'] for j in board.list(kind='internship',intern_companies='1')['jobs']}=={'Google','Veeam','Viam','Unreviewed Employer'}
    counts=board.filter_counts(intern_companies='1',status='recent')
    assert counts['newgrad']['total']==5 and counts['internship']['total']==4 and counts['total']==9
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0
    # The screening queue remains complete; this preference is not a hard removal rule.
    assert len(board.queue('internship')['jobs'])==5
    with pytest.raises(ValueError): board.list(intern_companies='true')


def test_old_apple_and_unreviewed_unknown_roles_survive_refined_faang_view(tmp_path):
    import time
    store=Store(tmp_path/'historical-apple.sqlite');board=Board(store)
    rows=[{**observation(company='Apple',url=f'https://example.org/apple-{i}'),
           'source_id':str(i),'kind':'internship','locations':['USA'],'source_url':'https://example.org/source',
           'title':title,'posted_at':time.time()-116*86400}
          for i,title in enumerate(['Software Undergrad Engineering Internships','Software PhD Internships','Software Engineering Masters Internships'])]
    rows.append({**rows[0],'source_id':'unknown','apply_url':'https://example.org/unknown',
                 'company':'Unreviewed Employer','title':'Intern','locations':[]})
    store.ingest('simplify:internship',rows,'backfill',scoped_only=True)
    filters=dict(kind='internship',status='recent',roles='software,ai_ml,quant,unknown',region='focus_remote',intern_companies='1')
    assert board.list(**filters)['total']==3
    assert board.list(**filters,group='faang')['total']==2


def test_trash_and_application_history_are_preserved(tmp_path):
    store,board=seed(tmp_path)
    job=next(j for j in board.list(kind='internship')['jobs'] if j['company']=='Perpay')
    board.review(job['id'],'internship','trash','manual','User deletion',[
        {'url':job['apply_url'],'quote':'Manual test deletion','observed_at':'2026-09-16T06:00:00Z'}
    ],job['fingerprint'],0,'company-trash-001',actor='web-owner')
    assert board.list(kind='internship',view='trash',intern_companies='1')['total']==1
    full=next(j for j in board.list(kind='newgrad')['jobs'] if j['company']=='Perpay')
    board.mark_submitted(full['id'],0,key='company-submit-001')
    assert board.list(kind='newgrad',status='submitted',intern_companies='1')['total']==1
    assert board.list(kind='newgrad',status='recent',intern_companies='1')['total']==5


def test_private_api_keeps_fulltime_even_with_intern_flag(tmp_path):
    store,board=seed(tmp_path); origin='http://127.0.0.1:8796'
    with TestClient(create_server(store,origin).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        assert client.get('/api/jobs?intern_companies=1').status_code==401
        WebAccess(store,origin).approve(client.get('/api/session').json()['request_id'])
        params={'intern_companies':'1','roles':'software','region':'focus_remote','status':'recent'}
        counts=client.get('/api/filter-counts',params=params).json()
        assert counts['newgrad']['total']==5 and counts['internship']['total']==4
        for kind in ('newgrad','internship'):
            res=client.get('/api/jobs',params={**params,'kind':kind})
            assert res.status_code==200 and res.json()['total']==counts[kind]['total']
        assert client.get('/api/jobs?intern_companies=garbage').status_code==400
