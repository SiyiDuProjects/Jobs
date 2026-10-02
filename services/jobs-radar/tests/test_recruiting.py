import asyncio
import time
from datetime import datetime, timezone

import pytest
from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.board import Board
from jobs_radar.profiles import ProfileConflict
from jobs_radar.recruiting import Recruiting
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_store import observation

MAILBOX = 'work@example.test'


def configure_mailbox(store):
    with store.connect(True) as c:
        c.execute('INSERT OR IGNORE INTO recruiting_sync VALUES(?,NULL,?)',(MAILBOX,'Synthetic authorized mailbox'))


def progress_args(store, application_id, stage='applied', offset=-30, message_id='abcdef1234567890'):
    configure_mailbox(store)
    progress=ApplicationProgress(store).list(application_id=application_id)['applications'][0]['progress']
    return dict(application_id=application_id,stage=stage,source='email',reference=message_id,
        observed_at=datetime.fromtimestamp(time.time()+offset,timezone.utc).isoformat(),
        summary='Synthetic verified recruiting stage.',expected_version=progress['version'],
        idempotency_key='email-'+message_id)


@pytest.fixture
def subject(tmp_path):
    store=Store(tmp_path/'recruiting.sqlite')
    store.ingest('simplify:newgrad',[observation()],'recruiting')
    configure_mailbox(store)
    board=Board(store)
    with store.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]
    board.mark_submitted(jid,0,key='explicit-fixture-confirmation')
    progress=ApplicationProgress(store)
    aid=progress.list()['applications'][0]['id']
    return store,Recruiting(store),board,progress,aid


def test_email_progress_idempotency_private_board_history_and_filter(subject):
    store,recruiting,board,progress,aid=subject
    payload=progress_args(store,aid,'interview')
    result=progress.update(**payload)
    assert result['applied']
    assert progress.update(**payload)==result
    assert progress.update(**{**payload,'idempotency_key':'different-retry-key'})['duplicate']
    row=board.list(status='interview')['jobs'][0]
    assert row['status']=='submitted' and row['progress']['stage']=='interview'
    assert 'authuser=work%40example.test' in row['progress']['email_url']
    assert board.list(status='not_started')['total']==0
    with store.connect(True) as c:
        c.execute('UPDATE observations SET present=0')
        c.execute('DELETE FROM search_index')
    assert board.list(status='interview')['total']==1
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='progress'").fetchone()[0]==1
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='mail'").fetchone()[0]==0


def test_old_and_lower_stage_emails_never_downgrade(subject):
    store,_,board,progress,aid=subject
    progress.update(**progress_args(store,aid,'interview',-100))
    assert not progress.update(**progress_args(store,aid,'applied',-200,'abcdef1234567891'))['applied']
    assert not progress.update(**progress_args(store,aid,'applied',-20,'abcdef1234567892'))['applied']
    assert progress.update(**progress_args(store,aid,'rejected',-10,'abcdef1234567893'))['applied']
    assert not progress.update(**progress_args(store,aid,'interview',-5,'abcdef1234567894'))['applied']
    assert board.list(status='rejected')['total']==1
    assert board.list(status='interview')['total']==0


def test_invalid_email_and_stale_progress_are_atomic(subject):
    store,_,_,progress,aid=subject
    payload=progress_args(store,aid)
    with pytest.raises(ValueError,match='message ID'):
        progress.update(**{**payload,'reference':'not-a-message-id'})
    with pytest.raises(ProfileConflict):
        progress.update(**{**payload,'expected_version':8})
    with store.connect(True) as c:
        c.execute('INSERT INTO recruiting_sync VALUES(?,NULL,?)',('other@example.test','Synthetic ambiguous mailbox'))
    with pytest.raises(ValueError,match='Multiple authorized'):
        progress.update(**payload)
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM application_events WHERE kind='progress'").fetchone()[0]==0


def test_duplicate_message_cannot_target_another_application(subject):
    store,_,board,progress,aid=subject
    payload=progress_args(store,aid,'interview')
    progress.update(**payload)
    store.ingest('simplify:newgrad',[{**observation(url='https://example.org/other'),'source_id':'other'}],'second')
    with store.connect() as c:jid=c.execute("SELECT job_id FROM observations WHERE source_id='other'").fetchone()[0]
    board.mark_submitted(jid,0,key='explicit-second-fixture-confirmation')
    other=next(row['id'] for row in progress.list()['applications'] if row['id']!=aid)
    with pytest.raises(ValueError,match='another'):
        progress.update(**{**payload,'application_id':other,'idempotency_key':'wrong-job-retry'})


def test_owner_undo_is_not_recreated_by_old_email(subject):
    store,_,board,progress,aid=subject
    payload=progress_args(store,aid,'interview',-100)
    with store.connect() as c:
        app=c.execute('SELECT * FROM applications WHERE application_id=?',(aid,)).fetchone()
    board.undo_submitted(app['job_id'],app['version'],'owner-undo-test')
    with pytest.raises(ValueError,match='Application not found'):
        progress.update(**payload)
    assert board.list(status='not_started')['total']==1


def test_historical_mail_events_stay_readable_and_unchanged(subject):
    store,recruiting,_,progress,aid=subject
    raw='{"message_id":"abcdef1234567899","historical":"retained verbatim"}'
    with store.connect(True) as c:
        jid=c.execute('SELECT job_id FROM applications WHERE application_id=?',(aid,)).fetchone()[0]
        c.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,'mail',?,?)",
            ('historical-mail',aid,jid,raw,time.time()-100))
    progress.update(**progress_args(store,aid,'interview'))
    assert recruiting.find('Test Employer')['jobs'][0]['processed_message_ids']==['abcdef1234567899']
    with store.connect() as c:
        assert c.execute("SELECT payload FROM application_events WHERE event_key='historical-mail'").fetchone()[0]==raw


def test_candidate_pagination_is_complete(subject):
    store,recruiting,_,_,_=subject
    store.ingest('simplify:newgrad',[{**observation(url=f'https://example.org/{i}'),'source_id':str(i)} for i in range(3)],'more')
    ids=[];cursor=None
    while True:
        page=recruiting.find('Test Employer',limit=1,cursor=cursor)
        ids.extend(job['job_id'] for job in page['jobs'])
        cursor=page['next_cursor']
        if not cursor:break
    assert len(ids)==len(set(ids))==4


def test_mcp_exposes_generic_progress_without_old_mail_confirmation(subject):
    store,_,_,_,_=subject
    names={tool.name:tool for tool in asyncio.run(create_server(store).list_tools())}
    assert names['find_application_records'].annotations.read_only_hint
    assert 'record_recruiting_email' not in names
    assert not names['update_application_progress'].annotations.read_only_hint
    assert 'expected_version' in names['update_application_progress'].input_schema['required']


def test_incremental_checkpoint_requires_complete_run_and_handles_downtime(subject):
    _,recruiting,_,_,_=subject
    first=recruiting.sync_state()
    assert first['last_success'] is None
    assert abs(first['search_before']-first['search_after']-30*86400)<1
    with pytest.raises(ValueError):recruiting.finish_sync(None,first['search_before'],False,'Incomplete')
    done=recruiting.finish_sync(None,first['search_before'],True,'1 matched, 2 reported unmatched')
    assert recruiting.sync_state()['search_after']==done['last_success']-172800
    assert recruiting.finish_sync(None,first['search_before'],True,'same run')['duplicate']
    with pytest.raises(ValueError):recruiting.finish_sync(None,time.time(),True,'concurrent run')
