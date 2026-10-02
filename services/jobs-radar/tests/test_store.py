import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from jobs_radar.identity import identity
from jobs_radar.store import Store


def observation(source="simplify", h1b=None, company="Test Employer", url="https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555"):
    return {"source": source, "source_id": "source1", "apply_url": url, "title": "Software Engineer", "company": company,
            "locations": ["San Francisco, CA"], "h1b": h1b, "kind": "newgrad", "posted_at": time.time(), "active": True, "visible": True}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "jobs.sqlite")
    s.ingest("simplify:newgrad", [observation()], "test")
    return s


def jid(store):
    return store.search()["jobs"][0]["id"]


def test_identity_tenant_and_query():
    assert identity("https://boards.greenhouse.io/acme/jobs/123?utm_campaign=x") == identity("https://job-boards.greenhouse.io/acme/jobs/123")
    assert identity("https://job-boards.greenhouse.io/other/jobs/123") != identity("https://job-boards.greenhouse.io/acme/jobs/123")
    assert identity("https://example.org/job?jobId=1") != identity("https://example.org/job?jobId=2")
    assert identity("https://example.org/job?gh_jid=1") != identity("https://example.org/job?gh_jid=2")


def test_reingest_stable_sources_and_separate_filter_evaluation(store):
    first = jid(store)
    store.ingest("simplify:newgrad", [observation()], "test2")
    store.ingest("jobright:newgrad:us:swe", [observation("jobright", "No")], "test2")
    result = store.search()["jobs"]
    assert len(result) == 1 and result[0]["id"] == first
    assert len(result[0]["all_sources"]) == 2
    assert result[0]["matched_sources"] == ["simplify:newgrad"]
    assert len(store.search()["jobs"][0]["matched_sources"]) == 1


def test_titles_do_not_merge(store):
    store.ingest("speedyapply:AI:newgrad", [observation(url="https://example.org/job?jobId=second")], "run")
    assert len(store.search()["jobs"]) == 2


def test_bounded_pagination_keeps_all_matched_sources(store):
    store.ingest("speedyapply:SWE:newgrad", [observation("speedyapply")], "shared")
    store.ingest("speedyapply:AI:newgrad", [observation(url="https://example.com/another")], "another")
    first = store.search(limit=1)
    second = store.search(limit=1, cursor=first["next_cursor"])
    assert len(first['jobs']) == len(second['jobs']) == 1 and second['next_cursor'] is None
    assert first['jobs'][0]['id'] != second['jobs'][0]['id']
    shared = next(j for j in first['jobs'] + second['jobs'] if len(j['matched_sources']) == 2)
    assert shared['matched_sources'] == ['simplify:newgrad', 'speedyapply:SWE:newgrad']


def test_failure_preserves_data_and_stale_health(store):
    store.source_error("simplify:newgrad", "schema changed", "failed")
    assert len(store.search()["jobs"]) == 1
    assert store.health()["sources"][0]["stale"]
    with pytest.raises(ValueError):
        store.ingest("simplify:newgrad", [], "failed")
    assert len(store.search()["jobs"]) == 1






def test_backup_restore(store, tmp_path):
    with pytest.raises(ValueError, match="differ"):
        store.backup(store.path)
    target = tmp_path / "restored.sqlite"
    store.backup(target)
    restored = Store(target)
    assert restored.search()["jobs"] == store.search()["jobs"]


def test_snapshot_retention_preserves_current_payload(store):
    with store.connect(True) as c:
        c.execute("UPDATE snapshots SET observed_at=0")
        c.execute("INSERT INTO snapshots SELECT stream,source_id,'obsolete',0,'{}' FROM observations")
    assert store.prune_snapshots() == 1
    with store.connect() as c:
        assert c.execute("SELECT count(*) FROM snapshots").fetchone()[0] == 1
