import asyncio
import json
import time
from datetime import datetime, timezone

import pytest
from starlette.testclient import TestClient
from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.application_records import read, ApplicationRecords, upsert
from jobs_radar.management import Management
from jobs_radar.profiles import ProfileConflict
from jobs_radar.recruiting import Recruiting
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_application_records import record, URL, ALIAS
from test_store import observation
from test_recruiting import progress_args, configure_mailbox


def iso(offset=0):
    return datetime.fromtimestamp(time.time()+offset,timezone.utc).isoformat()


@pytest.fixture
def subject(tmp_path):
    s=Store(tmp_path/'progress.sqlite')
    s.ingest('simplify:newgrad',[observation(url=URL)],'progress')
    configure_mailbox(s)
    m=Management(s)
    from jobs_radar.board import Board
    with s.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]
    Board(s).mark_submitted(jid,0,key='initial-owner-confirmation')
    p=ApplicationProgress(s)
    aid=p.list()['applications'][0]['id']
    return s,m,p,aid


def update(p,aid,stage,**kwargs):
    version=p.list(application_id=aid)['applications'][0]['progress']['version']
    return p.update(aid,stage,version,'test-update-'+str(time.time_ns()),'Owner confirmed this application progress.',**kwargs)


def current(p,aid):return p.list(application_id=aid)['applications'][0]


def test_chart_uses_observed_steps_without_inventing_intermediate_rounds(subject):
    s,m,p,aid=subject
    update(p,aid,'assessment',assessment_type='screened')
    update(p,aid,'interview',interview_round=3)
    update(p,aid,'rejected')
    path=current(p,aid)['progress']['chart_path']
    assert [v['stage'] for v in path]==['assessment','interview','rejected']
    assert path[1]['round']==3  # No invented first or second interview.
    update(p,aid,'assessment',assessment_type='unknown',action='correct')
    assert current(p,aid)['progress']['chart_path']==[{'stage':'no_answer'}]
    update(p,aid,'rejected')
    assert current(p,aid)['progress']['chart_path']==[{'stage':'no_answer'}]


def test_direct_interview_and_screening_rejection_have_distinct_paths(subject):
    s,m,p,aid=subject
    update(p,aid,'interview',interview_round=1)
    assert current(p,aid)['progress']['chart_path']==[{'stage':'interview','round':1,'final':False}]
    update(p,aid,'phone_screen',action='correct')
    update(p,aid,'rejected')
    assert current(p,aid)['progress']['chart_path']==[{'stage':'phone_screen'},{'stage':'rejected'}]


def test_compact_display_preserves_rejection_and_verified_advancement(subject):
    s,m,p,aid=subject
    update(p,aid,'assessment',assessment_type='automatic')
    update(p,aid,'rejected')
    row=m.snapshot()['appliedList']['value'][0]
    assert row['status']=='rejected'
    assert row['progress']['display_stage']=='no_answer'
    assert Recruiting(s).overview()['display_counts']['newgrad']['no_answer']==1
    update(p,aid,'assessment',assessment_type='screened',action='correct')
    update(p,aid,'rejected')
    assert current(p,aid)['progress']['display_stage']=='rejected'
    assert current(p,aid)['progress']['ever_advanced'] is True
    assert Recruiting(s).overview()['display_counts']['newgrad']['rejected']==1


def test_pending_mail_visible_without_updating_or_double_counting_candidates(subject):
    s,m,p,aid=subject
    request=dict(message_id='abcdef1234567811',received_at=iso(-10),company='Test Employer',
                 stage='assessment',summary='OA confirmed; requisition not specified.',candidate_ids=[aid])
    before=Recruiting(s).overview()['total']
    assert p.record_pending_email(**request)['duplicate'] is False
    assert p.record_pending_email(**request)['duplicate'] is True
    assert current(p,aid)['progress']['stage']=='applied'
    assert Recruiting(s).overview()['total']==before
    assert m.snapshot()['applicationProgressReview']['value'][0]['companyName']=='Test Employer'
    with pytest.raises(ValueError):p.record_pending_email(**{**request,'candidate_ids':['missing']})
    update(p,aid,'assessment',source='email',reference=request['message_id'],observed_at=request['received_at'])
    assert p.list()['unresolved_matches']==[]


