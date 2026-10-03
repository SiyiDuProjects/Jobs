"""Page -> listed job resolution shared by deletion, receipts and Profile binding."""
import json
import uuid
from datetime import datetime, timezone

import pytest
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.job_match import job_key
from jobs_radar.store import Store
from test_store import observation

DEVICE = str(uuid.uuid4())


def listed(tmp_path, *urls, kind='newgrad'):
    store = Store(tmp_path / 'resolve.sqlite')
    rows = []
    for i, url in enumerate(urls):
        row = {**observation(url=url), 'source_id': f'source{i}', 'kind': kind}
        rows.append(row)
    store.ingest(f'simplify:{kind}', rows, 'resolve')
    sync = ExtensionSync(store); sync.pair(DEVICE, EXTENSION_ID)
    return store, sync


def job_id(store, url):
    with store.connect() as c:
        return c.execute("SELECT job_id FROM observations WHERE json_extract(payload,'$.apply_url')=?", (url,)).fetchone()[0]


def manual_delete(url, hint=None):
    p = dict(event_id=str(uuid.uuid4()), proof='manual_remove', job_url=url, code='manual',
             quote='用户在插件中手动删除岗位', observed_at=datetime.now(timezone.utc).isoformat(), detail='不合适')
    if hint: p['website_job_id'] = hint
    return p


HUB = 'https://careers.example.com/jobs/1234567?icims=1'


@pytest.mark.parametrize('page', [
    'https://careers.example.com/careers-home/jobs/1234567',
    'https://careers.example.com/jobs/1234567/apply/step-2',
])
def test_website_hint_matches_a_page_of_the_same_posting(tmp_path, page):
    store, sync = listed(tmp_path, HUB)
    jid = job_id(store, HUB)
    assert job_key(page) != job_key(HUB)
    assert sync.receive(DEVICE, manual_delete(page))['state'] == 'unmatched'
    result = sync.receive(DEVICE, manual_delete(page, jid))
    assert result['state'] == 'removed' and result['matched_by'] == 'hint' and result['job_ids'] == [jid]


@pytest.mark.parametrize('page', [
    'https://careers.example.com/jobs/7654321',              # another posting on the same site
    'https://jobs.otherco.org/jobs/1234567',                   # same number, another company's site
    'https://careers.example.com/jobs/about-2027-interns',    # no identifier at all
])
def test_stale_or_foreign_hint_never_removes_the_launched_job(tmp_path, page):
    store, sync = listed(tmp_path, HUB)
    jid = job_id(store, HUB)
    assert sync.receive(DEVICE, manual_delete(page, jid))['state'] == 'unmatched'


def test_multi_company_host_requires_the_same_company(tmp_path):
    url = 'https://jobs.smartrecruiters.com/Acme/7440001413263'
    store, sync = listed(tmp_path, url)
    jid = job_id(store, url)
    other = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Other/publication/7440001413263'
    assert sync.receive(DEVICE, manual_delete(other, jid))['state'] == 'unmatched'


def test_receipt_uses_the_same_resolution(tmp_path):
    store, sync = listed(tmp_path, HUB)
    jid = job_id(store, HUB)
    receipt = dict(event_id=str(uuid.uuid4()), job_url='https://careers.example.com/careers-home/jobs/1234567',
                   job_title='Software Engineer', company='Test Employer', observed_at='2026-09-23T12:00:00Z',
                   proof='tracker_record', website_job_id=jid)
    result = sync.receive(DEVICE, receipt)
    assert result['state'] == 'submitted' and result['matched_by'] == 'hint'
    assert store.get_jobs([jid])[0]['status'] == 'submitted'


def test_tracking_and_trailing_slash_do_not_change_identity():
    assert job_key('https://www.careers.example.com/job/?id=77&utm_source=Simplify&ref=Simplify') == \
        job_key('https://careers.example.com/job?id=77')
    assert job_key('https://careers.example.com/job?id=77') != job_key('https://careers.example.com/job?id=78')
    assert job_key('https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=341975') == \
        job_key('https://textron.taleo.net/careersection/application.jss?lang=en&job=341975')


