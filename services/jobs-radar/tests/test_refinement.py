import time
import pytest


def test_unknown_review_does_not_erase_provisional_title_hint():
    from jobs_radar.role_families import classify
    assert classify([{'title':'Software Engineer Intern'}],{'fingerprint':'v1','family':'unknown'},'v1')==('software','title')
    assert classify([{'title':'Software Engineer Intern'}],{'fingerprint':'v1','family':'data_engineering'},'v1')==('data_engineering','duties')
from starlette.testclient import TestClient
from jobs_radar.board import Board
from jobs_radar.store import Store
from jobs_radar.role_families import title_family
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from test_store import observation


@pytest.mark.parametrize('title,family',[
    ('AI Merchandise Pricer','unknown'),('AI Marketing Intern','unknown'),
    ('Engineering Intern','unknown'),('AI Intern','unknown'),
    ('Software Engineer - Developer Support','qa_ops_support'),
    ('Software Test Engineer','qa_ops_support'),('Site Reliability Engineer','qa_ops_support'),
    ('Embedded Software Engineer','hardware'),('Data Engineering Intern','data_engineering'),
    ('Machine Learning Intern','ai_ml'),('Research Scientist - AI','ai_ml'),
    ('Quantitative Trading Summer Analyst','quant'),('Frontend Developer','software'),
])
def test_primary_occupation_is_not_a_broad_engineer_or_ai_match(title,family):
    assert title_family(title)==family


def seed(tmp_path):
    s=Store(tmp_path/'refine.sqlite')
    for kind in ('newgrad','internship'):
        s.ingest('simplify:'+kind,[{**observation(url=f'https://example.org/{kind}/{i}'),
            'source_id':str(i),'title':title,'kind':kind,'locations':[loc]}
            for i,(title,loc) in enumerate([
                ('Software Engineer','Seattle, WA'),('Data Engineer','San Francisco, CA'),
                ('Quantitative Developer','NYC'),('Engineering Intern','San Francisco, CA'),
                ('Machine Learning Engineer','Chicago, IL')])],'fixture')
    return s,Board(s)


def test_optional_roles_counts_dates_status_and_sync_do_not_delete(tmp_path):
    s,b=seed(tmp_path)
    core='software,ai_ml,quant'
    assert b.filter_counts(roles=core,status='recent')['total']==6
    counts=b.filter_counts(roles=core,region='focus_remote',status='recent',page=99)
    assert counts['total']==4 and counts['newgrad']['total']==2
    assert b.list(roles=core,region='focus_remote',page_size=1)['total']==2
    assert b.list(roles='none')['total']==0
    assert b.list(roles='unknown')['jobs'][0]['title']=='Engineering Intern'
    job=b.list(roles='software')['jobs'][0]
    b.mark_submitted(job['id'],0,key='refine-submit')
    counts=b.filter_counts(roles=core,region='focus_remote',status='recent')
    assert counts['total']==4 and counts['newgrad']['not_started']==1
    assert b.filter_counts(roles=core,region='focus_remote',status='not_started')['total']==3
    assert b.filter_counts(roles=core,added_since=time.time()+1)['total']==0
    s.ingest('simplify:newgrad',[{**observation(url='https://example.org/new'),
        'source_id':'new','title':'Backend Developer','locations':['Seattle, WA']}],'new-sync')
    assert b.list(roles=core,region='focus_remote')['total']==1
    with s.connect() as c:
        assert c.execute("SELECT count(*) FROM job_screening WHERE state='trash'").fetchone()[0]==0
    with pytest.raises(ValueError): b.list(roles='invented')


def test_duty_classification_overrides_title_with_evidence_and_version(tmp_path):
    s,b=seed(tmp_path)
    job=b.list(roles='software')['jobs'][0]
    args=(job['id'],'newgrad','keep','eligible','Read official responsibilities',[],job['fingerprint'],0,'role-test-001')
    with pytest.raises(ValueError,match='evidence'): b.review(*args,role_family='data_engineering')
    evidence=[{'url':job['apply_url'],'quote':'Build and maintain data ingestion pipelines.','observed_at':'2026-09-16T04:00:00Z'}]
    result=b.review(*args,role_family='data_engineering',role_evidence=evidence)
    assert b.review(*args,role_family='data_engineering',role_evidence=evidence)==result
    assert b.list(roles='software')['total']==0
    row=next(r for r in b.list(roles='data_engineering')['jobs'] if r['id']==job['id'])
    assert row['role_basis']=='duties'
    assert b.list(kind='internship',roles='software')['total']==1
    with pytest.raises(ValueError): b.review(*args,role_family='hardware',role_evidence=evidence)
    # A substantive source change invalidates the previous duty classification.
    source={**observation(url=job['apply_url']),'source_id':'0','title':'Customer Support Intern','locations':['Seattle, WA']}
    s.ingest('simplify:newgrad',[source],'changed-duties')
    row=b.list(roles='qa_ops_support')['jobs'][0]
    assert row['role_basis']=='title' and row['screening']=='pending'


def test_count_endpoint_is_private_and_matches_list(tmp_path):
    s,b=seed(tmp_path);origin='http://127.0.0.1:8796'
    with TestClient(create_server(s,origin).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as c:
        assert c.get('/api/filter-counts').status_code==401
        pending=c.get('/api/session').json();WebAccess(s,origin).approve(pending['request_id'])
        params={'roles':'software,quant','region':'focus_remote','status':'recent'}
        counts=c.get('/api/filter-counts',params=params).json()
        assert counts['total']==4
        for kind in ('newgrad','internship'):
            assert counts[kind]['total']==c.get('/api/jobs',params={**params,'kind':kind}).json()['total']
        assert c.get('/api/filter-counts?roles=oops').status_code==400

