import json

import httpx
import jsonschema
import pytest

from jobs_radar.board import Board
from jobs_radar.education import restriction
from jobs_radar.luna_screening import classify, ScreeningError
from jobs_radar.store import Store
from test_store import observation


def source(**changes):
    return {**observation(url='https://example.org/research'), 'kind':'internship',
            'company':'Autodesk', 'title':'Research Intern - Multimodal AI for Human Experience',
            'source_url':'https://example.org/listings.json', 'degrees':['PhD'], **changes}


@pytest.mark.parametrize('kind',['newgrad','internship'])
def test_degree_only_exclusion_happens_before_publication(tmp_path,kind):
    store=Store(tmp_path/'degree.sqlite');board=Board(store)
    store.ingest('simplify:'+kind,[source(kind=kind)],'sync',scoped_only=True)
    assert board.list(kind=kind)['total']==0
    row=board._rows(kind)[0]
    assert row['review']['reason']=='phd'
    assert json.loads(row['review']['evidence'])[0]['quote']=='PhD'
    assert row['status']=='not_started' and row['application_version']==0
    assert store.screen_titles()=={'newgrad':0,'internship':0}


@pytest.mark.parametrize('fields',[
    {'degrees':[]}, {'degrees':None}, {'degrees':["Bachelor's","Master's",'PhD']},
    {'degrees':['PhD','Unknown']}, {'degrees':'PhD'},
    {'title':'SWE Intern - BS/MS/PhD','degrees':['PhD']},
    {'title':'SWE Intern - B.S./M.S./Ph.D.','degrees':[]},
    {'title':'Research Intern - PhD preferred','degrees':[]},
    {'title':'Research Intern','degrees':[], 'apply_url':'https://example.org/PhD-research'},
])
def test_missing_mixed_or_ambiguous_degrees_are_not_rejected(tmp_path,fields):
    store=Store(tmp_path/'mixed.sqlite')
    store.ingest('simplify:internship',[source(**fields)],'sync',scoped_only=True)
    assert Board(store).list(kind='internship')['total']==1


def test_cross_source_conflict_reopens_only_automatic_degree_exclusion(tmp_path):
    store=Store(tmp_path/'conflict.sqlite');board=Board(store)
    store.ingest('simplify:internship',[source()],'sync',scoped_only=True)
    assert board.list(kind='internship')['total']==0
    store.ingest('speedyapply:SWE:internship',[source(source='speedyapply',degrees=None)],'unknown',scoped_only=True)
    assert board.list(kind='internship')['total']==0
    store.ingest('simplify:internship',[source(),source(source_id='mixed',degrees=["Master's",'PhD'])],'conflict',scoped_only=True)
    assert board.list(kind='internship')['total']==1
    assert board._rows('internship')[0]['screening']=='pending'


def test_existing_keep_is_corrected_but_submitted_and_manual_keep_are_protected(tmp_path):
    store=Store(tmp_path/'backfill.sqlite');board=Board(store)
    rows=[source(source_id=k,apply_url='https://example.org/'+k) for k in ('old','submitted','manual')]
    store.ingest('simplify:internship',rows,'legacy')
    jobs={r['apply_url'].rsplit('/',1)[-1]:r for r in board._rows('internship')}
    for key,r in jobs.items():
        board.review(r['id'],'internship','keep','eligible','Earlier keep',[],r['fingerprint'],0,'keep-'+key)
    board.mark_submitted(jobs['submitted']['id'],0,key='submission')
    with store.connect(True) as c:
        c.execute('UPDATE job_screening SET manual_keep=1 WHERE job_id=?',(jobs['manual']['id'],))
        before=[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    assert store.screen_titles()=={'newgrad':0,'internship':1}
    assert {r['apply_url'].rsplit('/',1)[-1] for r in board.list(kind='internship',status='recent')['jobs']}=={'submitted','manual'}
    with store.connect() as c:
        assert before==[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]


@pytest.mark.parametrize('title',['Postdoctoral Researcher','Post-doctoral AI Fellow','Postdoc Research Engineer'])
def test_postdoctoral_titles_are_explicit(title):
    assert restriction([source(title=title,degrees=[])])[1]==title


def test_degree_evidence_crosses_provider_validation_and_board_write(tmp_path):
    store=Store(tmp_path/'provider.sqlite');board=Board(store)
    store.ingest('simplify:internship',[source()],'legacy')
    row=board._rows('internship')[0]
    def provider(request):
        payload=json.loads(request.content)
        sent=json.loads(payload['input'])[0]['sources'][0]
        assert sent['degrees']==['PhD']
        value={'jobs':{'job_0':{'decision':'trash','reason':'来源明确仅限博士','evidence_quote':'PhD'}}}
        jsonschema.validate(value,payload['text']['format']['schema'])
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(value)}]}]})
    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        decisions,_=classify(client,[row])
    d=decisions[0]
    assert d['reason_code']=='phd'
    board.review(row['id'],'internship',d['decision'],d['reason_code'],d['reason'],[
        {'url':row['source_url'],'quote':d['evidence_quote'],'observed_at':'2026-10-05T00:00:00Z'}],row['fingerprint'],0,'degree-evidence')
    assert board.list(kind='internship')['total']==0


def test_mixed_degree_label_cannot_be_used_as_removal_evidence(tmp_path):
    store=Store(tmp_path/'bad-evidence.sqlite');board=Board(store)
    store.ingest('simplify:internship',[source(degrees=["Master's",'PhD'])],'legacy')
    row=board._rows('internship')[0]
    def provider(request):
        payload=json.loads(request.content)
        value={'jobs':{'job_0':{'decision':'trash','reason':'Wrongly exclude mixed degrees','evidence_quote':'PhD'}}}
        with pytest.raises(jsonschema.ValidationError):jsonschema.validate(value,payload['text']['format']['schema'])
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(value)}]}]})
    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        with pytest.raises(ScreeningError,match='evidence_mismatch'):classify(client,[row])
    with pytest.raises(ValueError,match='Doctoral removal'):
        board.review(row['id'],'internship','trash','phd','Wrong mixed-degree rejection',[
            {'url':row['source_url'],'quote':'PhD','observed_at':'2026-10-05T00:00:00Z'}],row['fingerprint'],0,'bad-degree-evidence')
    assert board.list(kind='internship')['total']==1


def test_legacy_mixed_title_exclusion_reopens_without_source_change(tmp_path):
    store=Store(tmp_path/'old-policy.sqlite');board=Board(store)
    s=source(title='Software Intern BS/MS/PhD',degrees=[])
    store.ingest('simplify:internship',[s],'legacy')
    r=board._rows('internship')[0]
    with store.connect(True) as c:
        c.execute('INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                  (r['id'],'internship','trash','phd','Legacy title-only policy','[]',r['fingerprint'],1,9999999999,1,0))
        c.execute('INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,?,?,?,?)',
                  (r['id'],'screening','sync-title-rule',1,json.dumps([r['id'],'internship'])))
    store.screen_titles()
    assert board._rows('internship')[0]['screening']=='pending'
    version=board._rows('internship')[0]['review_version']
    store.screen_titles()
    assert board._rows('internship')[0]['review_version']==version
