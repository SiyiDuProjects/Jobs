import json
import time

import pytest

from jobs_radar.board import Board
from jobs_radar.job_duplicates import consolidate
from jobs_radar.job_match import job_key
from jobs_radar.store import Store
from test_store import observation

URL = 'https://hpe.wd5.myworkdayjobs.com/en-US/jobs/job/San-Jose/AI_1211885'
ALIAS = URL.replace('/en-US/jobs/', '/JOBS/').replace('San-Jose', 'San-Jose-CA')


def legacy_pair(store):
    store.ingest('simplify:newgrad', [observation(url=URL)], 'initial')
    first = store.search()['jobs'][0]['id']
    second = 'f' * 24
    row = {**observation('speedyapply', url=ALIAS), 'source_id': 'legacy'}
    with store.connect(True) as c:
        c.execute('INSERT INTO jobs(id,identity,first_seen,last_seen) VALUES(?,?,?,?)', (second, ALIAS, time.time(), time.time()))
        c.execute('UPDATE jobs SET job_key=? WHERE id=?',(job_key(ALIAS),second))
        c.execute("INSERT INTO applications(job_id,status,updated) VALUES(?,'not_started',?)", (second,time.time()))
        c.execute("INSERT INTO observations VALUES('speedyapply:SWE:newgrad','legacy',?,?,0,0,1)", (second,json.dumps(row)))
        c.execute("INSERT INTO search_index SELECT 'speedyapply:SWE:newgrad','legacy',?,'speedyapply',kind,category,title_company,locations,h1b,active,visible,posted_at FROM search_index LIMIT 1", (second,))
    return first, second


