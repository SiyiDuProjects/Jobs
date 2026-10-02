"""Synthetic regression for duplicate legacy job keys without declared aliases.

No real application data is used. The expected behavior protects the one owner
record and its timeline while making the other row's confirmed outcome visible.
Merely forcing add_manual to create a second record, or skipping the confirmed
row, does not satisfy these assertions.
"""
import hashlib
import json
import sqlite3
import time
from pathlib import Path

import pytest

from jobs_radar.application_progress import ApplicationProgress
from jobs_radar.application_records import ApplicationRecords, seed_progress
from jobs_radar.application_schema import migrate_path
from jobs_radar.extension_sync import ExtensionSync
from jobs_radar.identity import stable_id
from jobs_radar.job_match import job_key
from jobs_radar.store import Store
from test_store import observation


OFFICIAL_JOB = stable_id('synthetic-legacy-confirmed-source')
INVENTORY_JOB = stable_id('synthetic-legacy-owner-inventory')
APPLICATION_ID = 'synthetic-existing-owner-application'
POSTING = 'https://jobs.lever.co/synthetic/11111111-2222-4333-8444-555555555555'
OFFICIAL_URL = POSTING + '?utm_source=collector'
INVENTORY_URL = POSTING + '?utm_source=owner'
CONFIRMED_AT = 1785542400.0
INVENTORY_UPDATED = CONFIRMED_AT + 86400
OFFICIAL_EVIDENCE = {'type': 'official_success', 'reference': OFFICIAL_URL,
                     'summary': 'Synthetic official acceptance screen'}


@pytest.fixture(params=['submitted', 'needs_input', 'submitted_unconfirmed'])
def duplicate_legacy_records(tmp_path, request):
    path = tmp_path / 'synthetic-legacy.sqlite'
    owner_record = {
        'id': APPLICATION_ID, 'jobTitle': 'Owner edited synthetic title',
        'jobLink': INVENTORY_URL, 'companyName': 'Synthetic Company',
        'companyLink': 'https://synthetic.example/careers',
        'date': '2026-07-10T01:02:03+00:00', 'status': 'applied', 'profileName': 'Newgrad',
    }
    progress = seed_progress(APPLICATION_ID, 'interview', 'owner')
    progress.update(version=5, round=2, observed_at=INVENTORY_UPDATED + 20,
                    updated_at=INVENTORY_UPDATED + 21, manual_updated_at=INVENTORY_UPDATED + 21,
                    reference='synthetic-owner-note', summary='Synthetic second interview')
    events = []
    for round_number in (1, 2):
        event = {
            'application_id': APPLICATION_ID, 'from': 'applied' if round_number == 1 else 'interview',
            'to': 'interview', 'round': round_number, 'previous_round': round_number - 1 or None,
            'final': False, 'observed_at': INVENTORY_UPDATED + round_number * 10,
            'recorded_at': INVENTORY_UPDATED + round_number * 10 + 1,
            'source': 'owner', 'reference': f'synthetic-round-{round_number}',
            'summary': f'Synthetic interview round {round_number}',
            'action': 'set', 'applied': True, 'reason': 'applied',
        }
        events.append(event)
    with sqlite3.connect(path) as c:
        c.executescript((Path(__file__).parent / 'fixtures' / 'legacy-release-schema.sql').read_text())
        for jid, identity, status, updated, evidence, title, url in [
            (OFFICIAL_JOB, 'synthetic:legacy:official', 'submitted', CONFIRMED_AT,
             [OFFICIAL_EVIDENCE], 'Collector replacement synthetic title', OFFICIAL_URL),
            (INVENTORY_JOB, 'synthetic:legacy:inventory', request.param, INVENTORY_UPDATED,
             [], owner_record['jobTitle'], INVENTORY_URL),
        ]:
            c.execute('INSERT INTO jobs VALUES(?,?,?,?)', (jid, identity, updated - 100, updated))
            c.execute('INSERT INTO applications VALUES(?,?,7,?,?,?,?)',
                      (jid, status, updated, 'Synthetic legacy state', json.dumps(evidence), 'synthetic-run'))
            source = {**observation(url=url, company='Synthetic Company'), 'title': title,
                      'source_id': jid, 'posted_at': updated - 100}
            c.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,1)',
                      ('simplify:newgrad', jid, jid, json.dumps(source), updated - 100, updated))
        c.execute("INSERT INTO management_documents VALUES('appliedList',?,4)", (json.dumps([owner_record]),))
        c.execute('INSERT INTO application_progress VALUES(?,?)', (APPLICATION_ID, json.dumps(progress)))
        for index, event in enumerate(events):
            c.execute('INSERT INTO application_progress_events VALUES(?,?,?)',
                      (f'synthetic-progress-{index}', APPLICATION_ID, json.dumps(event)))
        # This invokes add_manual once before, and once after, confirmation
        # migration. The confirmed source still has no inventory record.
        c.execute('INSERT INTO recruiting_progress VALUES(?,?,?,?,?,?)',
                  (OFFICIAL_JOB, 'received', CONFIRMED_AT + 1, '0123456789abcdef',
                   'Synthetic receipt distinct from the owner timeline', 1))
        assert c.execute('SELECT count(*) FROM job_aliases').fetchone()[0] == 0
    assert job_key(OFFICIAL_URL) == job_key(INVENTORY_URL)
    return path, owner_record, progress, events


