import time
from datetime import datetime, timezone

from starlette.testclient import TestClient
import pytest
from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.board import Board
from jobs_radar.recruiting import Recruiting
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_store import observation
from test_recruiting import progress_args


def confirmed_fixture(store):
    with store.connect() as c:jid=c.execute('SELECT id FROM jobs').fetchone()[0]
    Board(store).mark_submitted(jid,0,key='explicit-overview-fixture-confirmation')
    return ApplicationProgress(store).list()['applications'][0]['id']


def test_historical_dedupe_and_unknown_is_not_no_reply(tmp_path):
    s=Store(tmp_path/'overview.sqlite');b=Board(s);r=Recruiting(s)
    for kind in ('newgrad','internship'):
        s.ingest('simplify:'+kind,[{**observation(url='https://example.org/'+kind),'kind':kind}],'init')
        jid=b._rows(kind)[0]['id'];b.mark_submitted(jid,0,key='owner-'+kind)
    with s.connect(True) as c:
        c.execute("INSERT INTO observations SELECT stream||'-duplicate',source_id,job_id,payload,first_seen,last_seen,present FROM observations")
        c.execute('UPDATE observations SET present=0')
        c.execute('DELETE FROM search_index')
    result=r.overview()
    assert result['total']['submitted']==2
    for kind in ('newgrad','internship'):
        assert result['counts'][kind]['submitted']==1
        assert result['counts'][kind]['unverified']==1
        assert result['counts'][kind]['waiting']==0
    from test_recruiting import configure_mailbox
    configure_mailbox(s)
    state=r.sync_state();r.finish_sync(None,state['search_before'],True,'0 matches; unresolved records remain')
    assert r.overview()['total']['unverified']==2  # Full mailbox search is not a unique job match.


def test_rejected_after_interview_keeps_ever_advanced_and_current_counts(tmp_path):
    s=Store(tmp_path/'stages.sqlite');s.ingest('simplify:newgrad',[observation()],'init');r=Recruiting(s)
    aid=confirmed_fixture(s);p=ApplicationProgress(s)
    # The latest email may be processed first; earlier verified stages still count historically.
    p.update(**progress_args(s,aid,'rejected',-10))
    p.update(**progress_args(s,aid,'interview',-100,'abcdef1234567891'))
    p.update(**progress_args(s,aid,'assessment',-200,'abcdef1234567892'))
    c=r.overview()['counts']['newgrad']
    assert c['submitted']==c['rejected']==c['ever_advanced']==1
    assert c['assessment']==c['interview']==0
    assert sum(c[k] for k in ('waiting','assessment','interview','offer','rejected','withdrawn','unverified'))==c['submitted']


def test_pending_and_owner_undo_not_counted_as_submission(tmp_path):
    s=Store(tmp_path/'undo.sqlite');s.ingest('simplify:newgrad',[observation()],'init');b=Board(s);r=Recruiting(s)
    aid=confirmed_fixture(s);p=progress_args(s,aid,'interview',-100)
    with s.connect() as c:app=c.execute('SELECT * FROM applications WHERE application_id=?',(aid,)).fetchone()
    b.undo_submitted(app['job_id'],app['version'],'owner-undo-count')
    with pytest.raises(ValueError,match='Application not found'):ApplicationProgress(s).update(**p)
    assert r.overview()['total']['submitted']==0
    with s.connect(True) as c: c.execute("UPDATE applications SET status='submitted_unconfirmed'")
    assert r.overview()['total']['submission_unconfirmed']==1
    assert r.overview()['total']['submitted']==0
    with s.connect(True) as c: c.execute("UPDATE applications SET status='submitted'")
    assert r.overview()['total']['ever_advanced']==0


def test_overview_private_and_ignores_list_filters(tmp_path):
    s=Store(tmp_path/'web.sqlite');s.ingest('simplify:newgrad',[observation()],'init');r=Recruiting(s)
    aid=confirmed_fixture(s)
    # A retained historical receipt is still displayed; a new email cannot create it.
    with s.connect(True) as c:
        c.execute("UPDATE applications SET progress=json_set(progress,'$.receipt_confirmed',json('true')) WHERE application_id=?",(aid,))
    ApplicationProgress(s).update(**progress_args(s,aid))
    origin='http://127.0.0.1:8796'
    with TestClient(create_server(s,origin).streamable_http_app(),headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        assert client.get('/api/application-overview').status_code==401
        pending=client.get('/api/session').json()
        WebAccess(s,origin).approve(pending['request_id'])
        response=client.get('/api/application-overview?kind=internship&region=ca&added_since=9999999999')
        assert response.status_code==200 and response.headers['cache-control']=='no-store'
        assert response.json()['counts']['newgrad']['waiting']==1
        assert response.json()['total']['submitted']==1
