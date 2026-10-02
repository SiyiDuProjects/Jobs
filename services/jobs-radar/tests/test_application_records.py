import json
from jobs_radar.store import Store
from jobs_radar.management import Management
from jobs_radar.board import Board
from jobs_radar.application_records import read,reconcile,ApplicationRecords
from jobs_radar.job_match import job_key
from test_store import observation

URL='https://hpe.wd5.myworkdayjobs.com/en-US/jobsathpe/job/San-Jose/AI-Workflow_1211885'
ALIAS=URL.replace('San-Jose','San-Jose%2C-California')

def record(url=ALIAS,status='applied'):
    return dict(jobTitle='AI Workflow',jobLink=url,companyName='HPE',companyLink='',
                date='2026-09-18T12:00:00Z',status=status,profileName='Newgrad')


def test_company_careers_home_is_metadata_not_a_posting_identity(tmp_path):
    import pytest
    from jobs_radar.application_records import validate
    value = {**record(), 'companyLink': 'https://job-boards.greenhouse.io/example'}
    assert job_key(value['companyLink']) is None
    store = Store(tmp_path / 'company.sqlite')
    ApplicationRecords(store).mutate([{'action': 'create', 'value': value}], 'company-home')
    assert ApplicationRecords(store).list()['applications'][0]['companyLink'] == value['companyLink']
    for url in ['javascript:alert(1)', 'https://user:secret@example.test/', 'https://example.test:invalid', 'https://bad host/']:
        with pytest.raises(ValueError, match='company URL'):
            validate({**value, 'companyLink': url})

def test_external_record_then_later_ingestion_and_duplicate_preserves_progress(tmp_path):
    s=Store(tmp_path/'r.db');m=Management(s)
    ApplicationRecords(s).mutate([dict(action='create',value=record(status='interview'))],'external-create')
    with s.connect() as c:assert c.execute('SELECT count(*) FROM jobs').fetchone()[0]==0
    s.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=URL)],'test')
    with s.connect() as c:assert c.execute('SELECT status FROM applications').fetchone()[0]=='submitted_unconfirmed'
    snap=m.snapshot()['appliedList']
    import pytest
    from jobs_radar.profiles import ProfileConflict
    with pytest.raises(ProfileConflict):ApplicationRecords(s).mutate([dict(action='create',value=record(URL))],'duplicate-create')
    result=m.snapshot()
    assert len(result['appliedList']['value'])==1
    assert result['appliedList']['value'][0]['status']=='interview'


def test_manual_confirmation_adds_record_and_undo_stays_undone(tmp_path):
    s=Store(tmp_path/'r.db');s.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=URL)],'test')
    with s.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]
    b=Board(s);b.mark_submitted(jid,0,key='manual-record')
    with s.connect() as c:
        rows=read(c);assert len(rows)==1 and rows[0]['jobLink']==URL
    b.undo_submitted(jid,1,'undo-record')
    with s.connect(True) as c:
        assert read(c)==[];assert reconcile(c)==0
        assert c.execute('SELECT status FROM applications').fetchone()[0]=='not_started'

def test_manual_record_updates_source_alias_and_undo_restores_both(tmp_path):
    s=Store(tmp_path/'r.db');s.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=URL)],'test')
    s.ingest('simplify:newgrad',[observation(url=ALIAS)],'alias')
    with s.connect() as c:
        ids=[r[0] for r in c.execute('SELECT id FROM jobs')];assert len(ids)==1
    b=Board(s);b.mark_submitted(ids[0],0,key='manual-alias')
    with s.connect() as c:
        assert len(read(c))==1
        assert {r[0] for r in c.execute('SELECT status FROM applications')}=={'submitted'}
    b.undo_submitted(ids[0],1,'undo-alias')
    with s.connect(True) as c:
        assert read(c)==[];assert reconcile(c)==0
        assert {r[0] for r in c.execute('SELECT status FROM applications')}=={'not_started'}

def test_history_links_without_open_reminder_and_never_cross_company(tmp_path):
    s=Store(tmp_path/'r.db');s.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=URL)],'test')
    with s.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]
    Board(s).opened(jid,'newgrad',dismiss=True)
    m=Management(s)
    ApplicationRecords(s).mutate([dict(action='create',value=record(ALIAS.replace('hpe.wd5','other.wd5')))],'other-company')
    with s.connect() as c:assert c.execute('SELECT status FROM applications').fetchone()[0]=='not_started'
    ApplicationRecords(s).mutate([dict(action='create',value=record())],'matching-company')
    with s.connect() as c:assert c.execute('SELECT status FROM applications').fetchone()[0]=='submitted_unconfirmed'

def test_match_rules_company_scope_and_application_paths():
    assert job_key(URL)==job_key(ALIAS)
    assert job_key(URL)!=job_key(URL.replace('hpe.wd5','other.wd5'))
    assert job_key('https://jobs.ashbyhq.com/acme/123/application')==job_key('https://jobs.ashbyhq.com/acme/123')
    assert job_key('https://jobs.ashbyhq.com/acme/123')!=job_key('https://jobs.ashbyhq.com/other/123')
    assert job_key('https://boards.greenhouse.io/acme/jobs/123')==job_key('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=test')
    assert job_key('https://job-boards.greenhouse.io/acme/jobs/123')!=job_key('https://job-boards.greenhouse.io/other/jobs/123')