def migrated(legacy):
    path, *_ = legacy
    report = migrate_path(path, dry_run=False)
    store = Store(path)
    visible = ApplicationRecords(store).list()['applications']
    assert len(visible) == 1, 'A duplicate job key must not create a second visible application'
    assert visible[0]['id'] == APPLICATION_ID, 'Keep the existing owner application identity'
    return store, visible[0], report


def test_duplicate_confirmed_source_does_not_replace_owner_metadata(duplicate_legacy_records):
    _, expected, _, _ = duplicate_legacy_records
    store, visible, _ = migrated(duplicate_legacy_records)
    with store.connect() as c:
        row = c.execute('SELECT record,record_version FROM applications WHERE application_id=?',
                        (APPLICATION_ID,)).fetchone()
        actual = json.loads(row['record'])
    expected_fields = {name: value for name, value in expected.items() if name != 'id'}
    assert (actual, row['record_version']) == (expected_fields, 1), (
        'Source-derived fallback metadata must not overwrite owner metadata or repeatedly advance its record version')
    assert visible['date'] == expected['date'] and visible['jobLink'] == expected['jobLink']


def test_duplicate_confirmation_is_visible_on_the_owner_application(duplicate_legacy_records):
    store, visible, _ = migrated(duplicate_legacy_records)
    assert visible['submission']['confirmed'] is True, 'Do not leave official confirmation on an invisible sibling row'
    assert visible['submission']['status'] == 'submitted'
    assert visible['submission']['confirmed_at'] == CONFIRMED_AT
    with store.connect() as c:
        row = c.execute('SELECT evidence FROM applications WHERE application_id=?', (APPLICATION_ID,)).fetchone()
        assert OFFICIAL_EVIDENCE in json.loads(row['evidence']), 'Keep the original official confirmation provenance'
    sync = ExtensionSync(store)
    for url in (OFFICIAL_URL, INVENTORY_URL):
        assert sync.resolve({'url': url})['queue']['allowed'] is False, 'A confirmed posting must remain protected from retry'


def test_duplicate_receipt_keeps_existing_owner_timeline(duplicate_legacy_records):
    _, _, expected_progress, expected_events = duplicate_legacy_records
    store, visible, _ = migrated(duplicate_legacy_records)
    with store.connect() as c:
        progress = json.loads(c.execute('SELECT progress FROM applications WHERE application_id=?',
                                        (APPLICATION_ID,)).fetchone()[0])
        events = [json.loads(row[0]) for row in c.execute(
            "SELECT payload FROM application_events WHERE application_id=? AND kind='progress' ORDER BY rowid",
            (APPLICATION_ID,))]
    assert progress == expected_progress
    assert events == expected_events
    assert visible['progress']['stage'] == 'interview' and visible['progress']['round'] == 2
    detail = ApplicationProgress(store).list(application_id=APPLICATION_ID)['applications']
    assert len(detail) == 1
    assert [(event['to'], event['round']) for event in detail[0]['history']] == [('interview', 1), ('interview', 2)]


