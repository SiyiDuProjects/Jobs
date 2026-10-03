"""Public Snap CXS evidence, rechecked 2026-10-02; synthetic local stores only."""
import json
import uuid

import pytest

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.identity import stable_id
from jobs_radar.job_duplicates import consolidate
from jobs_radar.job_match import job_key
from jobs_radar.store import Store
from test_application_model_v2 import receipt, record
from test_job_resolve import manual_delete
from test_store import observation


HOST = 'https://snapchat.wd1.myworkdayjobs.com'
PATH = '/job/Los-Angeles-California/Software-Engineer--C----Level-3_'
SOURCED = HOST + '/en-US/sourced' + PATH + 'R0046951'
SNAP = HOST + '/en-US/snap' + PATH + 'R0046951-1'


def paired(store):
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    return sync, device


def ingest(store, url):
    store.ingest('simplify:newgrad', [observation(url=url)], 'synthetic')


def legacy_pair(store):
    """Two pre-fix URL identities, without calling a migration or merging rows."""
    ingest(store, SOURCED)
    first, second = stable_id(job_key(SOURCED)), stable_id(job_key(SNAP))
    with store.connect(True) as c:
        c.execute('INSERT INTO jobs SELECT ?,?,first_seen,last_seen,? FROM jobs WHERE id=?',
                  (second, job_key(SNAP), job_key(SNAP), first))
        c.execute("INSERT INTO applications(job_id,status,updated,job_key) VALUES(?,'not_started',0,?)", (second, job_key(SNAP)))
        row = observation('speedyapply', url=SNAP)
        c.execute("INSERT INTO observations VALUES('speedyapply:SWE:newgrad','legacy',?,?,0,0,1)", (second, json.dumps(row)))
        c.execute("INSERT INTO search_index SELECT 'speedyapply:SWE:newgrad','legacy',?,'speedyapply',kind,category,title_company,locations,h1b,active,visible,posted_at FROM search_index LIMIT 1", (second,))
    return first, second


@pytest.mark.parametrize('first_url', [SOURCED, SNAP])
def test_verified_entries_keep_one_identity_across_alternating_ingestion(tmp_path, first_url):
    store = Store(tmp_path / 'snap.sqlite')
    ingest(store, first_url)
    jid = store.search()['jobs'][0]['id']
    sync, _ = paired(store)
    for url in (SNAP, SOURCED, SNAP, SOURCED):
        ingest(store, url)
        assert [r['id'] for r in store.search()['jobs']] == [jid]
        for page in (SOURCED, SNAP, SNAP + '/apply/applyManually'):
            assert sync.resolve({'url': page})['job_id'] == jid
        with store.connect() as c:
            assert c.execute('SELECT job_key FROM jobs WHERE id=?', (jid,)).fetchone()[0] == job_key(SOURCED)
            assert c.execute('SELECT job_key FROM applications WHERE job_id=?', (jid,)).fetchone()[0] == job_key(SOURCED)


@pytest.mark.parametrize('other', [SNAP.replace('R0046951-1', 'R0046951-2'),
    SNAP.replace('snapchat.wd1', 'another.wd1'), SNAP.replace('R0046951-1', 'R0046952-1'),
    SOURCED.replace('R0046951', 'R0046952')])
def test_unverified_suffix_tenant_and_requisition_never_merge(tmp_path, other):
    store = Store(tmp_path / 'different.sqlite')
    ingest(store, SOURCED)
    store.ingest('speedyapply:SWE:newgrad', [observation('speedyapply', url=other)], 'different')
    assert len(store.search()['jobs']) == 2


def test_receipts_and_removal_share_the_verified_identity(tmp_path):
    store = Store(tmp_path / 'receipt.sqlite')
    ingest(store, SOURCED)
    sync, device = paired(store)
    event = {**receipt('ats_confirmation'), 'job_url': SNAP}
    result = sync.receive(device, event)
    assert result['job_ids'] == [store.search()['jobs'][0]['id']]
    assert sync.receive(device, event) == result
    for url in (SOURCED, SNAP):
        assert not sync.resolve({'url': url})['queue']['allowed']
        assert sync.receive(device, manual_delete(url))['state'] == 'protected'
    assert len(ApplicationRecords(store).list()['applications']) == 1