@pytest.mark.parametrize('status', ['submitted', 'not_started'])
def test_consolidation_preserves_old_records_counts_sources_and_stale_id_read(tmp_path,status):
    store = Store(tmp_path/'jobs.db'); ids = legacy_pair(store)
    with store.connect(True) as c:
        c.execute('UPDATE applications SET status=?', (status,))
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        assert consolidate(c)['mergeable'] == 1
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0
        report = consolidate(c, dry_run=False)
        assert report['mergeable'] == 1
        assert before == [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        assert consolidate(c)['groups'] == 0
    jobs = store.search()['jobs']
    assert len(jobs) == 1 and len(jobs[0]['all_sources']) == 2
    assert store.progress()['counts'][status] == 1
    assert len(store.get_jobs(ids)) == 1
    assert Board(store).list(status='')['total'] == 1
    store.ingest('speedyapply:SWE:newgrad', [{**observation('speedyapply',url=ALIAS), 'source_id':'legacy'}], 'again')
    assert len(store.search()['jobs']) == 1
    alias = report['details'][0]['aliases'][0]
    with pytest.raises(ValueError, match='合并'):
        Board(store).mark_submitted(alias,0,key='stale-submit-key')


@pytest.mark.parametrize('protection', ['outcome','removal','undo'])
def test_consolidation_holds_uncertain_or_in_flight_groups(tmp_path,protection):
    store = Store(tmp_path/'jobs.db'); first, second = legacy_pair(store)
    with store.connect(True) as c:
        if protection == 'outcome':
            c.execute("UPDATE applications SET status='submitted_unconfirmed' WHERE job_id=?", (second,))
            c.execute("UPDATE applications SET status='needs_input' WHERE job_id=?", (first,))
        if protection == 'removal': c.execute("INSERT INTO job_screening VALUES(?,'newgrad','trash','manual','test','[]','fp',?, ?,1,0)", (first,time.time(),time.time()+86400))
        if protection == 'undo': c.execute("INSERT INTO owner_submission_undo VALUES(?,1,?,'{}','[]')", (first,time.time()+86400))
        assert consolidate(c, dry_run=False)['held'] == 1
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0


def test_expired_deleted_alias_stays_deleted_after_consolidation(tmp_path):
    store = Store(tmp_path/'jobs.db'); first, second = legacy_pair(store)
    with store.connect(True) as c:
        c.execute("INSERT INTO job_screening VALUES(?,'newgrad','trash','manual','test','[]','fp',0,1,1,0)", (second,))
        assert consolidate(c, dry_run=False)['mergeable'] == 1
    assert store.search()['jobs'] == []


def test_collection_does_not_silently_merge_conflicts_and_claim_blocks_applied_alias(tmp_path):
    store=Store(tmp_path/'jobs.db');first,second=legacy_pair(store)
    with store.connect(True) as c:c.execute("UPDATE applications SET status='submitted' WHERE job_id=?",(first,))
    store.ingest('speedyapply:SWE:newgrad',[{**observation('speedyapply',url=ALIAS),'source_id':'legacy'}],'refresh')
    with store.connect() as c:
        assert c.execute("SELECT job_id FROM observations WHERE source_id='legacy'").fetchone()[0]==second
    from jobs_radar.extension_sync import ExtensionSync
    assert not ExtensionSync(store).resolve({'url':ALIAS})['queue']['allowed']


@pytest.mark.parametrize('status',['submitted','needs_input','skipped','submitted_unconfirmed'])
def test_untouched_duplicate_automatically_inherits_existing_outcome_without_overwriting_history(tmp_path,status):
    store=Store(tmp_path/'jobs.db');first,second=legacy_pair(store)
    with store.connect(True) as c:
        c.execute('UPDATE applications SET status=?,version=3 WHERE job_id=?',(status,second))
        assert consolidate(c,False)['mergeable']==1
    result=store.search()['jobs']
    assert len(result)==1 and result[0]['id']==second and result[0]['status']==status
    with store.connect() as c:assert c.execute('SELECT status FROM applications WHERE job_id=?',(first,)).fetchone()[0]=='not_started'


def test_explicit_owner_reset_is_not_reversed_by_alias_consolidation(tmp_path):
    store=Store(tmp_path/'jobs.db');first,second=legacy_pair(store)
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted' WHERE job_id=?",(second,))
        c.execute('UPDATE applications SET version=2 WHERE job_id=?',(first,))
        assert consolidate(c,False)['details'][0]['reason']=='owner_reset_conflict'




def test_new_ingestion_reuses_applied_id_across_locale_title_and_application_steps(tmp_path):
    store = Store(tmp_path/'jobs.db')
    store.ingest('simplify:newgrad', [observation(url=URL)], 'initial')
    first = store.search()['jobs'][0]['id']
    with store.connect(True) as c: c.execute("UPDATE applications SET status='submitted' WHERE job_id=?", (first,))
    for suffix in ('','/apply','/apply/applyManually','/apply/autofillWithResume'):
        alias = ALIAS.replace('AI_', 'Renamed-Engineer_') + suffix
        store.ingest('speedyapply:SWE:newgrad', [observation('speedyapply',url=alias)], 'alias')
        assert store.search()['jobs'][0]['id'] == first
        assert store.search(statuses=['not_started'])['jobs'] == []
        assert store.progress()['counts'] == {'submitted':1}


@pytest.mark.parametrize('source,page', [
    (URL, ALIAS+'/apply/applyManually'),
    ('https://apply.careers.microsoft.com/careers/job/1970393556998613', 'https://apply.careers.microsoft.com/careers/apply?pid=1970393556998613'),
    ('https://careers.withwaymo.com/jobs?gh_jid=8203191', 'https://careers.withwaymo.com/jobs/2027-summer-intern-phd-learning-based-behavior?gh_jid=8203191'),
    ('https://acme.icims.com/jobs/123/engineer/job', 'https://acme.icims.com/jobs/123/renamed/login'),
    ('https://careers.amd.com/jobs/90950?icims=1', 'https://careers.amd.com/careers-home/jobs/90950'),
])
def test_observed_redirects_match_only_the_same_requisition(source,page):
    assert job_key(source) and job_key(source) == job_key(page)
    assert job_key(source) != job_key(page.replace('1211885','1211886').replace('1970393556998613','1970393556998614').replace('8203191','8203192').replace('/123/','/124/').replace('90950','90951'))
    assert job_key(source) != job_key('https://unrelated.example'+page.split('.com',1)[-1])