def test_duplicate_rehearsal_does_not_change_input_and_reapply_is_stable(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    dry = migrate_path(path, dry_run=True)
    assert dry['dry_run'] and hashlib.sha256(path.read_bytes()).hexdigest() == original
    store, _, _ = migrated(duplicate_legacy_records)
    with store.connect() as c:
        before = list(c.iterdump())
    assert migrate_path(path, dry_run=False)['already_applied'] is True
    with store.connect() as c:
        assert list(c.iterdump()) == before


def original_rows(path):
    with sqlite3.connect(path) as c:
        c.row_factory = sqlite3.Row
        return {r['job_id']: dict(r) for r in c.execute('SELECT * FROM applications')}


def test_exact_legacy_rows_and_explicit_alias_map_are_retained(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    before = original_rows(path)
    store, _, report = migrated(duplicate_legacy_records)
    merge = report['duplicate_records'][0]
    assert {k: merge[k] for k in ('source_job_ids', 'owner_job_id', 'canonical_job_id', 'application_id')} == {
        'source_job_ids': [OFFICIAL_JOB], 'owner_job_id': INVENTORY_JOB,
        'canonical_job_id': INVENTORY_JOB, 'application_id': APPLICATION_ID}
    with store.connect() as c:
        archived = [json.loads(r[0])['row'] for r in c.execute(
            "SELECT payload FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_applications_before'")]
        assert {r['job_id']: r for r in archived} == before
        assert c.execute('SELECT canonical_id FROM job_aliases WHERE alias_id=?', (OFFICIAL_JOB,)).fetchone()[0] == INVENTORY_JOB
        assert c.execute('SELECT count(*) FROM applications WHERE job_key=?', (job_key(POSTING),)).fetchone()[0] == 1
        assert c.execute('SELECT count(DISTINCT job_id) FROM observations').fetchone()[0] == 1
        assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='_migration_application_origins'").fetchone()
        event = json.loads(c.execute("SELECT payload FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0])
        assert event == merge


def historical_owner(legacy, generated=False):
    path, *_ = legacy
    historical_id = 'historical:' + hashlib.sha256(POSTING.encode()).hexdigest()[:24]
    with sqlite3.connect(path) as c:
        c.execute('DELETE FROM observations WHERE job_id=?', (INVENTORY_JOB,))
        c.execute('DELETE FROM jobs WHERE id=?', (INVENTORY_JOB,))
        if generated:
            c.execute('DELETE FROM applications WHERE job_id=?', (INVENTORY_JOB,))
            c.execute('INSERT INTO historical VALUES(?,?,?)', (POSTING, 'submitted_unconfirmed', 'Synthetic history'))
        else:
            c.execute('UPDATE applications SET job_id=? WHERE job_id=?', (historical_id, INVENTORY_JOB))
            # Real legacy historical rows may already carry a persisted key.
            c.execute('ALTER TABLE applications ADD COLUMN job_key TEXT')
            c.execute('UPDATE applications SET job_key=? WHERE job_id=?', (job_key(POSTING), historical_id))
    return historical_id


@pytest.mark.parametrize('generated', [False, True])
def test_historical_inventory_owner_moves_to_real_job_without_dangling_alias(duplicate_legacy_records, generated):
    old_id = historical_owner(duplicate_legacy_records, generated)
    store, row, report = migrated(duplicate_legacy_records)
    assert row['job_id'] == OFFICIAL_JOB
    assert row['submission']['confirmed_at'] == CONFIRMED_AT
    merge = report['duplicate_records'][0]
    assert merge['owner_job_id'] == old_id and merge['canonical_job_id'] == OFFICIAL_JOB
    assert merge['generated_job_ids'] == ([old_id] if generated else [])
    assert report['mappings'][0]['job_id'] == OFFICIAL_JOB
    with store.connect() as c:
        assert not c.execute('SELECT 1 FROM job_aliases a LEFT JOIN jobs j ON j.id=a.canonical_id WHERE j.id IS NULL').fetchone()
        assert not c.execute('SELECT 1 FROM applications WHERE job_id=?', (old_id,)).fetchone()
        assert json.loads(c.execute('SELECT progress FROM applications').fetchone()[0]) == duplicate_legacy_records[2]


@pytest.mark.parametrize('case', ['undo', 'undo_history', 'reset', 'unknown_reference', 'other_proof',
                                 'extra_unconfirmed', 'multiple_inventory', 'ambiguous_owner', 'review_conflict',
                                 'mail_progress_conflict', 'mail_metadata_conflict', 'multiple_aids',
                                 'zero_confirmed_at', 'zero_attempted_at', 'pending', 'existing_alias'])
def test_unsafe_merge_rolls_back_whole_migration(duplicate_legacy_records, case):
    path, owner, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        if case == 'undo':
            c.execute('INSERT INTO owner_submission_undo VALUES(?,7,?,?,?)', (INVENTORY_JOB, time.time() + 100, '{}', '[]'))
        elif case == 'undo_history':
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'owner_submission_undo','owner',1,'{}')", (INVENTORY_JOB,))
        elif case == 'reset':
            c.execute("UPDATE applications SET status='not_started',version=8 WHERE job_id=?", (INVENTORY_JOB,))
        elif case == 'unknown_reference':
            c.execute('CREATE TABLE unreviewed_owner_log(job_id TEXT,payload TEXT)')
            c.execute("INSERT INTO unreviewed_owner_log VALUES(?,'{}')", (OFFICIAL_JOB,))
        elif case == 'other_proof':
            c.execute('UPDATE applications SET evidence=? WHERE job_id=?',
                      (json.dumps([{**OFFICIAL_EVIDENCE, 'reference': POSTING.replace('11111111', '99999999')}]), OFFICIAL_JOB))
        elif case == 'extra_unconfirmed':
            extra = stable_id('synthetic-unconfirmed-sibling')
            c.execute("INSERT INTO jobs VALUES(?,'synthetic:extra',1,2)", (extra,))
            c.execute("INSERT INTO applications VALUES(?,'submitted_unconfirmed',1,2,'','[]',NULL)", (extra,))
            c.execute('INSERT INTO observations SELECT stream,?, ?,payload,first_seen,last_seen,present FROM observations WHERE job_id=?', (extra, extra, OFFICIAL_JOB))
        elif case == 'multiple_inventory':
            c.execute("UPDATE management_documents SET value=? WHERE key='appliedList'", (json.dumps([owner, {**owner, 'id': 'second-identity'}]),))
        elif case == 'ambiguous_owner':
            c.execute('UPDATE applications SET updated=?', (CONFIRMED_AT,))
        elif case == 'review_conflict':
            for jid, state in [(OFFICIAL_JOB, 'trash'), (INVENTORY_JOB, 'keep')]:
                c.execute("INSERT INTO job_screening VALUES(?,'newgrad',?,'synthetic','','[]','synthetic',1,NULL,1,0)", (jid, state))
        elif case == 'mail_progress_conflict':
            c.execute("UPDATE recruiting_progress SET stage='rejected'")
        elif case == 'mail_metadata_conflict':
            c.execute('INSERT INTO recruiting_progress SELECT ?,stage,received_at,message_id,?,version FROM recruiting_progress',
                      (INVENTORY_JOB, 'Different synthetic receipt summary'))
        elif case == 'multiple_aids':
            from jobs_radar.application_schema import create
            create(c)
            c.execute('UPDATE applications SET application_id=? WHERE job_id=?', (APPLICATION_ID, INVENTORY_JOB))
            c.execute('UPDATE applications SET application_id=? WHERE job_id=?', ('independent-source-application', OFFICIAL_JOB))
        elif case in {'zero_confirmed_at', 'zero_attempted_at'}:
            from jobs_radar.application_schema import create
            create(c)
            field = case.removeprefix('zero_')
            c.execute(f'UPDATE applications SET {field}=0 WHERE job_id=?', (OFFICIAL_JOB,))
        elif case == 'pending':
            c.execute("INSERT INTO application_progress_pending VALUES(?,'{}')", (OFFICIAL_JOB,))
        elif case == 'existing_alias':
            c.execute('INSERT INTO job_aliases VALUES(?,?,1)', (OFFICIAL_JOB, INVENTORY_JOB))
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='requires review'):
        migrate_path(path, dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_reference_payloads_stay_exact_while_event_envelopes_follow_canonical(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'owner_note','owner',123,?)", (OFFICIAL_JOB, '{"job_id":"original-synthetic-reference"}'))
        c.execute("INSERT INTO recruiting_events VALUES('synthetic@example.invalid','synthetic-mail',?,'received',?,?,?,123,1,?)",
                  (OFFICIAL_JOB, CONFIRMED_AT, 'Synthetic', 'exact-key', '{"job_id":"original"}'))
        c.execute('INSERT INTO extension_receipts VALUES(?,?,?,?,?,?,?,?,?)',
                  ('synthetic-receipt', 'synthetic-device', 'original-checksum', '{"job_id":"original"}', 100, 101, 'applied', OFFICIAL_JOB, '{"original":true}'))
        c.execute("INSERT INTO job_screening VALUES(?,'newgrad','keep','synthetic','','[]','original-fingerprint',123,NULL,8,1)", (OFFICIAL_JOB,))
        c.row_factory = sqlite3.Row
        originals = {table: [dict(row) for row in c.execute('SELECT * FROM ' + table)]
                     for table in ('audit', 'recruiting_events', 'extension_receipts', 'job_screening')}
    store, _, _ = migrated(duplicate_legacy_records)
    with store.connect() as c:
        assert [dict(r) for r in c.execute('SELECT * FROM audit')] == originals['audit']
        review = dict(c.execute('SELECT * FROM job_screening').fetchone())
        assert review == {**originals['job_screening'][0], 'job_id': INVENTORY_JOB}
        mail = c.execute("SELECT * FROM application_events WHERE kind='mail'").fetchone()
        assert mail['job_id'] == INVENTORY_JOB and json.loads(mail['payload']) == originals['recruiting_events'][0]
        receipt = c.execute("SELECT * FROM application_events WHERE kind='extension'").fetchone()
        old = originals['extension_receipts'][0]
        assert receipt['job_id'] == INVENTORY_JOB
        assert all(receipt[k] == old[k] for k in ('payload', 'checksum', 'updated', 'state', 'result'))


@pytest.mark.parametrize('missing_key', [False, True])
def test_manual_fallback_never_overwrites_another_existing_record(duplicate_legacy_records, missing_key):
    from jobs_radar.application_records import add_manual
    path, *_ = duplicate_legacy_records
    store, _, _ = migrated(duplicate_legacy_records)
    with store.connect(True) as c:
        original = dict(c.execute('SELECT * FROM applications').fetchone())
        c.execute("INSERT INTO applications(job_id,status,updated,job_key) VALUES(?,'submitted',1,?)", ('synthetic-fallback', None if missing_key else job_key(POSTING)))
        c.execute('INSERT INTO observations SELECT stream,?, ?,payload,first_seen,last_seen,present FROM observations LIMIT 1', ('synthetic-fallback', 'synthetic-fallback'))
        returned = add_manual(c, 'synthetic-fallback')
        assert returned['id'] == APPLICATION_ID
        assert dict(c.execute('SELECT * FROM applications WHERE application_id=?', (APPLICATION_ID,)).fetchone()) == original


def test_after_owner_undo_no_hidden_confirmation_blocks_the_queue(duplicate_legacy_records):
    from jobs_radar.board import Board
    store, _, _ = migrated(duplicate_legacy_records)
    # A valid persisted owner-undo snapshot exercises the supported contract.
    # Existing snapshots during migration are separately required to stop it.
    with store.connect(True) as c:
        app = dict(c.execute('SELECT * FROM applications').fetchone())
        before = {**app, 'status': 'not_started', 'detail': '', 'evidence': '[]',
                  'attempted_at': None, 'confirmed_at': None, 'record': None, 'progress': None}
        c.execute('INSERT INTO owner_submission_undo VALUES(?,?,?,?,?)',
                  (INVENTORY_JOB, app['version'], time.time() + 60, json.dumps(before), '[]'))
    Board(store).undo_submitted(INVENTORY_JOB, app['version'], 'synthetic-undo-after-merge')
    sync = ExtensionSync(store)
    for url in (OFFICIAL_URL, INVENTORY_URL):
        state = sync.resolve({'url': url, 'website_job_id': OFFICIAL_JOB})
        assert state['job_id'] == INVENTORY_JOB
        assert state['queue']['allowed'] is True
        assert state['application']['confirmed'] is False


def test_preexisting_authoritative_metadata_and_versions_remain_exact(duplicate_legacy_records):
    from jobs_radar.application_schema import create
    path, owner, progress, _ = duplicate_legacy_records
    authoritative = {k: v for k, v in owner.items() if k != 'id'}
    authoritative['jobTitle'] = 'Already authoritative owner edit'
    with sqlite3.connect(path) as c:
        create(c)
        c.execute('UPDATE applications SET application_id=?,record=?,record_version=12,progress=?,version=17 WHERE job_id=?',
                  (APPLICATION_ID, json.dumps(authoritative), json.dumps(progress), INVENTORY_JOB))
        c.execute('UPDATE applications SET confirmed_at=?,attempted_at=? WHERE job_id=?', (CONFIRMED_AT - 10, CONFIRMED_AT - 20, OFFICIAL_JOB))
    store, row, _ = migrated(duplicate_legacy_records)
    with store.connect() as c:
        app = c.execute('SELECT * FROM applications').fetchone()
        assert json.loads(app['record']) == authoritative
        assert app['record_version'] == 12 and app['version'] == 17
        assert json.loads(app['progress']) == progress
        assert app['confirmed_at'] == CONFIRMED_AT - 10 and app['attempted_at'] == CONFIRMED_AT - 20
    assert row['jobTitle'] == authoritative['jobTitle']


def test_proof_without_url_uses_unique_source_posting_not_a_guessed_url(duplicate_legacy_records):
    path, *_ = duplicate_legacy_records
    with sqlite3.connect(path) as c:
        c.execute('UPDATE applications SET evidence=? WHERE job_id=?',
                  (json.dumps([{**OFFICIAL_EVIDENCE, 'reference': 'Synthetic ATS success page'}]), OFFICIAL_JOB))
    _, row, _ = migrated(duplicate_legacy_records)
    assert row['submission']['confirmed_at'] == CONFIRMED_AT


def test_existing_email_receipt_locator_preserves_owner_and_exact_originals(duplicate_legacy_records):
    from jobs_radar.recruiting import email_url
    path, owner, progress, events = duplicate_legacy_records
    receipt = {'type': 'matching_receipt',
               'reference': email_url('abcdef1234567890', 'synthetic@example.invalid'),
               'observed_at': '2026-08-01T00:00:00Z', 'reported_by': 'email-sync'}
    with sqlite3.connect(path) as c:
        c.execute('UPDATE applications SET evidence=? WHERE job_id=?',
                  (json.dumps([receipt]), OFFICIAL_JOB))
    before = original_rows(path)
    store, visible, report = migrated(duplicate_legacy_records)
    assert report['duplicate_records'][0]['source_job_ids'] == [OFFICIAL_JOB]
    assert visible['submission']['confirmed_at'] == CONFIRMED_AT
    with store.connect() as c:
        app = c.execute('SELECT * FROM applications').fetchone()
        assert json.loads(app['record']) == {k: v for k, v in owner.items() if k != 'id'}
        assert app['record_version'] == 1 and app['version'] == before[INVENTORY_JOB]['version']
        assert json.loads(app['progress']) == progress
        assert json.loads(app['evidence']) == [receipt]
        archived = [json.loads(row[0])['row'] for row in c.execute(
            "SELECT payload FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_applications_before'")]
        assert {row['job_id']: row for row in archived} == before
        assert [json.loads(row[0]) for row in c.execute(
            "SELECT payload FROM application_events WHERE kind='progress' ORDER BY rowid")] == events


@pytest.mark.parametrize('field', ['job_url', 'nested_job_url', 'other_posting_reference'])
def test_email_locator_cannot_hide_a_different_posting(duplicate_legacy_records, field):
    from jobs_radar.recruiting import email_url
    path, *_ = duplicate_legacy_records
    receipt = {'type': 'matching_receipt', 'reference': email_url('abcdef1234567890')}
    other = POSTING.replace('11111111', '99999999')
    if field == 'nested_job_url':
        receipt['details'] = {'job_url': other}
    elif field == 'other_posting_reference':
        receipt['reference'] = other
    else:
        receipt[field] = other
    with sqlite3.connect(path) as c:
        c.execute('UPDATE applications SET evidence=? WHERE job_id=?',
                  (json.dumps([receipt]), OFFICIAL_JOB))
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='confirmation refers to a different posting'):
        migrate_path(path, dry_run=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


@pytest.mark.parametrize('status', ['not_started', 'needs_input', 'submitted_unconfirmed'])
def test_email_locator_does_not_make_an_unconfirmed_source_confirmed(status):
    from jobs_radar.migration_duplicate_records import proof
    from jobs_radar.recruiting import email_url
    app = {'status': status, 'evidence': json.dumps([
        {'type': 'matching_receipt', 'reference': email_url('abcdef1234567890')}])}
    assert proof(app, job_key(POSTING)) is False


@pytest.mark.parametrize('case', ['wrong_type', 'job_url', 'nested_reference', 'lookalike_host',
                                 'userinfo', 'other_path', 'missing_message', 'unexpected_query', 'invalid_message',
                                 'raw_at', 'raw_plus', 'embedded_newline'])
def test_email_locator_exception_is_limited_to_known_receipt_field(case):
    from jobs_radar.migration_duplicate_records import proof
    from jobs_radar.recruiting import email_url
    locator = email_url('abcdef1234567890', 'synthetic@example.invalid')
    item = {'type': 'matching_receipt', 'reference': locator}
    if case == 'wrong_type':
        item['type'] = 'official_success'
    elif case == 'job_url':
        item['job_url'] = locator
    elif case == 'nested_reference':
        item['details'] = {'reference': locator}
    else:
        item['reference'] = {
            'lookalike_host': locator.replace('mail.google.com', 'mail.google.com.example.invalid'),
            'userinfo': locator.replace('mail.google.com', 'owner@mail.google.com'),
            'other_path': locator.replace('/mail/u/', '/other/'),
            'missing_message': locator.split('#')[0] + '#all/',
            'unexpected_query': locator.replace('?authuser=', '?unrecognized='),
            'invalid_message': locator.split('#')[0] + '#all/not-a-message-id',
            'raw_at': locator.replace('%40', '@'),
            'raw_plus': locator.replace('synthetic%40', 'synthetic+tag%40'),
            'embedded_newline': locator.replace('/mail/u/', '/mail/\nu/'),
        }[case]
    with pytest.raises(ValueError, match='confirmation refers to a different posting'):
        proof({'status': 'submitted', 'evidence': json.dumps([item])}, job_key(POSTING))
