import json
import uuid

import pytest

from jobs_radar.application_records import ApplicationRecords
from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
from jobs_radar.store import Store
from test_application_model_v2 import model, receipt
from test_job_duplicates import legacy_pair, URL
from test_store import observation


@pytest.mark.parametrize('proof', ['submit_validation_error', 'submit_attempt', 'tracker_record'])
@pytest.mark.parametrize('aliases', [False, True])
def test_late_receipts_preserve_confirmed_display_and_raw_evidence(tmp_path, proof, aliases):
    store = Store(tmp_path / 'receipts.sqlite')
    if aliases:
        ids = legacy_pair(store)
        url = URL
    else:
        store.ingest('simplify:newgrad', [observation()], 'test')
        ids = [store.search()['jobs'][0]['id']]
        url = observation()['apply_url']
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    sync.receive(device, {**receipt('ats_confirmation'), 'job_url': url})
    with store.connect() as c:
        confirmed = {r['job_id']: r['confirmed_at'] for r in c.execute('SELECT * FROM applications')}
    late = {**receipt(proof, detail='Synthetic late validation failure'), 'job_url': url,
            'observed_at': '2020-01-01T00:00:00Z'}
    result = sync.receive(device, late)
    assert sync.receive(device, late) == result
    with store.connect() as c:
        for jid in ids:
            app = c.execute('SELECT * FROM applications WHERE job_id=?', (jid,)).fetchone()
            assert app['status'] == 'submitted'
            assert app['confirmed_at'] == confirmed[jid]
            assert app['submission_error'] is None
            assert app['detail'] == '网站已确认'
            assert json.loads(app['evidence'])[-1]['event_id'] == late['event_id']
        event = c.execute('SELECT payload FROM application_events WHERE event_key=?', (late['event_id'],)).fetchone()
        assert json.loads(event['payload']) == late


@pytest.mark.parametrize('confirmed_primary', [False, True])
def test_mixed_legacy_aliases_keep_each_rows_confirmation(tmp_path, confirmed_primary):
    store = Store(tmp_path / 'mixed.sqlite')
    ids = legacy_pair(store)
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    sync.receive(device, {**receipt(), 'job_url': URL, 'website_job_id': ids[0]})
    confirmed_id = ids[0] if confirmed_primary else ids[1]
    # Reproduce a legacy pair with confirmation on only one retained row.
    with store.connect(True) as c:
        c.execute("UPDATE applications SET confirmed_at=attempted_at,detail='网站已确认' WHERE job_id=?", (confirmed_id,))
    sync.receive(device, {**receipt('submit_validation_error', detail='Synthetic rejection'),
                          'job_url': URL, 'website_job_id': ids[0]})
    with store.connect() as c:
        for row in c.execute('SELECT * FROM applications'):
            if row['job_id'] == confirmed_id:
                assert row['confirmed_at'] is not None
                assert row['submission_error'] is None
                assert row['detail'] == '网站已确认'
                assert row['status'] == 'submitted'
            else:
                assert row['confirmed_at'] is None
                assert row['submission_error'] == 'Synthetic rejection'
                assert row['status'] == 'submitted_unconfirmed'


def test_event_id_is_immutable_across_devices_and_content(model):
    store, sync, device = model
    other = str(uuid.uuid4())
    sync.pair(other, EXTENSION_ID)
    event = receipt()
    original = sync.receive(device, event)
    with store.connect() as c:
        before = [dict(r) for r in c.execute('SELECT * FROM applications')]
        count = c.execute('SELECT count(*) FROM application_events').fetchone()[0]
    for sender, payload in [(other, event), (device, {**event, 'company': 'Changed metadata'})]:
        with pytest.raises(ValueError, match='Receipt ID already used'):
            sync.receive(sender, payload)
    assert sync.receive(device, event) == original
    with store.connect() as c:
        assert [dict(r) for r in c.execute('SELECT * FROM applications')] == before
        assert c.execute('SELECT count(*) FROM application_events').fetchone()[0] == count


def test_external_receipts_keep_one_application_across_devices_and_ingestion(model):
    store, sync, device = model
    other = str(uuid.uuid4())
    sync.pair(other, EXTENSION_ID)
    url = 'https://jobs.lever.co/other/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    first = {**receipt(), 'job_url': url}
    original = sync.receive(device, first)
    second = sync.receive(other, {**receipt('ats_confirmation'), 'job_url': url + '/apply?utm_source=test'})
    assert second['application_id'] == original['application_id']
    store.ingest('speedyapply:newgrad:swe', [observation('speedyapply', url=url)], 'later')
    assert sync.receive(device, first) == original
    third = sync.receive(other, {**receipt('tracker_record'), 'job_url': url})
    assert third['application_id'] == original['application_id']
    assert not third['job_id'].startswith('external:')
    rows = ApplicationRecords(store).list()['applications']
    assert len(rows) == 1 and rows[0]['id'] == original['application_id']
    assert rows[0]['submission']['confirmed']
    with store.connect() as c:
        events = c.execute("SELECT application_id,job_id FROM application_events WHERE kind='extension'").fetchall()
        assert {(e['application_id'], e['job_id']) for e in events} == {(original['application_id'], third['job_id'])}


@pytest.mark.parametrize('proof', ['submit_validation_error', 'submit_attempt', 'tracker_record', 'ats_confirmation'])
@pytest.mark.parametrize('external', [False, True])
def test_stale_receipts_keep_confirmed_metadata_and_record_version(model, proof, external):
    store, sync, device = model
    url = ('https://jobs.lever.co/other/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
           if external else observation()['apply_url'])
    sync.receive(device, {**receipt('ats_confirmation', profile_name='Current profile'), 'job_url': url})
    records = ApplicationRecords(store)
    before = records.list()['applications'][0]
    late = {**receipt(proof, profile_name='Stale profile', detail='Synthetic error'),
            'job_url': url, 'job_title': 'Stale title', 'company': 'Stale company',
            'observed_at': '2020-01-01T00:00:00Z'}
    sync.receive(device, late)
    after = records.list()['applications'][0]
    for field in ('jobTitle', 'companyName', 'profileName', 'date', 'jobLink', 'version'):
        assert after[field] == before[field]
    with store.connect() as c:
        raw = c.execute('SELECT payload FROM application_events WHERE event_key=?', (late['event_id'],)).fetchone()[0]
        assert json.loads(raw) == late


def test_new_receipt_metadata_updates_until_owner_edits_it(model):
    store, sync, device = model
    first = {**receipt(), 'observed_at': '2020-01-01T00:00:00Z'}
    sync.receive(device, first)
    sync.receive(device, {**receipt('tracker_record', profile_name='Current profile'), 'job_title': 'Updated title'})
    records = ApplicationRecords(store)
    before = records.list()['applications'][0]
    assert before['jobTitle'] == 'Updated title' and before['profileName'] == 'Current profile'
    edited = {**before, 'jobTitle': 'Owner title', 'profileName': 'Owner profile'}
    records.mutate([dict(action='update', application_id=before['id'], expected_version=before['version'], value=edited)], 'owner-metadata')
    before = records.list()['applications'][0]
    sync.receive(device, {**receipt('ats_confirmation', profile_name='Page profile'), 'job_title': 'Page title'})
    after = records.list()['applications'][0]
    for field in ('jobTitle', 'companyName', 'profileName', 'date', 'jobLink', 'version'):
        assert after[field] == before[field]
    assert after['submission']['confirmed']
