import json
import time

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.luna_screening import classify
from jobs_radar.screening import reopen_automatic_reviews
from jobs_radar.store import Store
from test_store import observation


def test_citizenship_title_never_matches_an_explicit_negation():
    from jobs_radar.sponsorship import title_citizenship
    assert title_citizenship('Software Engineer - U.S. Citizenship Required')
    assert not title_citizenship('Software Engineer - U.S. Citizenship Not Required')
    assert not title_citizenship('US Citizenship Preferred - Python Required')


def source(kind='newgrad',label=None,**changes):
    return {**observation(url='https://example.org/job'),'kind':kind,'title':'Frontend Engineer',
            'source_url':'https://example.org/source','sponsorship':label,**changes}


@pytest.mark.parametrize('kind',['newgrad','internship'])
@pytest.mark.parametrize('label,reason',[(None,None),('Other',None),('Offers Sponsorship',None),
    ('Does Not Offer Sponsorship','no_sponsorship'),('U.S. Citizenship is Required','citizenship')])
def test_explicit_restrictions_only_apply_to_both_kinds(tmp_path,kind,label,reason):
    store=Store(tmp_path/'test.sqlite');board=Board(store)
    store.ingest('simplify:'+kind,[source(kind,label)],'test',scoped_only=True)
    row=board._rows(kind)[0]
    assert (row['screening']=='trash')==bool(reason)
    if reason: assert row['review']['reason']==reason
    assert row['status']=='not_started' and row['application_version']==0


def test_conflicting_positive_source_reopens_automatic_restriction(tmp_path):
    store=Store(tmp_path/'conflict.sqlite');board=Board(store)
    a=source(label='Does Not Offer Sponsorship')
    store.ingest('simplify:newgrad',[a],'negative',scoped_only=True)
    assert board.list()['total']==0
    store.ingest('simplify:newgrad',[a,source(label='Offers Sponsorship',source_id='positive')],'conflict',scoped_only=True)
    assert board.list()['total']==1
    assert board._rows('newgrad')[0]['screening']=='pending'


def test_provider_restriction_quote_can_be_validated_and_saved_for_internship(tmp_path):
    store=Store(tmp_path/'evidence.sqlite');board=Board(store)
    s=source('internship','Does Not Offer Sponsorship')
    store.ingest('simplify:internship',[s],'test',scoped_only=True)
    with store.connect(True) as c: c.execute('DELETE FROM job_screening')
    row=board._rows('internship')[0]
    def provider(request):
        return httpx.Response(200,json={'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps({'jobs':{'job_0':{
            'decision':'trash','reason':'明确不提供签证支持','evidence_quote':s['sponsorship']}}})}]}]})
    with httpx.Client(transport=httpx.MockTransport(provider)) as client: decisions,_=classify(client,[row])
    d=decisions[0]
    board.review(row['id'],'internship',d['decision'],d['reason_code'],d['reason'],[
        {'url':s['source_url'],'quote':d['evidence_quote'],'observed_at':'2026-10-05T00:00:00Z'}],
        row['fingerprint'],0,'sponsorship-test')
    assert board._rows('internship')[0]['review']['reason']=='no_sponsorship'


def test_policy_backfill_only_reopens_automatic_unprocessed_removals_once(tmp_path):
    store=Store(tmp_path/'migration.sqlite');board=Board(store)
    rows=[source(company='SpaceX',source_id=str(i),apply_url=f'https://example.org/{i}') for i in range(3)]
    store.ingest('simplify:newgrad',rows,'test',scoped_only=True)
    jobs=board._rows('newgrad')
    for i,row in enumerate(jobs):
        board.review(row['id'],'newgrad','trash','manual' if i==1 else 'off_target_role','Old exclusion',[
            {'url':row['source_url'],'quote':row['title'],'observed_at':'2026-10-05T00:00:00Z'}],
            row['fingerprint'],0,'old-removal-'+str(i),actor='web-owner' if i==1 else 'gpt-6-luna')
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted',version=1 WHERE job_id=?",(jobs[2]['id'],))
        reopen_automatic_reviews(c)
    rows={r['id']:r for r in board._rows('newgrad')}
    assert rows[jobs[0]['id']]['screening']=='pending'
    assert rows[jobs[1]['id']]['screening']=='trash'
    assert rows[jobs[2]['id']]['screening']=='trash'
    version=rows[jobs[0]['id']]['review_version']
    with store.connect(True) as c: reopen_automatic_reviews(c)
    assert board._rows('newgrad')[0]['review_version']==version
