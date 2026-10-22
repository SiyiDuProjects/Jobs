"""Behavior regressions for read isolation, request scheduling and bounded reads."""
import asyncio
from contextlib import contextmanager
import sqlite3
import threading
import time
import uuid

import pytest
from starlette.requests import Request

from jobs_radar.answer_jobs import AnswerJobs
from jobs_radar.http_routes import RouteAPI
from jobs_radar.management import Management
from jobs_radar.store import Store
from jobs_radar.board import Board
from jobs_radar.application_records import ApplicationRecords
from test_application_records import record
from test_board_queries import source


def trace(store, monkeypatch):
    statements = []
    original = store.connect
    @contextmanager
    def traced(*args, **kwargs):
        with original(*args, **kwargs) as c:
            c.set_trace_callback(statements.append)
            yield c
    monkeypatch.setattr(store, 'connect', traced)
    return statements


def test_answer_status_reads_completed_results_without_waiting_for_writer(tmp_path):
    store = Store(tmp_path/'status.sqlite')
    jobs = AnswerJobs(store, None)
    rid = str(uuid.uuid4())
    with store.connect(True) as c:
        c.execute('INSERT INTO answer_jobs VALUES(?,?,?,?,?)', (rid,'fixture',time.time(),'completed','{"text":"Synthetic"}'))
    writer = sqlite3.connect(store.path)
    writer.execute('BEGIN IMMEDIATE')
    try:
        started = time.monotonic()
        assert jobs.status(rid)['state'] == 'completed'
        assert time.monotonic()-started < .2
    finally:
        writer.rollback(); writer.close()


def test_blocked_answer_registration_keeps_event_loop_available_and_schedules_once(tmp_path):
    store = Store(tmp_path/'async.sqlite')
    class Provider:
        calls = 0
        async def generate(self, payload):
            assert threading.get_ident() == owner_thread
            self.calls += 1
            return {'text':'Synthetic'}
    owner_thread = threading.get_ident()
    async def exercise():
        provider = Provider(); jobs = AnswerJobs(store,provider)
        writer = sqlite3.connect(store.path); writer.execute('BEGIN IMMEDIATE')
        payload = {'requestId':str(uuid.uuid4()),'prompt':'Synthetic'}
        try:
            first = asyncio.create_task(jobs.start_async(payload))
            await asyncio.sleep(.03)
            assert not first.done()  # worker is waiting; this loop still runs
        finally:
            writer.rollback(); writer.close()
        result = await first
        await asyncio.gather(*list(jobs.tasks.values()))
        assert result['state'] in {'pending','completed'}
        assert (await jobs.start_async(payload))['state'] == 'completed'
        assert provider.calls == 1
        assert set(jobs.status(payload['requestId'])['result']['answerTimings']) >= {'queueMs','processingMs'}
    asyncio.run(exercise())


def test_rest_authorization_and_sync_handler_run_off_loop_but_async_handler_stays_on_loop():
    owner_thread = threading.get_ident()
    class Server:
        def custom_route(self, *args, **kwargs):
            return lambda handler: handler
    api = RouteAPI(Server())
    def authorize(request):
        assert threading.get_ident() != owner_thread
        return True
    @api.route('/sync',['GET'],authorize)
    def sync(request,payload,principal):
        assert threading.get_ident() != owner_thread
        return {'ok':True}
    @api.route('/async',['GET'],authorize)
    async def asynchronous(request,payload,principal):
        assert threading.get_ident() == owner_thread
        await asyncio.sleep(0)
        return {'ok':True}
    request = Request({'type':'http','method':'GET','path':'/sync','headers':[]})
    async def exercise():
        assert (await sync(request)).status_code == 200
        assert (await asynchronous(request)).status_code == 200
    asyncio.run(exercise())


def test_snapshot_query_count_does_not_grow_per_application(tmp_path,monkeypatch):
    store = Store(tmp_path/'snapshot.sqlite'); management = Management(store)
    records = ApplicationRecords(store)
    records.mutate([{'action':'create','value':{**record(url=f'https://example.com/jobs/{i}'),'kind':'newgrad'}} for i in range(100)],'seed-snapshot')
    statements = trace(store,monkeypatch)
    snapshot = management.snapshot()
    assert len(snapshot['appliedList']['value']) == 100
    selects = [q for q in statements if q.lstrip().upper().startswith('SELECT')]
    assert len(selects) < 15
    assert not any('SELECT progress FROM applications WHERE application_id=' in q for q in selects)


def test_get_jobs_batches_aliases_preserves_order_and_drops_raw(tmp_path,monkeypatch):
    store = Store(tmp_path/'jobs.sqlite')
    store.ingest('simplify:newgrad',[source(i,raw={'private':'fixture'}) for i in range(5)],'seed')
    ids = [j['id'] for j in store.search()['jobs']]
    with store.connect(True) as c:
        c.execute('INSERT INTO job_aliases VALUES(?,?,?)',('old-id',ids[0],time.time()))
    statements = trace(store,monkeypatch)
    jobs = store.get_jobs(['missing','old-id',ids[1],ids[0]])
    assert [j['id'] for j in jobs] == ids[:2]
    assert all('raw' not in s for j in jobs for s in j['all_sources'])
    assert len([q for q in statements if q.lstrip().upper().startswith('SELECT')]) <= 3
    assert store.get_jobs([ids[0]],True)[0]['all_sources'][0]['raw'] == {'private':'fixture'}