@pytest.mark.parametrize('external_url,listed_url', [(SNAP, SOURCED), (SOURCED, SNAP)])
def test_external_record_attaches_without_losing_owner_metadata(tmp_path, external_url, listed_url):
    store = Store(tmp_path / 'external.sqlite')
    records = ApplicationRecords(store)
    records.mutate([dict(action='create', value={**record(external_url), 'jobTitle': 'Owner title'})], 'manual-record')
    before = records.list()['applications'][0]
    # Simulate an external record written before the evidence binding existed.
    with store.connect(True) as c:
        c.execute('UPDATE applications SET job_key=?', (job_key(external_url),))
    ingest(store, listed_url)
    after = records.list()['applications'][0]
    assert after['id'] == before['id'] and not after['job_id'].startswith('external:')
    assert after['jobTitle'] == 'Owner title' and after['version'] == before['version']
    sync, device = paired(store)
    sync.receive(device, {**receipt('ats_confirmation'), 'job_url': external_url})
    final = records.list()['applications']
    assert len(final) == 1 and final[0]['id'] == before['id'] and final[0]['jobTitle'] == 'Owner title'


def test_existing_duplicates_require_explicit_merge_and_old_urls_stay_resolvable(tmp_path):
    store = Store(tmp_path / 'legacy.sqlite')
    ids = legacy_pair(store)
    with store.connect(True) as c:
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        report = consolidate(c)
        assert report['mergeable'] == 1 and report['dry_run']
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0
        assert consolidate(c, False)['mergeable'] == 1
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == before
    sync, _ = paired(store)
    canonical = report['details'][0]['canonical_id']
    for url in (SOURCED, SNAP, SOURCED, SNAP):
        ingest(store, url)
        for old_url in (SOURCED, SNAP):
            resolved = sync.resolve({'url': old_url})
            assert resolved['job_id'] == canonical
            assert resolved['queue']['allowed']
        with store.connect() as c:
            assert c.execute('SELECT job_key FROM jobs WHERE id=?', (canonical,)).fetchone()[0] == job_key(SOURCED)
            assert c.execute('SELECT count(*) FROM jobs').fetchone()[0] == len(ids)


def test_independent_application_records_hold_explicit_consolidation(tmp_path):
    store = Store(tmp_path / 'conflict.sqlite')
    ids = legacy_pair(store)
    with store.connect(True) as c:
        for jid, url in zip(ids, (SOURCED, SNAP)):
            c.execute("UPDATE applications SET application_id=?,record=?,status='submitted',attempted_at=1 WHERE job_id=?",
                      (str(uuid.uuid4()), json.dumps(record(url)), jid))
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        report = consolidate(c, False)
        assert report['held'] == 1 and report['details'][0]['reason'] == 'application_identity_conflict'
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == before
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0


@pytest.mark.parametrize('fact', ['attempted_at', 'confirmed_at'])
def test_true_submission_facts_protect_both_entries_even_with_legacy_status(tmp_path, fact):
    store = Store(tmp_path / 'facts.sqlite')
    ids = legacy_pair(store)
    with store.connect(True) as c:
        c.execute(f'UPDATE applications SET {fact}=1 WHERE job_id=?', (ids[1],))
    sync, device = paired(store)
    for url in (SOURCED, SNAP):
        resolved = sync.resolve({'url': url})
        assert not resolved['queue']['allowed']
        assert resolved['application']['submitted']
        assert sync.receive(device, manual_delete(url))['state'] == 'protected'
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0] == 0