def test_ashby_company_case_is_normalized_without_cross_company_or_generic_path_merges():
    url = 'https://jobs.ashbyhq.com/Example/00cd591f-6894-4259-83b6-36c999351dde/application'
    assert job_key(url) == job_key(url.replace('/Example/', '/example/').removesuffix('/application'))
    assert job_key(url) != job_key(url.replace('/Example/', '/other/'))
    assert job_key('https://example.test/CaseSensitive') != job_key('https://example.test/casesensitive')


@pytest.mark.parametrize('a,b', [
    ('https://acme.wd5.myworkdaysite.com/recruiting/acme/External/job/Seattle/Engineer_R-123456',
     'https://acme.wd5.myworkdaysite.com/en-US/recruiting/acme/External/job/Seattle/Engineer_R-123456/apply/applyManually'),
    ('https://egay.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_4001/job/39682',
     'https://egay.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_4001/job/39682/apply/section/1'),
    ('https://amazon.jobs/en/jobs/10529525/software-development-engineer-intern', 'https://www.amazon.jobs/jobs/10529525/apply'),
    ('https://jobs.apple.com/en-us/details/200664785-3810', 'https://jobs.apple.com/app/en-us/apply/200664785-3810'),
    ('https://app.careerpuck.com/job-board/lyft/job/8772571002?gh_jid=8772571002', 'https://app.careerpuck.com/apply?gh_jid=8772571002'),
])
def test_new_ats_rules_follow_the_application_steps(a, b):
    assert job_key(a) and job_key(a) == job_key(b)


def test_resolve_reports_kind_for_profile_binding(tmp_path):
    url = 'https://job-boards.greenhouse.io/acme/jobs/4455667'
    store, sync = listed(tmp_path, url, kind='internship')
    result = sync.resolve({'url': 'https://job-boards.greenhouse.io/acme/jobs/4455667?gh_src=abc'})
    assert result['state'] == 'matched' and result['kinds'] == ['intern'] and result['matched_by'] == 'url'
    assert sync.resolve({'url': 'https://job-boards.greenhouse.io/acme/jobs/9999999'}) == {'state': 'unmatched', 'application': None}


def test_queue_eligibility_is_read_only_and_blocks_all_prior_attempt_states(tmp_path):
    url = 'https://job-boards.greenhouse.io/acme/jobs/4455667'
    store, sync = listed(tmp_path, url)
    jid = job_id(store, url)
    before = store.get_jobs([jid])[0]
    assert sync.resolve({'url': url})['queue']['allowed'] is True
    assert store.get_jobs([jid])[0] == before
    for status in ('in_progress', 'needs_input', 'submitted_unconfirmed', 'submitted', 'skipped', 'retryable_failure'):
        with store.connect(True) as c:
            c.execute('UPDATE applications SET status=? WHERE job_id=?', (status, jid))
        queue = sync.resolve({'url': url})['queue']
        assert queue['allowed'] is False and queue['reason'] == 'application_history'


def test_queue_eligibility_rechecks_current_listing_and_active_claim(tmp_path):
    import time
    url = 'https://jobs.ashbyhq.com/acme/abcdefgh-1234-1234-1234-abcdefghijkl'
    store, sync = listed(tmp_path, url)
    jid = job_id(store, url)
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted_unconfirmed' WHERE job_id=?",(jid,))
    assert sync.resolve({'url': url})['queue']['reason'] == 'application_history'
    with store.connect(True) as c:
        c.execute("UPDATE applications SET status='not_started' WHERE job_id=?",(jid,))
        c.execute('UPDATE search_index SET visible=0 WHERE job_id=?', (jid,))
    assert sync.resolve({'url': url})['queue']['reason'] == 'not_in_current_list'
    with pytest.raises(ValueError):
        sync.resolve({'url': 'javascript:alert(1)'})


@pytest.mark.parametrize('hub,page', [
    ('https://www.squarepoint-capital.com/open-opportunities?id=8209423&gh_jid=8209423',
     'https://job-boards.greenhouse.io/squarepointcapital/jobs/8209423'),
    ('https://careers.amd.com/jobs/90910?icims=1',
     'https://campus-amd.icims.com/jobs/90910/summer-2027-phd-gen-ai-research-intern/job'),
])
def test_company_hub_and_its_ats_are_one_posting_when_launched_from_the_website(tmp_path, hub, page):
    store, sync = listed(tmp_path, hub)
    jid = job_id(store, hub)
    assert sync.receive(DEVICE, manual_delete(page, jid))['matched_by'] == 'hint'


