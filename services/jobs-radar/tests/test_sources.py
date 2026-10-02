import asyncio
import json
import time

import httpx
import pytest

from jobs_radar import sources
from jobs_radar.sources import STREAMS, fetch_stream, configured_streams, speedy_rows, simplify_rows
from jobs_radar.store import Store
from test_store import observation


def test_six_streams_and_cohort_configuration(monkeypatch):
    assert len(STREAMS) == len({s.id for s in STREAMS}) == 6
    streams = configured_streams(2028)
    assert next(s for s in streams if s.id == 'simplify:internship').repository == 'SimplifyJobs/Summer2028-Internships'
    assert all('2028-' in s.repository for s in streams if s.source == 'speedyapply')
    monkeypatch.setenv('JOBS_COHORT', '2030')
    assert '2030' in configured_streams()[1].repository
    with pytest.raises(ValueError):
        configured_streams(99)


def test_speedy_optional_salary_and_repository_section_independent():
    content = '''## Quant
| Company | Position | Location | Salary | Application | Posting Age |
| --- | --- | --- | --- | --- | --- |
| <a href="https://acme.com"><strong>Acme</strong></a> | ML Engineer | CA | $120k/yr | <a href="https://jobs.example.com/123">Apply</a> | 0d |
## Other
| Company | Position | Location | Application | Posting Age |
| --- | --- | --- | --- | --- |
| Acme | SWE | CA +4 | <a href="https://jobs.example.com/456">Apply</a> | 2d |
'''
    rows = speedy_rows(next(s for s in STREAMS if s.id == "speedyapply:AI:newgrad"), content, 1788900000)
    assert rows[0]["category"] == "Quant" and rows[0]["section"] == "Quant"
    assert rows[0]["source_category"] == "AI"
    assert rows[1]["salary"] is None and rows[1]["apply_url"].endswith("456")
    assert rows[0]["time_precision"] == "approximate_day"
    with pytest.raises(ValueError, match="column drift"):
        speedy_rows(next(s for s in STREAMS if s.id == "speedyapply:AI:newgrad"), content.replace("| Acme | SWE |", "| extra | Acme | SWE |"))


def test_rate_limit_retries_and_failure_retains_snapshot(tmp_path, monkeypatch):
    calls = []
    async def no_sleep(_):
        pass
    monkeypatch.setattr(sources.asyncio, "sleep", no_sleep)
    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "0"}) if len(calls) < 3 else httpx.Response(200, text="done")
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            response = await sources.request(client, "GET", STREAMS[0].url)
            assert response.text == "done" and len(calls) == 3
    asyncio.run(run())
    store = Store(tmp_path / "jobs.sqlite")
    store.ingest("simplify:newgrad", [observation()], "initial")
    broken = {**observation(), "source_id": "two", "apply_url": "file:///etc/passwd"}
    with pytest.raises(ValueError):
        store.ingest("simplify:newgrad", [observation(), broken], "bad")
    assert len(store.search()["jobs"]) == 1


def test_approximate_age_does_not_reset_first_seen(tmp_path):
    store = Store(tmp_path / "jobs.sqlite")
    row = {**observation(), "posted_at": observation()["posted_at"]-86400, "time_precision": "approximate_day"}
    store.ingest("simplify:newgrad", [row], "initial")
    first = store.search()["jobs"][0]
    store.ingest("simplify:newgrad", [{**row, "posted_at": row["posted_at"]+8000}], "later")
    latest = store.search()["jobs"][0]
    assert latest["first_seen"] == first["first_seen"] and latest["posted_at"] == row["posted_at"]


def simplify_fixture_rows(now=None):
    now = time.time() if now is None else now
    return [{"id": key, "company_name": "Employer", "title": 'New Grad Software Engineer',
             "url": 'https://example.com/' + key, "locations": ["CA"],
             "active": True, "is_visible": True, "category": category,
             "date_posted": now - 86400, "source": "Simplify", "terms": ["Summer 2027"]}
            for key, category in [('software', 'Software'), ('data', 'AI/ML/Data'), ('quant', 'Quant')]]


@pytest.mark.parametrize('kind', ['newgrad', 'internship'])
def test_simplify_fetch_uses_only_json_and_accepts_closed_or_new_roles(kind):
    stream = next(s for s in STREAMS if s.id == 'simplify:' + kind)
    rows = simplify_fixture_rows()
    rows[0]['active'] = False  # Old README could still list this closed role.
    rows.append({**rows[1], 'id': 'new-role', 'url': 'https://example.com/new-role'})
    requests = []
    def handler(request):
        requests.append(request)
        # Neither a broken/absent README nor the GitHub commits API is needed.
        assert str(request.url) == stream.url
        return httpx.Response(200, json=rows)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_stream(client, stream)
    result = asyncio.run(run())
    assert {row['source_id'] for row in result} == {'data', 'quant', 'new-role'}
    assert len(requests) == 1
    assert all(row['collection_scope'] == 'json-three-tracks-v2' for row in result)


