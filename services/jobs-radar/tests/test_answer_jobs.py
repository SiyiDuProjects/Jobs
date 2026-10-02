import asyncio
import time
import uuid

import pytest
from starlette.testclient import TestClient
from jobs_radar.answer_jobs import AnswerJobs
from jobs_radar.answers import Answers
from jobs_radar.store import Store
from jobs_radar.profiles import Profiles
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess


class Provider:
    def __init__(self):
        self.calls = 0
        self.release = asyncio.Event()

    async def generate(self, payload):
        self.calls += 1
        await self.release.wait()
        return {'text': 'Confirmed fixture answer'}


def test_slow_provider_is_cancelled_before_task_expiry_and_never_replayed(tmp_path, monkeypatch):
    monkeypatch.setattr('jobs_radar.answer_jobs.ANSWER_TIMEOUT_SECONDS', 0.01)
    async def run():
        cancelled = asyncio.Event()
        class SlowProvider(Provider):
            async def generate(self, payload):
                try:
                    return await super().generate(payload)
                finally:
                    cancelled.set()
        provider = SlowProvider()
        jobs = AnswerJobs(Store(tmp_path / 'timeout.sqlite'), provider)
        payload = {'requestId': str(uuid.uuid4()), 'prompt': 'Fixture question'}
        jobs.start(payload)
        await asyncio.gather(*jobs.tasks.values())
        result = jobs.status(payload['requestId'])
        assert cancelled.is_set()
        assert result['state'] == 'failed'
        assert '超时' in result['result']['error']
        assert jobs.start(payload) == result
        assert provider.calls == 1
    asyncio.run(run())


def test_status_does_not_expire_live_work_before_its_bounded_timeout_finishes(tmp_path):
    async def run():
        store = Store(tmp_path / 'live-timeout.sqlite')
        provider = Provider()
        jobs = AnswerJobs(store, provider)
        payload = {'requestId': str(uuid.uuid4()), 'prompt': 'Fixture question'}
        jobs.start(payload)
        with store.connect(True) as c:
            c.execute('UPDATE answer_jobs SET created=? WHERE id=?', (time.time()-121, payload['requestId']))
        # A polling request can run before the scheduled timeout callback. It
        # must not replace the live task's eventual result with an orphan error.
        assert jobs.status(payload['requestId'])['state'] == 'pending'
        provider.release.set()
        await asyncio.gather(*jobs.tasks.values())
        assert jobs.status(payload['requestId'])['state'] == 'completed'
    asyncio.run(run())


def test_duplicate_start_and_new_manager_recover_one_persisted_result(tmp_path):
    async def run():
        store = Store(tmp_path / 'answers.sqlite')
        provider = Provider()
        jobs = AnswerJobs(store, provider)
        payload = {'requestId': str(uuid.uuid4()), 'prompt': 'Fixture question'}
        assert jobs.start(payload)['state'] == 'pending'
        assert jobs.start(payload)['state'] == 'pending'
        restarted = AnswerJobs(store, provider)
        assert restarted.start(payload)['state'] == 'pending'
        await asyncio.sleep(0)
        assert provider.calls == 1
        with pytest.raises(ValueError, match='其他题目'):
            jobs.start({**payload, 'prompt': 'Different question'})
        provider.release.set()
        await asyncio.gather(*jobs.tasks.values())
        result = restarted.status(payload['requestId'])
        assert result['state'] == 'completed'
        assert result['result']['text'] == 'Confirmed fixture answer'
        assert restarted.start(payload) == result
        assert provider.calls == 1
    asyncio.run(run())


def test_interrupted_or_expired_tasks_are_not_silently_replayed(tmp_path):
    async def run():
        store = Store(tmp_path / 'answers.sqlite')
        provider = Provider()
        jobs = AnswerJobs(store, provider)
        payload = {'requestId': str(uuid.uuid4()), 'prompt': 'Fixture question'}
        jobs.start(payload)
        await asyncio.sleep(0)
        tasks = list(jobs.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks)
        assert jobs.status(payload['requestId'])['state'] == 'failed'
        assert jobs.start(payload)['state'] == 'failed'
        assert provider.calls == 1
        expired = str(uuid.uuid4())
        with store.connect(True) as c:
            c.execute('INSERT INTO answer_jobs VALUES(?,?,?,?,NULL)', (expired, 'fixture', time.time()-121, 'pending'))
        assert AnswerJobs(store, provider).status(expired)['state'] == 'failed'
        assert provider.calls == 1
    asyncio.run(run())


@pytest.mark.parametrize('request_id', [None, 0, {}, 'not-a-uuid'])
def test_invalid_ids_never_start_provider_work(tmp_path, request_id):
    jobs = AnswerJobs(Store(tmp_path / 'answers.sqlite'), Provider())
    with pytest.raises(ValueError):
        jobs.start({'requestId': request_id})
    assert jobs.tasks == {}


def test_async_routes_require_profile_auth_version_and_csrf_and_remove_sync_route(tmp_path, monkeypatch):
    calls = []
    async def generate(self, payload):
        calls.append(payload)
        return {'text': 'Fixture answer'}
    monkeypatch.setattr(Answers, 'generate', generate)
    store = Store(tmp_path / 'routes.sqlite')
    origin = 'https://radar.test'
    server = create_server(store, origin)
    device = str(uuid.uuid4())
    receipt = ExtensionSync(store).pair(device, EXTENSION_ID)
    token = Profiles(store).grant(device)
    headers = {'Authorization': 'Bearer '+token}
    route = '/api/manage/answer/jobs'
    payload = {'requestId': str(uuid.uuid4()), 'prompt': 'Fixture question',
               'profileId': str(uuid.uuid4()), 'profileVersion': 'fixture-version'}
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        assert client.post(route, json=payload).status_code == 401
        assert client.get(route, params={'id': payload['requestId']}, headers={'Authorization': 'Bearer '+receipt['token']}).status_code == 401
        assert client.post(route, content='text', headers=headers).status_code == 415
        assert client.post(route, json={'long': 'x'*120000}, headers=headers).status_code == 413
        assert client.post(route, json={'requestId': None}, headers=headers).status_code == 400
        session = client.get('/api/session').json()
        WebAccess(store, origin).approve(session['request_id'])
        assert client.post(route, json=payload, headers={'origin': 'https://evil.test'}).status_code == 403
        first = client.post(route, json=payload, headers=headers)
        assert first.status_code == 202
        for _ in range(10):
            result = client.get(route, params={'id': payload['requestId']}, headers=headers)
            if result.json()['state'] == 'completed':
                break
        assert result.json()['result']['text'] == 'Fixture answer'
        assert client.post(route, json=payload, headers=headers).json()['state'] == 'completed'
        assert len(calls) == 1
        assert client.post(route, json={**payload, 'prompt': 'Different'}, headers=headers).status_code == 400
        retired = client.post('/api/manage/answer', json={'prompt': 'Old client'}, headers=headers)
        assert retired.status_code == 426 and retired.json()['code'] == 'client_upgrade_required'
        assert len(calls) == 1
