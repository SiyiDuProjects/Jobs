import pytest
from starlette.testclient import TestClient

from jobs_radar.board import Board
from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess
from test_store import observation


def test_compact_preserves_tagged_jobs_but_respects_explicit_filters(tmp_path):
    store = Store(tmp_path/'compact.sqlite')
    board = Board(store)
    for kind in ('newgrad', 'internship'):
        rows = []
        for i, (company, location, section) in enumerate([
            ('Google', 'Chicago, IL', ''),
            ('Perpay', 'Chicago, IL', 'FAANG+'),
            ('Ordinary Outside', 'Chicago, IL', ''),
            ('Ordinary Inside', 'San Francisco, CA', ''),
        ]):
            rows.append({**observation(company=company, url=f'https://example.org/{kind}/{i}'),
                         'source_id':str(i), 'kind':kind, 'locations':[location], 'section':section})
        store.ingest('simplify:'+kind, rows, 'compact-test')
    filters = dict(status='recent', region='focus_remote', intern_companies='1')
    before = store.progress()
    for kind in ('newgrad', 'internship'):
        assert board.list(kind=kind, **filters)['total'] == 1
        result = board.list(kind=kind, compact='1', **filters)
        assert {j['company'] for j in result['jobs']} == {'Google', 'Perpay', 'Ordinary Inside'}
        assert board.list(kind=kind, compact='1', group='faang', **filters)['total'] == 2
        assert board.list(kind=kind, compact='1', exclude_companies='Google,Perpay', **filters)['total'] == 1
        assert board.list(kind=kind, compact='1', text='Outside', **filters)['total'] == 0
        assert board.list(kind=kind, compact='1', location='Chicago', **filters)['total'] == 2
        assert board.list(kind=kind, compact='1', status='submitted', region='focus_remote')['total'] == 0
    origin = 'http://127.0.0.1:8796'
    with TestClient(create_server(store, origin).streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url=origin) as client:
        WebAccess(store, origin).approve(client.get('/api/session').json()['request_id'])
        params = {**filters, 'compact':'1', 'page_size':1}
        counts = client.get('/api/filter-counts', params=params).json()
        assert counts['total'] == 6
        for kind in ('newgrad', 'internship'):
            result = client.get('/api/jobs', params={**params, 'kind':kind}).json()
            assert result['total'] == counts[kind]['total'] == 3
            assert len(result['jobs']) == 1
        assert client.get('/api/jobs?compact=bad').status_code == 400
    assert store.progress() == before
    job = next(j for j in board.list(kind='internship', compact='1', **filters)['jobs'] if j['company']=='Google')
    board.review(job['id'], 'internship', 'trash', 'manual', 'User deletion',
                 [{'url':job['apply_url'], 'quote':job['title'], 'observed_at':'2026-09-19T00:00:00Z'}],
                 job['fingerprint'], 0, 'compact-trash-001', actor='web-owner')
    assert board.list(kind='internship', compact='1', group='faang', **filters)['total'] == 1