def test_existing_members_are_not_silently_consolidated_by_collection(tmp_path):
    store = Store(tmp_path / 'no-auto-merge.sqlite')
    ids = legacy_pair(store)
    ingest(store, SOURCED)
    store.ingest('speedyapply:SWE:newgrad', [{**observation('speedyapply', url=SNAP), 'source_id': 'legacy'}], 'refresh')
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM jobs').fetchone()[0] == 2
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0
        assert {r[0] for r in c.execute('SELECT job_id FROM observations')} == set(ids)


def test_explicit_source_merge_preserves_receipt_and_owner_record(tmp_path):
    store = Store(tmp_path / 'preserve.sqlite')
    ids = legacy_pair(store)
    sync, device = paired(store)
    event = {**receipt('ats_confirmation'), 'job_url': SNAP, 'website_job_id': ids[1]}
    original = sync.receive(device, event)
    records = ApplicationRecords(store)
    row = records.list()['applications'][0]
    records.mutate([dict(action='update', application_id=row['id'], expected_version=row['version'],
                        value={**row, 'jobTitle': 'Owner title'})], 'owner-title')
    with store.connect(True) as c:
        c.execute('UPDATE owner_submission_undo SET expires=0')
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        events = [dict(r) for r in c.execute('SELECT * FROM application_events ORDER BY event_key')]
        report = consolidate(c, False)
        assert report['mergeable'] == 1
        assert report['details'][0]['canonical_id'] == row['job_id']
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == before
        assert [dict(r) for r in c.execute('SELECT * FROM application_events ORDER BY event_key')] == events
    assert sync.receive(device, event) == original
    for url in (SOURCED, SNAP):
        ingest(store, url)
        assert not sync.resolve({'url': url})['queue']['allowed']
        assert sync.receive(device, manual_delete(url))['state'] == 'protected'
    assert records.list()['applications'][0]['jobTitle'] == 'Owner title'


def test_removal_and_restore_apply_to_the_other_official_entry(tmp_path):
    store = Store(tmp_path / 'remove.sqlite')
    ingest(store, SOURCED)
    sync, device = paired(store)
    event = manual_delete(SNAP)
    assert sync.receive(device, event)['state'] == 'removed'
    ingest(store, SNAP)
    assert store.search()['jobs'] == []
    assert sync.resolve({'url': SOURCED})['removal']['removed']
    undo = dict(event_id=str(uuid.uuid4()), proof='undo_unavailable', removal_event=event['event_id'])
    assert sync.receive(device, undo)['state'] == 'restored'
    assert len(store.search()['jobs']) == 1


def test_binding_is_public_official_evidence_and_does_not_change_raw_url_keys():
    from jobs_radar.verified_postings import SNAP_EVIDENCE
    from jobs_radar.job_match import posting_key
    assert job_key(SOURCED) != job_key(SNAP)
    assert posting_key(SOURCED) == posting_key(SNAP)
    assert [p['url'] for p in SNAP_EVIDENCE['postings']] == [SOURCED, SNAP]
    assert len({p['id'] for p in SNAP_EVIDENCE['postings']}) == 2
    assert SNAP_EVIDENCE['jobReqId'] == 'R0046951'
    assert SNAP_EVIDENCE['http_status'] is None and not SNAP_EVIDENCE['raw_response_saved']


@pytest.mark.parametrize('hint', [False, True])
def test_receipt_on_untouched_member_reuses_the_only_owner(tmp_path, hint):
    store = Store(tmp_path / 'one-owner.sqlite')
    ids = legacy_pair(store)
    records = ApplicationRecords(store)
    records.mutate([dict(action='create', value={**record(SNAP), 'jobTitle': 'Owner title'})], 'owner-record')
    # The existing record belonged to -1 before this binding was introduced.
    with store.connect(True) as c:
        owner = c.execute('SELECT * FROM applications WHERE record IS NOT NULL').fetchone()
        if owner['job_id'] != ids[1]:
            c.execute('DELETE FROM applications WHERE job_id=?', (ids[1],))
            c.execute('UPDATE applications SET job_id=?,job_key=? WHERE job_id=?', (ids[1], job_key(SNAP), ids[0]))
            c.execute("INSERT INTO applications(job_id,status,updated,job_key) VALUES(?,'not_started',0,?)", (ids[0], job_key(SOURCED)))
    before = records.list()['applications'][0]
    sync, device = paired(store)
    event = {**receipt('ats_confirmation'), 'job_url': SOURCED}
    if hint:event['website_job_id'] = ids[0]
    result = sync.receive(device, event)
    after = records.list()['applications']
    assert len(after) == 1 and result['application_id'] == before['id']
    assert after[0]['jobTitle'] == before['jobTitle'] and after[0]['version'] == before['version']
    assert sync.receive(device, event) == result
    for url in (SOURCED, SNAP):
        assert sync.resolve({'url': url})['application']['id'] == before['id']