def test_queue_bounds_hydration_and_keeps_cursor_and_source_evidence(tmp_path,monkeypatch):
    store = Store(tmp_path/'queue.sqlite'); board = Board(store)
    store.ingest('simplify:newgrad',[source(i) for i in range(9)],'seed')
    expected = sorted(r['id'] for r in board._rows('newgrad') if r['screening']=='pending')
    monkeypatch.setattr(board,'_rows',lambda *args:pytest.fail('Queue must not hydrate all jobs'))
    page = board.queue('newgrad',limit=2)
    assert [r['id'] for r in page['jobs']] == expected[:2]
    assert all(r['all_sources'] for r in page['jobs'])
    assert page['next_cursor'] == expected[1]
    assert [r['id'] for r in board.queue('newgrad',limit=2,cursor=page['next_cursor'])['jobs']] == expected[2:4]


def test_listing_does_not_count_all_jobs_or_check_disk(tmp_path,monkeypatch):
    store = Store(tmp_path/'health.sqlite')
    store.ingest('simplify:newgrad',[source()],'seed')
    monkeypatch.setattr(store,'storage_health',lambda:pytest.fail('No disk check on list/search'))
    assert Board(store).list()['source_health']
    assert store.search()['source_health']


def test_search_backfill_runs_once_but_explicit_repair_restores_missing_rows(tmp_path):
    store = Store(tmp_path/'index.sqlite')
    store.ingest('simplify:newgrad',[source()],'seed')
    with store.connect(True) as c:
        c.execute('DELETE FROM search_index')
    reopened = Store(store.path)
    with reopened.connect(read_only=True) as c:
        assert c.execute('SELECT count(*) FROM search_index').fetchone()[0] == 0
    reopened.rebuild_search_index()
    with reopened.connect(read_only=True) as c:
        assert c.execute('SELECT count(*) FROM search_index').fetchone()[0] == 1


@pytest.mark.parametrize('flow',['legacy','simple'])
def test_answer_engines_keep_database_connections_off_the_request_loop(tmp_path,monkeypatch,flow):
    from jobs_radar.answers import Answers
    from jobs_radar.profiles import Profiles
    from test_answers import Client,field
    store = Store(tmp_path/'engine.sqlite')
    profile = Profiles(store).save({'profileName':'Synthetic','nameData':{},'addressData':{},'contactData':{},'jobData':[],
        'educationData':[],'languageData':[],'resumeData':{},'websiteData':{},'employmentData':{},'skillsData':[]})
    owner_thread = threading.get_ident()
    original = store.connect
    @contextmanager
    def checked(*args,**kwargs):
        assert threading.get_ident() != owner_thread, 'Database connection on event loop'
        with original(*args,**kwargs) as c: yield c
    monkeypatch.setattr(store,'connect',checked)
    result = asyncio.run(Answers(store,flow).generate({'profileId':profile['id'],'profileVersion':profile['last_sync'],
        'answerProtocol':3,'fields':[field()]},Client()))
    assert len(result['answers']) == 1


def test_answer_phase_timings_stay_in_existing_bounded_event_metrics():
    from jobs_radar.event_log import event_metrics
    metrics = {'requestMs':100,'queueMs':5,'processingMs':90,'storageMs':12,'modelMs':50,'preparationMs':20}
    assert event_metrics({'type':'auto_answer_batch','timing':metrics}) == {'timing':metrics}
    for invalid in ({'modelMs':-1},{'storageMs':True},{'query':'secret'},{'modelMs':86_400_001}):
        with pytest.raises(ValueError):event_metrics({'type':'auto_answer_batch','timing':invalid})


def test_auth_polling_and_liveness_ignore_dirty_board_while_writer_is_held(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from starlette.testclient import TestClient
    from jobs_radar.server import create_server
    from jobs_radar.profiles import Profiles
    from jobs_radar.extension_sync import ExtensionSync,EXTENSION_ID
    from jobs_radar.web import WebAccess
    store=Store(tmp_path/'readonly-auth.sqlite'); origin='https://radar.test'
    server=create_server(store,origin); extension=ExtensionSync(store); profiles=Profiles(store)
    device=str(uuid.uuid4()); paired=extension.pair(device,EXTENSION_ID); token=profiles.grant(device)
    rid=str(uuid.uuid4())
    with store.connect(True) as c:
        c.execute('INSERT INTO answer_jobs VALUES(?,?,?,?,?)',(rid,'synthetic',time.time(),'completed','{}'))
    with TestClient(server.streamable_http_app(),base_url=origin) as client:
        session=client.get('/api/session').json();WebAccess(store,origin).approve(session['request_id'])
        writer=sqlite3.connect(store.path)
        writer.execute('INSERT INTO board_refresh VALUES(?,0)',('synthetic-dirty',));writer.commit()
        writer.execute('BEGIN IMMEDIATE')
        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                assert extension.authenticate(paired['token'])==device
                assert profiles.authenticate(token)==device
                assert pool.submit(client.get,'/healthz').result(timeout=1).json()['ok']
                assert pool.submit(client.get,'/api/session').result(timeout=1).json()['authenticated']
                response=pool.submit(client.get,'/api/manage/answer/jobs',params={'id':rid},headers={'authorization':'Bearer '+token}).result(timeout=1)
                assert response.json()['state']=='completed'
            finally:
                writer.rollback();writer.close()
    with store.connect(read_only=True) as c:
        assert c.execute('SELECT 1 FROM board_refresh WHERE job_id=?',('synthetic-dirty',)).fetchone()