def test_confirmed_offboard_screening_then_rejection_counts_once(subject):
    s,m,p,aid=subject
    doc=m.snapshot()['appliedList']
    row={**doc['value'][0],'id':'outreach-application','jobLink':'','companyName':'Outreach Employer'}
    row.pop('job_id',None)
    with s.connect(True) as c:upsert(c,row,submission_status='submitted')
    update(p,'outreach-application','phone_screen')
    update(p,'outreach-application','rejected')
    value=Recruiting(s).overview()
    assert value['total']['submitted']==2
    assert value['total']['ever_advanced']==1
    assert value['display_counts']['newgrad']['rejected']==1
    assert current(p,'outreach-application')['progress']['ended_from']['stage']=='phone_screen'


def test_manual_and_email_share_ui_and_canonical_board_progress(subject):
    s,m,p,aid=subject
    r=Recruiting(s)
    mail=progress_args(s,aid,'assessment')
    p.update(**mail)
    assert current(p,aid)['progress']['stage']=='assessment'
    assert m.snapshot()['appliedList']['value'][0]['status']=='assessment'
    update(p,aid,'phone_screen')
    assert r.find('Test Employer')['jobs'][0]['stage']=='phone_screen'
    assert r.overview()['total']['phone_screen']==1
    assert p.update(**progress_args(s,aid,'applied',-10,'abcdef1234567899'))['applied'] is False
    assert current(p,aid)['progress']['stage']=='phone_screen'


def test_unknown_round_and_repeated_interview_dedup_and_terminal_history(subject):
    s,m,p,aid=subject
    update(p,aid,'interview')
    assert current(p,aid)['progress']['round'] is None
    with pytest.raises(ValueError,match='unknown'):update(p,aid,'interview',action='next_interview')
    update(p,aid,'interview',action='next_interview',interview_round=2)
    update(p,aid,'interview',action='next_interview',is_final=True)
    assert current(p,aid)['progress']['round']==3
    v=current(p,aid)['progress']['version']
    request=dict(application_id=aid,stage='interview',expected_version=v,idempotency_key='round-four-retry',
        summary='Confirmed round four invitation',action='next_interview')
    done=p.update(**request)
    assert p.update(**request)==done
    assert current(p,aid)['progress']['round']==4
    assert current(p,aid)['progress']['final'] is False
    update(p,aid,'interview')  # A reminder or reschedule does not create another round.
    assert current(p,aid)['progress']['round']==4
    update(p,aid,'rejected')
    assert current(p,aid)['progress']['ended_from']==dict(stage='interview',round=4,final=False)
    assert Recruiting(s).overview()['total']['ever_advanced']==1
    with pytest.raises(ValueError,match='reopen'):update(p,aid,'interview')
    update(p,aid,'interview',action='correct')
    assert current(p,aid)['progress']['round'] is None


def test_offer_acceptance_skipped_stages_and_correction(subject):
    _,_,p,aid=subject
    with pytest.raises(ValueError,match='offer first'):update(p,aid,'accepted')
    update(p,aid,'offer')
    update(p,aid,'accepted')
    update(p,aid,'applied',action='correct')
    update(p,aid,'interview',interview_round=1,is_final=True)
    update(p,aid,'assessment')  # Extra take-home after the interview is permitted.
    assert current(p,aid)['progress']['stage']=='assessment'
    assert current(p,aid)['progress']['round'] is None


def test_row_metadata_edit_cannot_overwrite_new_progress(subject):
    s,m,p,aid=subject
    old=m.snapshot()['appliedList']['value'][0]
    update(p,aid,'interview',interview_round=2)
    ApplicationRecords(s).mutate([dict(action='update',application_id=aid,expected_version=old['version'],value=old),
        dict(action='create',value=record(URL.replace('1211885','99999')))],'metadata-and-new')
    assert current(p,aid)['progress']['round']==2
    assert len(p.list()['applications'])==2
    with pytest.raises(ValueError):m.write([dict(key='appliedList',value=[record(ALIAS)],revision=0)])
    assert current(p,aid)['progress']['round']==2


def test_optimistic_versions_claims_idempotency_and_incomplete_email_are_atomic(subject):
    s,m,p,aid=subject
    update(p,aid,'assessment')
    with pytest.raises(ProfileConflict):p.update(aid,'interview',0,'stale-update','Owner reports an interview')
    with pytest.raises(ValueError,match='timestamp'):update(p,aid,'interview',source='email',reference='abcdef1234567800')
    assert current(p,aid)['progress']['stage']=='assessment'
    with s.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]