@pytest.mark.parametrize('category,expected', [
    ('Software Engineering', 'Software'), (' software ', 'Software'),
    ('Data Science, AI & Machine Learning', 'AI/ML/Data'), ('AI/ML/Data', 'AI/ML/Data'),
    ('Quantitative Finance', 'Quant'), ('Quant', 'Quant'),
    ('Hardware', None), ('Product Management', None), ('Other', None), ('Unrecognized', None)])
def test_simplify_categories_are_structured_and_normalized(category, expected):
    stream = next(s for s in STREAMS if s.id == 'simplify:internship')
    row = {**simplify_fixture_rows()[0], 'category': category}
    result = simplify_rows(stream, [row])
    assert [r['category'] for r in result] == ([] if expected is None else [expected])
    if result:
        assert result[0]['source_category'] == category


@pytest.mark.parametrize('change', [
    {'active': False}, {'is_visible': False}, {'terms': ['Summer 2026']},
    {'terms': ['Summer 2028']}, {'terms': ['Winter 2027', 'Spring 2027']},
    {'terms': ['N/A']}, {'terms': ['Summer 20270']},
    {'company_url': 'https://simplify.jobs/c/Jerry'}])
def test_simplify_internship_scope_exclusions(change):
    stream = next(s for s in STREAMS if s.id == 'simplify:internship')
    assert simplify_rows(stream, [{**simplify_fixture_rows()[0], **change}]) == []


def test_simplify_cohort_and_source_age_boundaries():
    now = 1790636503
    stream = next(s for s in configured_streams(2028) if s.id == 'simplify:internship')
    row = simplify_fixture_rows(now)[0]
    # Configured cohort, not a hard-coded year; future season posts start May 2027.
    now_2027 = now + 365 * 86400
    row.update(terms=['Spring 2028', 'Summer 2028'], date_posted=now_2027 - 59 * 86400)
    assert len(simplify_rows(stream, [row], observed_at=now_2027)) == 1
    row['date_posted'] = now_2027 - 60 * 86400
    assert simplify_rows(stream, [row], observed_at=now_2027) == []
    row['date_posted'] = now_2027 + 1
    assert simplify_rows(stream, [row], observed_at=now_2027) == []
    row['date_posted'] = 1777618800  # May 1, 2026 source cutoff is exclusive.
    stream = next(s for s in configured_streams(2027) if s.id == 'simplify:internship')
    row['terms'] = ['Summer 2027']
    assert simplify_rows(stream, [row], observed_at=1777618801) == []


@pytest.mark.parametrize('title,accepted', [
    ('New Grad Software Engineer', True), ('Software Engineer I', True),
    ('Entry Level Data Scientist', True), ('Junior Quantitative Researcher', True),
    ('Senior Software Engineer', False), ('Staff Machine Learning Engineer', False),
    ('New Grad Sales Representative', False)])
def test_simplify_newgrad_preserves_entry_level_gate(title, accepted):
    stream = next(s for s in STREAMS if s.id == 'simplify:newgrad')
    row = {**simplify_fixture_rows()[0], 'title': title}
    assert bool(simplify_rows(stream, [row])) == accepted


def test_simplify_newgrad_community_age_and_official_source_dates():
    now = 1790636503
    stream = next(s for s in STREAMS if s.id == 'simplify:newgrad')
    row = {**simplify_fixture_rows(now)[0], 'source': 'Community', 'title': 'Software Engineer',
           'date_posted': now - 120 * 86400}
    assert len(simplify_rows(stream, [row], observed_at=now)) == 1
    row['date_posted'] -= 86400
    assert simplify_rows(stream, [row], observed_at=now) == []
    row.update(source='Simplify', title='New Grad Software Engineer')
    assert len(simplify_rows(stream, [row], observed_at=now)) == 1
    row['date_posted'] = 1748761200
    assert simplify_rows(stream, [row], observed_at=now) == []


@pytest.mark.parametrize('change', [
    {'active': 'false'}, {'is_visible': None}, {'category': None}, {'date_posted': None},
    {'date_posted': float('nan')}, {'terms': 'Summer 2027'}, {'locations': 'CA'}, {'id': ''}])
def test_simplify_invalid_json_preserves_existing_collection(tmp_path, monkeypatch, change):
    stream = next(s for s in STREAMS if s.id == 'simplify:internship')
    rows = simplify_fixture_rows()
    store = Store(tmp_path / 'jobs.sqlite')
    store.ingest(stream.id, simplify_rows(stream, rows), 'initial', scoped_only=True)
    before = store.search(active_only=True)['jobs']
    invalid_rows = [{**rows[0], **change}, *rows[1:]]
    # Return invalid data directly so NaN can exercise the parser validation too.
    async def bad_fetch(client, actual_stream):
        return simplify_rows(actual_stream, invalid_rows)
    monkeypatch.setattr(sources, 'ACTIVE_STREAMS', [stream])
    monkeypatch.setattr(sources, 'fetch_stream', bad_fetch)
    result = asyncio.run(sources.collect(store, [stream.id]))
    assert result[0]['ok'] is False
    assert store.search(active_only=True)['jobs'] == before


