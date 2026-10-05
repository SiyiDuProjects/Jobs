"""General first-party identity reconciliation; no company allowlist."""
import asyncio
import json
import sqlite3
import uuid
from pathlib import Path

import httpx
import pytest

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.job_match import posting_key, job_key
from jobs_radar.store import Store
from jobs_radar.workday_identity import endpoint, refresh
from test_application_model_v2 import receipt, record
from test_store import observation


def url(tenant='employer', site='external', req='Q426SWEI2'):
    return f'https://{tenant}.wd1.myworkdayjobs.com/en-US/{site}/job/California/Engineer_{req}'


def add(store, urls):
    store.ingest('simplify:newgrad', [{**observation(url=u), 'source_id': str(i)} for i, u in enumerate(urls)], 'synthetic')


def response(req='Q426SWEI2', **extra):
    return {'jobPostingInfo': dict(id='00000000000000000000000000000001', jobReqId=req,
                                    title='Software Engineer', **extra)}


def run(store, handler=None, **kwargs):
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler or (lambda r: httpx.Response(200, json=response())))) as client:
            return await refresh(store, client, **kwargs)
    return asyncio.run(execute())


@pytest.mark.parametrize('tenant,req', [('snapchat', 'Q426SWEI2'), ('anothercompany', 'JR-00123'), ('thirdcompany', 'ENG2027')])
def test_general_merge_retains_sources_history_receipts_and_old_links(tmp_path, tenant, req):
    store = Store(tmp_path / 'jobs.sqlite')
    a, b = url(tenant, 'sourced', req), url(tenant, 'careers', req + '-2')
    add(store, [a, b])
    sync, device = ExtensionSync(store), str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    event = {**receipt('ats_confirmation'), 'job_url': a}
    previous = sync.receive(device, event)
    with store.connect(True) as c:
        c.execute('UPDATE owner_submission_undo SET expires=0')
        apps = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        events = [dict(r) for r in c.execute('SELECT * FROM application_events ORDER BY event_key')]
    result = run(store, lambda r: httpx.Response(200, json=response(req)))
    assert result['merged'] == 1 and result['verified'] == 2
    assert Path(result['backup']).exists()
    with sqlite3.connect(result['backup']) as c:
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0
    jobs = store.search()['jobs']
    assert len(jobs) == 1 and jobs[0]['status'] == 'submitted'
    assert len(store.get_jobs([jobs[0]['id']])[0]['all_sources']) == 2
    assert sync.receive(device, event) == previous
    assert len(ApplicationRecords(store).list()['applications']) == 1
    for page in (a, b, b + '/apply/applyManually'):
        resolved = sync.resolve({'url': page})
        assert resolved['job_id'] == jobs[0]['id'] and not resolved['queue']['allowed']
        assert {job_key(a), job_key(b)} <= set(resolved['identity_job_keys'])
    with store.connect() as c:
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == apps
        assert [dict(r) for r in c.execute('SELECT * FROM application_events ORDER BY event_key')] == events
    add(store, [b, a])
    assert len(store.search()['jobs']) == 1