def test_newer_email_preserves_round_and_old_email_cannot_undo_owner(subject):
    _,_,p,aid=subject
    update(p,aid,'interview',interview_round=2,is_final=True)
    assert not update(p,aid,'rejected',source='email',observed_at=iso(-100),reference='abcdef1234567801')['applied']
    update(p,aid,'interview',source='email',observed_at=iso(2),reference='abcdef1234567802')
    assert current(p,aid)['progress']['round']==2
    assert current(p,aid)['progress']['final'] is True
    count=len(current(p,aid)['history'])
    assert update(p,aid,'interview',source='email',observed_at=iso(3),reference='abcdef1234567802')['duplicate']
    assert len(current(p,aid)['history'])==count
    assert not update(p,aid,'interview',source='email',observed_at=iso(4),reference='abcdef1234567803',interview_round=1)['applied']


def test_external_record_available_via_mcp_and_later_ingestion(subject):
    s,m,p,_=subject
    doc=m.snapshot()['appliedList']
    external=record(URL.replace('hpe.wd5','external.wd5'))
    ApplicationRecords(s).mutate([dict(action='create',value=external)],'add-external')
    row=next(r for r in p.list()['applications'] if 'external.' in r['jobLink'])
    assert row['job_ids']==[]
    update(p,row['id'],'interview',interview_round=1)
    s.ingest('speedyapply:newgrad:swe',[observation('speedyapply',url=external['jobLink'])],'new')
    assert len(current(p,row['id'])['job_ids'])==1
    assert len(p.list()['applications'])==2
    with s.connect() as c:
        jid=current(p,row['id'])['job_ids'][0]
        assert json.loads(c.execute('SELECT progress FROM applications WHERE job_id=?',(jid,)).fetchone()[0])['stage']=='interview'


def test_api_access_history_and_mcp_schema(subject):
    s,_,p,aid=subject
    server=create_server(s,'https://radar.test')
    tools={t.name:t for t in asyncio.run(server.list_tools())}
    assert tools['list_application_states'].annotations.read_only_hint
    assert not tools['update_application_progress'].annotations.read_only_hint
    assert 'expected_version' in tools['update_application_progress'].input_schema['required']
    with TestClient(server.streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url='https://radar.test') as c:
        assert c.get('/api/manage/progress').status_code==401
        request=c.get('/api/session').json()
        WebAccess(s,'https://radar.test').approve(request['request_id'])
        payload=dict(application_id=aid,stage='assessment',expected_version=0,idempotency_key='web-progress-test',summary='Owner confirmed OA')
        assert c.post('/api/manage/progress',json=payload,headers={'origin':'https://evil.test'}).status_code==403
        assert c.post('/api/manage/progress',json=payload,headers={'origin':'https://radar.test'}).status_code==200
        value=c.get('/api/manage/progress',params={'application_id':aid}).json()
        assert value['applications'][0]['history'][0]['source']=='web-owner'
        assert c.post('/api/manage/progress',json={**payload,'idempotency_key':'web-progress-stale'},headers={'origin':'https://radar.test'}).status_code==409