def test_simplify_non_list_and_empty_payload_preserve_snapshot(tmp_path, monkeypatch):
    stream = next(s for s in STREAMS if s.id == 'simplify:internship')
    with pytest.raises(ValueError, match='not a list'):
        simplify_rows(stream, {'error': 'upstream failure'})
    store = Store(tmp_path / 'jobs.sqlite')
    store.ingest(stream.id, simplify_rows(stream, simplify_fixture_rows()), 'initial', scoped_only=True)
    async def empty_fetch(client, actual_stream):
        return simplify_rows(actual_stream, [])
    monkeypatch.setattr(sources, 'ACTIVE_STREAMS', [stream])
    monkeypatch.setattr(sources, 'fetch_stream', empty_fetch)
    result = asyncio.run(sources.collect(store, [stream.id]))
    assert not result[0]['ok'] and 'Empty source snapshot' in result[0]['error']
    assert len(store.search(active_only=True)['jobs']) == 3


def test_real_feed_embed_and_eightfold_urls_do_not_abort_the_collection(tmp_path):
    urls = [
        'https://boards.greenhouse.io/embed/job_app?token=7669159003&utm_source=Simplify&ref=Simplify',
        'https://qualcomm.eightfold.ai/careers/job/446721063770?utm_source=Simplify',
        'https://bostonscientific.eightfold.ai/careers/job/563602813542900',
    ]
    rows = [{**row, 'url': url} for row, url in zip(simplify_fixture_rows(), urls)]
    selected = simplify_rows(next(s for s in STREAMS if s.id == 'simplify:newgrad'), rows)
    store = Store(tmp_path / 'jobs.sqlite')
    store.ingest('simplify:newgrad', selected, 'fixture')
    assert len(store.search()['jobs']) == 3


def test_speedy_real_heading_levels_posting_column_and_stable_ids():
    from hashlib import sha256
    content = '''## 2027 USA AI Internships :books::eagle:
### FAANG+
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | AI | CA | <a href="https://example.com/ai">Apply</a> | 0d |
### Quant
| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| Example | Quant | NY | $100k | <a href="https://example.com/quant">Apply</a> | 1d |
### Other
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | ML | CA | <a href="https://example.com/ml">Apply</a> | 2d |
'''
    rows = speedy_rows(next(s for s in STREAMS if s.id == "speedyapply:AI:internship"), content)
    assert [r['section'] for r in rows] == ['FAANG+', 'Quant', 'Other']
    assert [r['category'] for r in rows] == ['AI/ML/Data', 'Quant', 'AI/ML/Data']
    assert rows[1]['source_id'] == sha256(('2027 USA AI Internships :books::eagle:|https://example.com/quant').encode()).hexdigest()[:24]
    assert rows[1]['source_url'].endswith('#quant')


@pytest.mark.parametrize('scope', ['readme-three-tracks-v1', 'json-three-tracks-v2'])
def test_prune_retired_simplify_preserves_history_and_shared_jobs(tmp_path, scope):
    from jobs_radar.identity import identity, stable_id
    store = Store(tmp_path / 'prune.sqlite')
    records = [{**observation(url='https://example.com/'+key), 'source_id':key} for key in ['keep','unused','touched','shared']]
    store.ingest('simplify:newgrad', records, 'old')
    touched = stable_id(identity('https://example.com/touched'))
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='needs_input',version=1 WHERE job_id=?", (touched,))
    store.ingest('speedyapply:SWE:newgrad', [{**records[3], 'source':'speedyapply'}], 'other')
    with pytest.raises(ValueError, match='scoped collection'):
        store.prune_simplify('simplify:newgrad')
    store.ingest('simplify:newgrad', [{**records[0], 'collection_scope':scope, 'category':'Software'}], 'scoped')
    before = store.progress()
    assert store.prune_simplify('simplify:newgrad', dry_run=True)['discarded_observations'] == 2
    assert len(store.get_jobs([touched])[0]['all_sources']) == 1
    store.prune_simplify('simplify:newgrad')
    assert store.get_jobs([touched])[0]['status'] == 'needs_input'
    assert not store.get_jobs([stable_id(identity('https://example.com/unused'))])
    assert store.get_jobs([stable_id(identity('https://example.com/shared'))])
    reopened = Store(store.path)
    assert {j['id'] for j in reopened.search(active_only=False)['jobs']} == {
        stable_id(identity('https://example.com/keep')), stable_id(identity('https://example.com/shared'))}
    assert reopened.progress()['counts']['needs_input'] == before['counts']['needs_input']