def test_receipt_refuses_two_independent_owners_without_mutation(tmp_path):
    store = Store(tmp_path / 'two-owners.sqlite')
    ids = legacy_pair(store)
    with store.connect(True) as c:
        for jid, url in zip(ids, (SOURCED, SNAP)):
            c.execute('UPDATE applications SET application_id=?,record=? WHERE job_id=?',
                      (str(uuid.uuid4()), json.dumps(record(url)), jid))
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    sync, device = paired(store)
    with pytest.raises(ValueError, match='Multiple applications'):
        sync.receive(device, {**receipt('ats_confirmation'), 'job_url': SOURCED, 'website_job_id': ids[0]})
    with store.connect() as c:
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == before
        assert c.execute('SELECT count(*) FROM application_events').fetchone()[0] == 0


def test_old_single_alias_key_is_readable_before_refresh_and_never_drifts(tmp_path):
    store = Store(tmp_path / 'old-single.sqlite')
    ingest(store, SNAP)
    with store.connect(True) as c:
        c.execute('UPDATE jobs SET job_key=?', (job_key(SNAP),))
        c.execute('UPDATE applications SET job_key=?', (job_key(SNAP),))
        jid = c.execute('SELECT id FROM jobs').fetchone()[0]
    sync, _ = paired(store)
    for url in (SOURCED, SNAP):
        assert sync.resolve({'url': url})['job_id'] == jid
    for url in (SOURCED, SNAP, SOURCED):
        ingest(store, url)
        with store.connect() as c:
            assert [tuple(r) for r in c.execute('SELECT id,job_key FROM jobs')] == [(jid, job_key(SOURCED))]


def test_untrusted_source_claim_cannot_add_a_verified_alias(tmp_path):
    store = Store(tmp_path / 'source-claim.sqlite')
    ingest(store, SOURCED)
    unknown = SNAP.replace('R0046951-1', 'R0046951-2')
    row = {**observation('speedyapply', url=unknown), 'jobReqId': 'R0046951',
           'raw': {'jobPostingInfo': {'jobReqId': 'R0046951'}}}
    store.ingest('speedyapply:SWE:newgrad', [row], 'untrusted-claim')
    assert len(store.search()['jobs']) == 2


@pytest.mark.parametrize('protection', ['owner_reset', 'submission_undo', 'removal_undo'])
def test_verified_mapping_does_not_bypass_existing_consolidation_holds(tmp_path, protection):
    import time
    store = Store(tmp_path / 'holds.sqlite')
    first, second = legacy_pair(store)
    with store.connect(True) as c:
        if protection == 'owner_reset':
            c.execute("UPDATE applications SET status='submitted' WHERE job_id=?", (second,))
            c.execute('UPDATE applications SET version=2 WHERE job_id=?', (first,))
        elif protection == 'submission_undo':
            c.execute("INSERT INTO owner_submission_undo VALUES(?,1,?,'{}','[]')", (first, time.time()+86400))
        else:
            c.execute("INSERT INTO job_screening VALUES(?,'newgrad','trash','manual','test','[]','fp',?,?,1,0)", (second, time.time(), time.time()+86400))
        assert consolidate(c, False)['held'] == 1
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0


