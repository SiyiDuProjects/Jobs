import json

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.geography import non_us_only
from jobs_radar.luna_screening import ScreeningError, classify, public_input
from jobs_radar.store import Store
from test_store import observation


@pytest.mark.parametrize('locations,excluded', [
    (['London, UK'], True), (['London, U.K.'], True), (['London, GB'], True),
    (['Remote - United Kingdom'], True), (['Dublin, Ireland'], True),
    (['Toronto, ON, Canada'], True), (['Berlin, Germany'], True),
    (['Bengaluru, India'], True), (['Seoul, South Korea'], True),
    (['British Virgin Islands'], True), (['U.S. Virgin Islands'], False),
    (['London, UK', 'Dublin, Ireland'], True),
    (['London, UK / Dublin, Ireland'], True),
    (['London, UK', 'Chicago, IL'], False),
    (['London, UK / Seattle, WA'], False),
    (['London, UK, New Mexico'], False),
    (['London, UK', 'Remote - USA'], False),
    (['London, UK', 'U.S.'], False),
    (['London, UK', 'San Francisco'], False),
    (['London, UK', ''], False), (['London, UK', 'Remote'], False),
    (['London, UK / Remote'], False), (['London, UK +1'], False),
    (['London, UK (Worldwide)'], False),
    (['California, MD'], False), (['China Lake, CA'], False),
    (['New Mexico'], False), (['New Jersey'], False),
    (['Georgia'], False), (['Puerto Rico'], False),
    (['Unknown'], False), (['London'], False), ([], False),
])
def test_only_explicit_foreign_locations_are_excluded(locations, excluded):
    assert non_us_only(locations) is excluded


def source(key, locations, kind='internship', company='Google'):
    return {**observation(company=company, url='https://example.org/' + key),
            'source_id':key, 'source_url':'https://example.org/source',
            'kind':kind, 'locations':locations, 'title':'Software Engineer Intern'}


@pytest.mark.parametrize('kind', ['newgrad', 'internship'])
def test_import_excludes_foreign_faang_and_other_roles_without_changing_applications(tmp_path, kind):
    store=Store(tmp_path/'foreign.sqlite'); board=Board(store)
    rows=[source('databricks', ['London, UK'], kind, 'Databricks'),
          source('google', ['London, UK'], kind),
          source('other', ['Dublin, Ireland'], kind, 'Ordinary'),
          source('mixed', ['London, UK', 'Chicago, IL'], kind),
          source('unknown', [], kind), source('us', ['Chicago, IL'], kind)]
    store.ingest('simplify:'+kind, rows, 'import', scoped_only=True)
    assert board.list(kind=kind)['total']==3
    removed=board.list(kind=kind, view='trash')['jobs']
    assert len(removed)==3
    assert all(r['review']['reason']=='non_us_only' for r in removed)
    assert {r['review']['evidence'][0]['quote'] for r in removed}=={'London, UK','Dublin, Ireland'}
    assert len(store.search(kind=kind, location='')['jobs'])==3
    store.ingest('simplify:'+kind, rows, 'resync', scoped_only=True)
    assert board.list(kind=kind)['total']==3
    with store.connect() as c:
        assert all(r['status']=='not_started' and r['version']==0 for r in c.execute('SELECT * FROM applications'))
        assert c.execute('SELECT sum(version) FROM job_screening').fetchone()[0]==3


@pytest.mark.parametrize('other_locations', [['Chicago, IL'], []])
def test_current_sources_are_aggregated_before_country_exclusion(tmp_path, other_locations):
    store=Store(tmp_path/'mixed.sqlite'); board=Board(store)
    uk=source('shared', ['London, UK'])
    store.ingest('simplify:internship', [uk], 'legacy')
    store.ingest('speedyapply:SWE:internship', [{**uk, 'source':'speedyapply', 'locations':other_locations}], 'us', scoped_only=True)
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    assert board.list(kind='internship')['total']==1


@pytest.mark.parametrize('other_locations', [['Chicago, IL'], []])
def test_later_us_or_unresolved_source_requeues_only_automatic_country_exclusions(tmp_path, other_locations):
    store=Store(tmp_path/'later-source.sqlite'); board=Board(store)
    uk=source('shared', ['London, UK'])
    store.ingest('simplify:internship', [uk], 'uk', scoped_only=True)
    assert board.list(kind='internship')['total']==0
    store.ingest('speedyapply:SWE:internship', [{**uk, 'source':'speedyapply', 'locations':other_locations}], 'us', scoped_only=True)
    job=board.list(kind='internship')['jobs'][0]
    assert job['screening']=='pending' and job['review_version']==2
    assert board.queue('internship')['jobs'][0]['id']==job['id']
    # An explicit owner's removal is persistent even when source facts change.
    board.review(job['id'], 'internship', 'trash', 'manual', 'Owner deletion',
        [{'url':job['source_url'],'quote':job['title'],'observed_at':'2026-10-05T00:00:00Z'}],
        job['fingerprint'], job['review_version'], 'owner-trash', actor='web-owner')
    store.ingest('simplify:internship', [{**uk, 'locations':['San Francisco, CA']}], 'change', scoped_only=True)
    assert board.list(kind='internship')['total']==0