def test_unverified_and_different_requisitions_and_tenants_remain_separate(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    urls = [url(), url(req='Q426SWEI2-2'), url(req='Q326SWEI2'), url(tenant='other')]
    add(store, urls)
    def handler(r):
        if str(r.url).endswith('-2'):
            return httpx.Response(404)
        return httpx.Response(200, json=response('Q326SWEI2' if str(r.url).endswith('Q326SWEI2') else 'Q426SWEI2'))
    result = run(store, handler)
    assert result['unavailable'] == 1 and result['merged'] == 0
    assert len(store.search()['jobs']) == 4
    with store.connect() as c:
        assert len({posting_key(u, c) for u in urls}) == 4


def test_feed_metadata_cannot_register_identity(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    add(store, [url(), url(req='Q426SWEI2-2')])
    store.ingest('speedyapply:SWE:newgrad', [{**observation('speedyapply', url=url(req='Q426SWEI2-3')),
                 'jobReqId': 'Q426SWEI2', 'raw': response()}], 'forged')
    assert len(store.search()['jobs']) == 3
    assert run(store, lambda r: httpx.Response(403))['merged'] == 0


def test_independent_applications_are_held_not_deleted(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    a, b = url(), url(req='Q426SWEI2-2')
    add(store, [a, b])
    records = ApplicationRecords(store)
    for i, u in enumerate([a, b]):
        records.mutate([dict(action='create', value=record(u))], 'owner-record-' + str(i))
    result = run(store)
    assert result['held'] == 1 and result['merged'] == 0
    assert len(records.list()['applications']) == 2
    assert len(store.search()['jobs']) == 2


def test_cache_backfill_new_entry_and_unavailable_retry(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    a, b = url(), url(req='Q426SWEI2-2')
    add(store, [a])
    assert run(store)['checked'] == 1
    assert run(store)['checked'] == 0
    add(store, [a, b])
    assert run(store)['merged'] == 1
    assert run(store)['checked'] == 0
    with store.connect(True) as c:
        c.execute('UPDATE workday_posting_checks SET checked_at=0')
    assert run(store, lambda r: httpx.Response(500))['unavailable'] == 2
    assert len(store.search()['jobs']) == 1
    assert run(store)['checked'] == 0


def test_changed_official_identity_does_not_reassign_existing_history(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    add(store, [url(), url(req='Q426SWEI2-2')])
    run(store)
    with store.connect(True) as c:
        before = posting_key(url(), c)
        c.execute('UPDATE workday_posting_checks SET checked_at=0')
    result = run(store, lambda r: httpx.Response(200, json=response('DIFFERENT')))
    assert result['conflicts'] == 2
    with store.connect() as c:
        assert posting_key(url(), c) == before


@pytest.mark.parametrize('bad', [url().replace('https:', 'http:'), url().replace('.com/', '.com.evil.test/'),
    url().replace('https://', 'https://user:secret@'), url().replace('.com/', '.com:444/'),
    url().replace('/California/', '/%2e%2e/'), url().replace('Engineer_', '%2fEngineer_'),
    'https://127.0.0.1/job/CA/Engineer_123', 'https://wd1.myworkdaysite.com/recruiting/acme/external/job/CA/Engineer_R123'])
def test_unsupported_or_unsafe_targets_never_fetched(bad):
    assert endpoint(bad) is None


@pytest.mark.parametrize('status,body', [(302, response()), (200, {'jobPostingInfo': {}}),
    (200, {'jobPostingInfo': {'jobReqId': 'same', 'id': {}, 'title': 'Engineer'}}),
    (200, {'oops': 'unrelated'}), (200, {'oversized': 'x' * (1024 * 1024)})])
def test_unusable_official_responses_do_not_merge(tmp_path, status, body):
    store = Store(tmp_path / 'jobs.sqlite')
    add(store, [url(), url(req='Q426SWEI2-2')])
    result = run(store, lambda r: httpx.Response(status, json=body, headers={'Location': 'https://evil.test'}))
    assert result['unavailable'] == 2 and result['merged'] == 0


def test_bounded_incremental_backfill(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    add(store, [url(req='Q426SWEI2-' + str(i)) for i in range(3)])
    first = run(store, limit=1)
    assert first['checked'] == 1 and first['remaining'] == 2
    second = run(store, limit=2)
    assert second['checked'] == 2 and second['remaining'] == 0
    assert len(store.search()['jobs']) == 1


def test_collection_automatically_verifies_new_company_and_collapses_listing(tmp_path, monkeypatch):
    from jobs_radar import sources
    store = Store(tmp_path / 'jobs.sqlite')
    a, b = url('not-in-any-allowlist'), url('not-in-any-allowlist', 'another', 'Q426SWEI2-7')
    async def feed(client, stream):
        return [{**observation(url=u), 'source_id': str(i)} for i, u in enumerate([a, b])]
    monkeypatch.setattr(sources, 'fetch_stream', feed)
    monkeypatch.setattr(sources, 'ACTIVE_STREAMS', sources.ACTIVE_STREAMS[:1])
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response())))
    monkeypatch.setattr(sources.httpx, 'AsyncClient', lambda **kwargs: client)
    assert asyncio.run(sources.collect(store))[0]['ok']
    assert len(store.search()['jobs']) == 1


def test_active_undo_blocks_merge_until_expiry(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    add(store, [url(), url(req='Q426SWEI2-2')])
    sync, device = ExtensionSync(store), str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    sync.receive(device, {**receipt('ats_confirmation'), 'job_url': url()})
    assert run(store)['held'] == 1
    with store.connect(True) as c:
        c.execute('UPDATE owner_submission_undo SET expires=0')
    assert run(store)['merged'] == 1


def test_external_application_is_resolved_through_fetched_alias(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    a, b = url(), url(req='Q426SWEI2-2')
    records = ApplicationRecords(store)
    records.mutate([dict(action='create', value=record(b))], 'external-record')
    add(store, [a, b])
    original = records.list()['applications'][0]['id']
    run(store)
    add(store, [a, b])
    sync = ExtensionSync(store)
    for page in (a, b):
        assert sync.resolve({'url': page})['application']['id'] == original
        assert not sync.resolve({'url': page})['queue']['allowed']
    assert len(records.list()['applications']) == 1


def test_owner_change_keeps_older_alias_ids_resolvable(tmp_path):
    store = Store(tmp_path / 'jobs.sqlite')
    a, b, d = url(), url(req='Q426SWEI2-2'), url(req='Q426SWEI2-3')
    add(store, [a, b])
    old_ids = [r['id'] for r in store.search()['jobs']]
    run(store)
    add(store, [a, b, d])
    sync, device = ExtensionSync(store), str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    sync.receive(device, {**receipt('ats_confirmation'), 'job_url': d})
    with store.connect(True) as c:
        c.execute('UPDATE owner_submission_undo SET expires=0')
    assert run(store)['merged'] == 1
    assert len(store.get_jobs(old_ids)) == 1
    assert store.get_jobs(old_ids)[0]['status'] == 'submitted'
