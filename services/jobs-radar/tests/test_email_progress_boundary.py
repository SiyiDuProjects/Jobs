"""Mail is evidence for recruiting progress, never a submission writer."""
import asyncio
import json
import time
from datetime import datetime, timezone

import pytest
from starlette.testclient import TestClient

from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.application_records import upsert
from jobs_radar.board import Board
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_auth_mcp import connect, rpc, ORIGIN
from test_recruiting import configure_mailbox
from test_store import observation


def seeded(tmp_path, state, legacy_receipt=False):
    store = Store(tmp_path / 'boundary.sqlite')
    store.ingest('simplify:newgrad', [observation()], 'fixture')
    configure_mailbox(store)
    with store.connect(True) as db:
        jid = db.execute('SELECT id FROM jobs').fetchone()[0]
        row = upsert(db, dict(id='existing-application', job_id=jid,
            jobTitle='Synthetic role', jobLink=observation()['apply_url'], companyName='Test Employer',
            companyLink='', date='2026-01-01T00:00:00Z', status='applied', profileName='Newgrad'))
        db.execute('UPDATE applications SET status=?,attempted_at=?,confirmed_at=?,evidence=? WHERE job_id=?',
            (state if state != 'owner_undo' else 'not_started',
             1767225600 if state in {'submitted','submitted_unconfirmed'} else None,
             1767225601 if state == 'submitted' else None,
             json.dumps([{'type':'blocker','reference':'synthetic retained evidence'}]), jid))
        if legacy_receipt:
            db.execute("UPDATE applications SET progress=json_set(progress,'$.receipt_confirmed',json('true')) WHERE job_id=?", (jid,))
        db.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,'mail',?,?)",
            ('mail:historical', row['id'], jid, '{"historical":"keep exact bytes"}', 1767225602))
    if state == 'owner_undo':
        board = Board(store)
        done = board.mark_submitted(jid, 0, key='synthetic-owner-confirm')
        board.undo_submitted(jid, done['version'], 'synthetic-owner-undo')
    return store, row['id']


def protected(store):
    with store.connect() as db:
        return dict(applications=[{k:r[k] for k in r.keys() if k not in {'progress','version'}}
                     for r in db.execute('SELECT * FROM applications ORDER BY job_id')],
                    undo=[tuple(r) for r in db.execute('SELECT * FROM owner_submission_undo ORDER BY job_id')],
                    events={r['event_key']:dict(r) for r in db.execute('SELECT * FROM application_events')})


def assert_preserved(store, before):
    after = protected(store)
    assert after['applications'] == before['applications']
    assert after['undo'] == before['undo']
    assert all(after['events'][key] == value for key, value in before['events'].items())
    for key, event in after['events'].items():
        if key in before['events']: continue
        assert event['kind'] in {'progress','state_change'}
        if event['kind'] == 'state_change':
            change = json.loads(event['payload'])
            assert change['reason'] == 'progress'
            assert set(change['before']) == set(change['after']) == {'progress'}


def request(aid, stage='applied'):
    return dict(application_id=aid, stage=stage, expected_version=0,
                idempotency_key='new-progress', summary='Synthetic recruiting update',
                observed_at=datetime.fromtimestamp(time.time()-1,timezone.utc).isoformat())


@pytest.mark.parametrize('state',['not_started','submitted_unconfirmed','submitted','owner_undo'])
@pytest.mark.parametrize('entry',['mcp-email','website'])
def test_existing_progress_preserves_submission_record_and_historical_evidence(tmp_path,state,entry):
    store, aid = seeded(tmp_path,state)
    with TestClient(create_server(store,ORIGIN).streamable_http_app(), base_url=ORIGIN,
                    headers={'X-Jobs-Protocol':'2'}) as client:
        payload = request(aid)
        if entry == 'mcp-email':
            token,_ = connect(client,store)
            payload.update(source='email',reference='abcde12345678901')
            before = protected(store)
            response = rpc(client,token['access_token'],'tools/call',dict(name='update_application_progress',arguments=payload)).json()['result']
            assert not response.get('isError'), response
            result = response['structuredContent']
        else:
            session = client.get('/api/session').json()
            WebAccess(store,ORIGIN).approve(session['request_id'])
            before = protected(store)
            response = client.post('/api/manage/progress',json=payload,headers={'origin':ORIGIN})
            assert response.status_code == 200, response.text
            result = response.json()
        assert result['applied'] is True
        assert result['progress']['receipt_confirmed'] is False
        assert_preserved(store,before)


def test_new_email_progress_keeps_preexisting_receipt_flag_without_creating_confirmation(tmp_path):
    store, aid = seeded(tmp_path,'submitted_unconfirmed',legacy_receipt=True)
    before = protected(store)
    payload = request(aid,'interview')
    result = ApplicationProgress(store).update(**payload,source='email',reference='abcde12345678902')
    assert result['progress']['receipt_confirmed'] is True
    assert_preserved(store,before)


@pytest.mark.parametrize('case',['missing','deleted','stale','old-received-stage'])
def test_invalid_target_rolls_back_without_creating_application_or_events(tmp_path,case):
    store, aid = seeded(tmp_path,'not_started')
    payload = request(aid,'interview')
    if case == 'missing': payload['application_id'] = 'absent'
    if case == 'stale': payload['expected_version'] = 9
    if case == 'old-received-stage': payload['stage'] = 'received'
    if case == 'deleted':
        with store.connect(True) as db: db.execute('UPDATE applications SET deleted=1')
    with store.connect() as db: before = '\n'.join(db.iterdump())
    with pytest.raises(ValueError):
        ApplicationProgress(store).update(**payload,source='email',reference='abcde12345678903')
    with store.connect() as db: assert '\n'.join(db.iterdump()) == before


def test_old_mail_confirmation_tool_and_writer_are_absent(tmp_path):
    from jobs_radar.recruiting import Recruiting
    store, _ = seeded(tmp_path,'not_started')
    names = {tool.name for tool in asyncio.run(create_server(store).list_tools())}
    assert 'record_recruiting_email' not in names
    assert 'update_application_progress' in names
    assert not hasattr(Recruiting,'record')
    with TestClient(create_server(store,ORIGIN).streamable_http_app(),base_url=ORIGIN,
                    headers={'X-Jobs-Protocol':'2'}) as client:
        token,_=connect(client,store)
        with store.connect() as db:app=db.execute('SELECT * FROM applications').fetchone()
        before=protected(store)
        legacy=dict(job_id=app['job_id'],mailbox='work@example.test',message_id='abcde12345678904',
                    stage='interview',received_at=request('unused')['observed_at'],
                    summary='Synthetic interview invitation',match_reason='Exact synthetic posting identity',
                    expected_application_version=app['version'],expected_progress_version=0,
                    idempotency_key='legacy-mail-call')
        result=rpc(client,token['access_token'],'tools/call',dict(name='record_recruiting_email',arguments=legacy)).json()['result']
        assert result['isError'] is True
        assert protected(store)==before