def test_backfill_corrects_automatic_keeps_and_preserves_processed_and_restored_roles(tmp_path):
    store=Store(tmp_path/'backfill.sqlite'); board=Board(store)
    rows=[source(key, ['London, UK']) for key in ['auto','submitted','claimed','restored']]
    store.ingest('simplify:internship', rows, 'legacy')
    jobs={r['apply_url'].rsplit('/',1)[-1]:r for r in board._rows('internship')}
    auto=jobs['auto']
    board.review(auto['id'], 'internship', 'keep', 'eligible', 'Old title-only decision', [],
                 auto['fingerprint'], 0, 'old-keep')
    board.mark_submitted(jobs['submitted']['id'], 0, 'Owner receipt', 'owner-submission')
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='in_progress',version=1 WHERE job_id=?", (jobs['claimed']['id'],))
    restored=jobs['restored']
    board.review(restored['id'], 'internship', 'trash', 'non_us_only', 'Foreign',
                 [{'url':restored['source_url'], 'quote':'London, UK', 'observed_at':'2026-10-05T00:00:00Z'}],
                 restored['fingerprint'], 0, 'foreign-trash')
    board.review(restored['id'], 'internship', 'restore', '', 'Owner restored', [],
                 restored['fingerprint'], 1, 'owner-restored', actor='web-owner')
    with store.connect() as c:
        before=[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    assert store.screen_titles()=={'newgrad':0,'internship':1}
    assert store.screen_titles()=={'newgrad':0,'internship':0}
    assert next(r for r in board._rows('internship') if r['id']==auto['id'])['screening']=='trash'
    with store.connect() as c:
        assert before==[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        assert c.execute('SELECT state,manual_keep FROM job_screening WHERE job_id=?', (restored['id'],)).fetchone()[:]==('keep',1)


@pytest.mark.parametrize('region', ['', 'focus_remote', 'ca', 'ca_remote'])
def test_compact_faang_exemption_keeps_us_and_unclear_but_not_foreign(tmp_path, region):
    store=Store(tmp_path/'compact.sqlite'); board=Board(store)
    # A legacy import exercises the list guard before the ingestion backfill.
    store.ingest('simplify:internship', [source('foreign', ['London, UK']),
        source('us', ['Chicago, IL']), source('mixed', ['London, UK', 'Chicago, IL']),
        source('unknown', [])], 'legacy')
    result=board.list(kind='internship', compact='1', region=region)
    assert {r['apply_url'].rsplit('/',1)[-1] for r in result['jobs']}=={'us','mixed','unknown'}
    assert board.filter_counts(compact='1', region=region)['internship']['total']==3


@pytest.mark.parametrize('locations', [['London, UK','Chicago, IL'], ['London, UK','']])
def test_non_us_review_rejects_mixed_or_unresolved_evidence(tmp_path, locations):
    store=Store(tmp_path/'review.sqlite'); board=Board(store)
    store.ingest('simplify:internship', [source('mixed', locations)], 'legacy')
    job=board.list(kind='internship')['jobs'][0]
    with pytest.raises(ValueError, match='Mixed or unresolved'):
        board.review(job['id'], 'internship', 'trash', 'non_us_only', 'Bad country removal',
            [{'url':job['source_url'], 'quote':'London, UK', 'observed_at':'2026-10-05T00:00:00Z'}],
            job['fingerprint'], 0, 'bad-country-removal')
    assert board.list(kind='internship')['total']==1


@pytest.mark.parametrize('locations,valid', [(['London, UK'],True), (['London, UK','Chicago, IL'],False)])
def test_model_receives_locations_and_geographic_evidence_has_its_own_reason(locations, valid):
    src=source('model', locations)
    row={'id':'canonical', 'kind':'internship', 'company':'Google', 'title':src['title'], 'all_sources':[src]}
    assert public_input(row,'job_0')['sources'][0]['locations']==locations
    def handler(request):
        payload=json.loads(request.content)
        assert json.loads(payload['input'])[0]['locations']==locations
        assert 'source location' in payload['instructions']
        return httpx.Response(200,json={'status':'completed', 'output':[{'content':[{'type':'output_text',
            'text':json.dumps({'jobs':{'job_0':{'decision':'trash','reason':'仅限英国','evidence_quote':'London, UK'}}})}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        if valid:
            decisions,_=classify(client,[row])
            assert decisions[0]['reason_code']=='non_us_only'
        else:
            with pytest.raises(ScreeningError,match='evidence_mismatch'): classify(client,[row])
