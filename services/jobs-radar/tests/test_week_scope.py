import asyncio
import time

import pytest

from jobs_radar.board import Board
from jobs_radar.identity import identity, stable_id
from jobs_radar.sources import ACTIVE_STREAMS, collect
from jobs_radar.store import Store
from test_store import observation


def role(key, posted_at, source='simplify'):
    return {**observation(source=source, url='https://example.org/'+key),
            'source_id': key, 'posted_at': posted_at}


def test_all_dates_for_board_mcp_and_screening(tmp_path):
    now = time.time()
    store = Store(tmp_path/'scope.sqlite')
    store.ingest('simplify:newgrad', [role('fresh',now-6*86400), role('old',now-8*86400),
                                    role('unknown',None), role('future',now+86400)], 'old-data')
    store.ingest('jobright:newgrad:us:swe',[role('jobright',now-60,'jobright')],'old-data')
    board = Board(store)
    jid = stable_id(identity('https://example.org/fresh'))
    expected = {stable_id(identity('https://example.org/'+key)) for key in ['fresh','old','unknown']}
    assert {r['id'] for r in board.list()['jobs']} == expected
    assert {r['id'] for r in board.queue('newgrad')['jobs']} == expected
    assert {r['id'] for r in store.search(active_only=False)['jobs']} == expected
    assert [r['id'] for r in store.search(posted_within_hours=168)['jobs']] == [jid]
    assert store.search(sources=['jobright'])['jobs'] == []
    assert sum(r['count'] for r in store.filter_options()['categories']) == 3
    assert store.filter_options()['default_filters']['posted_within_hours'] is None
    for key in ['future','jobright']:
        excluded = stable_id(identity('https://example.org/'+key))
        assert store.get_jobs([excluded])  # History remains addressable.
        with pytest.raises(ValueError,match='Source content changed'):
            board.review(excluded,'newgrad','keep','','No longer in current scope',[], '',0,'review-'+key)
    assert len(store.health()['sources']) == store.health()['expected_streams'] == 6
    assert len({s.repository for s in ACTIVE_STREAMS}) == 4


def test_collection_keeps_old_and_unknown_dates_and_refreshes_source_presence(tmp_path):
    store = Store(tmp_path/'ingest.sqlite')
    now = time.time()
    fresh = role('fresh',now-60)
    assert store.ingest('simplify:newgrad',[fresh,role('old',now-8*86400),role('unknown',None),role('future',now+86400)],'initial',scoped_only=True) == 3
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM jobs').fetchone()[0] == 3
    assert store.ingest('simplify:newgrad',[{**fresh,'posted_at':now-8*86400}], 'aged',scoped_only=True) == 1
    assert len(store.search()['jobs']) == 1
    assert not store.health()['sources'][0]['stale']
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM jobs').fetchone()[0] == 3
        assert c.execute('SELECT count(*) FROM observations WHERE present=1').fetchone()[0] == 1
    with pytest.raises(ValueError,match='four approved'):
        asyncio.run(collect(store,['jobright:newgrad:us:swe']))


def test_approximate_date_cannot_rejuvenate_and_expired_deletion_survives(tmp_path):
    store=Store(tmp_path/'age.sqlite')
    old={**role('age',time.time()-8*86400),'time_precision':'approximate_day'}
    store.ingest('simplify:newgrad',[old],'historical')
    jid=stable_id(identity(old['apply_url']))
    with store.connect(True) as c:
        c.execute("INSERT INTO job_screening VALUES(?,?,'trash','manual','Deleted','[]','old',?,?,1,0)",
                  (jid,'newgrad',time.time()-90000,time.time()-3600))
    assert store.ingest('simplify:newgrad',[{**old,'posted_at':time.time()-60}], 'refresh',scoped_only=True)==1
    with store.connect() as c:
        assert c.execute('SELECT state FROM job_screening').fetchone()[0]=='trash'
    assert store.get_jobs([jid])[0]['all_sources'][0]['posted_at']==old['posted_at']
    assert not Board(store).list()['jobs']