@pytest.mark.parametrize('merged', [False, True])
def test_resolve_exposes_only_reviewed_raw_identity_keys_without_widening_ids(tmp_path, merged):
    store = Store(tmp_path / 'contract.sqlite')
    ids = legacy_pair(store)
    if merged:
        with store.connect(True) as c:
            report = consolidate(c, False)
        expected_ids = [report['details'][0]['canonical_id']]
    else:
        expected_ids = sorted(ids)
    sync, _ = paired(store)
    with store.connect() as c:
        before = [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    for url in (SOURCED, SNAP, SNAP + '/apply/applyManually'):
        result = sync.resolve({'url': url})
        assert result['identity_job_keys'] == sorted([job_key(SOURCED), job_key(SNAP)])
        assert result['job_ids'] == expected_ids
        assert result['job_id'] in expected_ids
    with store.connect() as c:
        assert [dict(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')] == before


@pytest.mark.parametrize('url', [SNAP.replace('R0046951-1', 'R0046951-2'),
    SNAP.replace('snapchat.wd1', 'another.wd1'), SNAP.replace('R0046951-1', 'R0046952-1')])
def test_identity_key_contract_does_not_group_unverified_neighbours(tmp_path, url):
    store = Store(tmp_path / 'unverified-contract.sqlite')
    ingest(store, SOURCED)
    store.ingest('speedyapply:SWE:newgrad', [observation('speedyapply', url=url)], 'unrelated')
    sync, _ = paired(store)
    assert sync.resolve({'url': url})['identity_job_keys'] == [job_key(url)]
    assert job_key(url) not in sync.resolve({'url': SNAP})['identity_job_keys']


def test_identity_key_contract_does_not_trust_unreviewed_database_alias(tmp_path):
    store = Store(tmp_path / 'unreviewed-alias.sqlite')
    ingest(store, SOURCED)
    other = SNAP.replace('R0046951-1', 'R0046951-2')
    store.ingest('speedyapply:SWE:newgrad', [observation('speedyapply', url=other)], 'unrelated')
    with store.connect(True) as c:
        c.execute('INSERT INTO job_aliases VALUES(?,?,0)', (stable_id(job_key(other)), stable_id(job_key(SOURCED))))
    sync, _ = paired(store)
    assert sync.resolve({'url': SOURCED})['identity_job_keys'] == sorted([job_key(SOURCED), job_key(SNAP)])
    assert 'identity_job_keys' not in sync.resolve({'url': other})


@pytest.mark.parametrize('keys', [[str(i) for i in range(65)], ['x' * 4097], []])
def test_identity_key_contract_refuses_oversized_groups_instead_of_truncating(tmp_path, monkeypatch, keys):
    import jobs_radar.verified_postings as verified
    store = Store(tmp_path / 'oversized-contract.sqlite')
    ingest(store, SOURCED)
    sync, _ = paired(store)
    monkeypatch.setattr(verified, 'equivalent_keys', lambda key: keys)
    with pytest.raises(ValueError, match='identity key'):
        sync.resolve({'url': SOURCED})


def test_identity_keys_are_deduplicated_and_never_expand_from_a_hint(tmp_path, monkeypatch):
    import jobs_radar.verified_postings as verified
    store = Store(tmp_path / 'deduplicated-contract.sqlite')
    ingest(store, SOURCED)
    sync, _ = paired(store)
    original = verified.equivalent_keys
    monkeypatch.setattr(verified, 'equivalent_keys', lambda key: original(key) * 2)
    assert sync.resolve({'url': SNAP})['identity_job_keys'] == sorted([job_key(SOURCED), job_key(SNAP)])
    # Existing generic-page hint support is not official evidence for a new
    # persisted raw-key equivalence; retain the old contract without this field.
    url = 'https://careers.example.com/jobs/1234567'
    page = 'https://careers.example.com/careers-home/jobs/1234567'
    ingest(store, url)
    result = sync.resolve({'url': page, 'website_job_id': stable_id(job_key(url))})
    assert result['matched_by'] == 'hint'
    assert 'identity_job_keys' not in result