def test_authenticated_mcp_read_update_and_readonly_scope(subject):
    from test_auth_mcp import connect, rpc, ORIGIN
    s,_,p,aid=subject
    with TestClient(create_server(s,ORIGIN).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as c:
        token,_=connect(c,s)
        access=token['access_token']
        listed=rpc(c,access,'tools/call',dict(name='list_application_states',arguments=dict(application_id=aid))).json()['result']
        assert listed['structuredContent']['applications'][0]['id']==aid
        args=dict(application_id=aid,stage='assessment',expected_version=0,idempotency_key='mcp-progress-verified',summary='Owner confirmed OA for fixture')
        done=rpc(c,access,'tools/call',dict(name='update_application_progress',arguments=args)).json()['result']
        assert done['structuredContent']['progress']['stage']=='assessment'
        limited,_=connect(c,s,'jobs:read')
        blocked=rpc(c,limited['access_token'],'tools/call',dict(name='update_application_progress',arguments={**args,'expected_version':1,'idempotency_key':'mcp-progress-blocked'})).json()['result']
        assert blocked['isError']


def test_email_progress_without_official_url_reuses_existing_application(tmp_path):
    s=Store(tmp_path/'unresolved.sqlite')
    row=observation();row['apply_url']=None
    s.ingest('simplify:newgrad',[row],'unresolved')
    with s.connect(True) as c:
        jid=c.execute('SELECT id FROM jobs').fetchone()[0]
        saved=upsert(c,dict(id='url-less-fixture',job_id=jid,jobTitle=row['title'],jobLink='',
            companyName=row['company'],companyLink='',date=iso(-100),status='applied',profileName='Newgrad'))
    p=ApplicationProgress(s)
    p.update(**progress_args(s,saved['id'],'applied',-30,'aaaaaaaaaaaaaa01'))
    p.update(**progress_args(s,saved['id'],'interview',-20,'aaaaaaaaaaaaaa02'))
    apps=ApplicationProgress(s).list()['applications']
    assert len(apps)==1 and apps[0]['progress']['stage']=='interview'


def test_automatic_and_unknown_oa_are_not_advancement_but_screened_oa_is(subject):
    s,_,p,aid=subject
    update(p,aid,'assessment')
    assert Recruiting(s).overview()['total']['assessment']==1
    assert Recruiting(s).overview()['total']['ever_advanced']==0
    assert current(p,aid)['progress']['chart_path']==[{'stage':'no_answer'}]
    assert Recruiting(s).overview()['display_counts']['newgrad']['no_answer']==1
    update(p,aid,'assessment',assessment_type='automatic')
    assert not current(p,aid)['progress']['stage_is_advancement']
    assert Recruiting(s).overview()['total']['ever_advanced']==0
    assert current(p,aid)['progress']['display_stage']=='no_answer'
    update(p,aid,'assessment',assessment_type='screened')
    assert current(p,aid)['progress']['stage_is_advancement']
    assert Recruiting(s).overview()['total']['ever_advanced']==1
    assert current(p,aid)['progress']['chart_path']==[{'stage':'assessment'}]
    assert Recruiting(s).overview()['display_counts']['newgrad']['assessment']==1
    update(p,aid,'rejected')
    assert Recruiting(s).overview()['total']['ever_advanced']==1


@pytest.mark.parametrize('assessment_type',['unknown','automatic'])
def test_non_screened_oa_does_not_reappear_in_later_interview_path(subject,assessment_type):
    s,m,p,aid=subject
    update(p,aid,'assessment',assessment_type=assessment_type)
    update(p,aid,'interview',interview_round=1)
    assert [v['stage'] for v in current(p,aid)['progress']['chart_path']]==['interview']
    update(p,aid,'rejected')
    assert [v['stage'] for v in current(p,aid)['progress']['chart_path']]==['interview','rejected']
    assert len(current(p,aid)['history'])==3


def test_reclassifying_recorded_video_corrects_historical_interview_count(subject):
    s,_,p,aid=subject
    r=Recruiting(s)
    p.update(**progress_args(s,aid,'interview'))
    assert r.overview()['total']['ever_advanced']==1
    update(p,aid,'assessment',action='correct',assessment_type='unknown')
    assert r.overview()['total']['interview']==0
    assert r.overview()['total']['assessment']==1
    assert r.overview()['total']['ever_advanced']==0
    assert len(current(p,aid)['history'])==2  # Evidence is retained, interpretation corrected.
    update(p,aid,'assessment',assessment_type='screened')
    assert r.overview()['total']['ever_advanced']==1
    update(p,aid,'assessment',action='correct',assessment_type='automatic')
    assert r.overview()['total']['ever_advanced']==0
    update(p,aid,'interview',interview_round=1)
    update(p,aid,'rejected')
    assert r.overview()['total']['ever_advanced']==1


def test_email_oa_qualification_and_validation_share_the_contract(subject):
    s,_,p,aid=subject
    r=Recruiting(s)
    p.update(**progress_args(s,aid,'assessment'),assessment_type='screened')
    assert current(p,aid)['progress']['assessment_type']=='screened'
    assert r.overview()['total']['ever_advanced']==1
    with pytest.raises(ValueError,match='OA only'):
        update(p,aid,'interview',assessment_type='screened')
    with pytest.raises(ValueError,match='assessment_type'):
        update(p,aid,'assessment',assessment_type='fast')