@pytest.mark.parametrize('page', [
    'https://job-boards.greenhouse.io/othercompany/jobs/8209423',      # same number, another company
    'https://campus-intel.icims.com/jobs/90910/some-role/job',          # same number, another company
])
def test_hub_corroboration_requires_the_same_company(tmp_path, page):
    hub = 'https://careers.amd.com/jobs/90910?icims=1'
    store, sync = listed(tmp_path, hub)
    assert sync.receive(DEVICE, manual_delete(page, job_id(store, hub)))['state'] == 'unmatched'


@pytest.mark.parametrize('listed_url,page', [
    ('https://job-boards.greenhouse.io/acme/jobs/1234567',
     'https://job-boards.greenhouse.io/acme/jobs/7654321?returnUrl=%2Facme%2Fjobs%2F1234567'),
    ('https://job-boards.greenhouse.io/acme/jobs/1234567',
     'https://job-boards.greenhouse.io/acme/jobs/7654321?previousJob=1234567'),
    ('https://careers.example.com/jobs/1234567',
     'https://careers.example.com/jobs/7654321?returnUrl=%2Fjobs%2F1234567'),
    ('https://careers.example.com/jobs/1234567',
     'https://careers.example.com/jobs/7654321?returnUrl=/jobs/1234567'),
    ('https://www.squarepoint-capital.com/open-opportunities?gh_jid=1234567',
     'https://job-boards.greenhouse.io/squarepointcapital/jobs/7654321?previousJob=1234567'),
    ('https://careers.example.com/jobs/1234567?utm_campaign=20261002',
     'https://careers.example.com/jobs/7654321?UTM_campaign=20261002'),
    ('https://job-boards.greenhouse.io/acme/jobs/1234567',
     'https://job-boards.greenhouse.io/acme/jobs/7654321?gh_src=1234567'),
    ('https://jobs.smartrecruiters.com/Acme/7440001413263',
     'https://jobs.smartrecruiters.com/AcmeLabs/7440001413263'),
    ('https://job-boards.greenhouse.io/acme/jobs/1234567',
     'https://boards.greenhouse.io/acme-labs/jobs/1234567'),
])
@pytest.mark.parametrize('action', ['resolve', 'remove', 'receipt'])
def test_hint_cannot_use_tracking_numbers_or_similar_ats_tenants(tmp_path, listed_url, page, action):
    store, sync = listed(tmp_path, listed_url)
    jid = job_id(store, listed_url)
    before = store.get_jobs([jid])[0]
    if action == 'resolve':
        assert sync.resolve({'url': page, 'website_job_id': jid})['state'] == 'unmatched'
    elif action == 'remove':
        assert sync.receive(DEVICE, manual_delete(page, jid))['state'] == 'unmatched'
        with store.connect() as c:
            assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0] == 0
    else:
        payload = dict(event_id=str(uuid.uuid4()), job_url=page, website_job_id=jid,
            job_title='Synthetic engineer', company='Synthetic employer',
            observed_at=datetime.now(timezone.utc).isoformat(), proof='ats_confirmation')
        result = sync.receive(DEVICE, payload)
        assert result['job_ids'] == [] and result['job_id'] != jid
        assert sync.receive(DEVICE, payload) == result
        with store.connect() as c:
            external = c.execute('SELECT record FROM applications WHERE job_id=?', (result['job_id'],)).fetchone()
            assert json.loads(external['record'])['jobLink'] == page
    assert store.get_jobs([jid])[0] == before


def test_scalar_query_identifier_still_corroborates_generic_application_step(tmp_path):
    url = 'https://careers.example.com/jobs?jobId=1234567'
    store, sync = listed(tmp_path, url)
    jid = job_id(store, url)
    page = 'https://careers.example.com/apply?jobId=1234567&returnUrl=%2Fjobs%2F7654321'
    result = sync.resolve({'url': page, 'website_job_id': jid})
    assert result['state'] == 'matched' and result['matched_by'] == 'hint'
