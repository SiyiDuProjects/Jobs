"""Independent before/after accounting of synthetic duplicate migrations.

Fixtures create legacy sources; expected facts below are explicit, not read
from the migration report or another implementation of the auditor.
"""
import json
import shutil
import sqlite3

import pytest

from jobs_radar.application_schema import create, migrate_path
from test_migration_accounting import accounting
from test_migration_duplicate_records import (
    duplicate_legacy_records, historical_owner, APPLICATION_ID, OFFICIAL_JOB,
    INVENTORY_JOB, CONFIRMED_AT,
)


def pair(legacy):
    before = legacy[0]
    after = before.with_name('after.sqlite')
    shutil.copyfile(before, after)
    migrate_path(after, dry_run=False)
    return before, after


def test_duplicate_has_one_authoritative_row_and_explained_retirement(duplicate_legacy_records, monkeypatch):
    before, after = pair(duplicate_legacy_records)
    from jobs_radar import migration_duplicate_records
    def forbidden(*_, **__):
        raise AssertionError('The auditor must derive the merge from old sources independently')
    for name in ('merge_duplicate_records', 'proof', 'reference_rows', 'validate_inventory'):
        monkeypatch.setattr(migration_duplicate_records, name, forbidden)
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    assert result['summary']['applicationsBefore'] == 2
    assert result['summary']['applicationsAfter'] == 1
    assert result['summary']['recordsAfter'] == 1
    assert result['summary']['newRecordIds'] == 0
    assert result['summary']['confirmedDuplicateGroups'] == 1
    assert result['summary']['generatedDuplicatePlaceholders'] == 0
    assert result['removedApplicationDetails'] == [dict(job_id=OFFICIAL_JOB,
        canonical_job_id=INVENTORY_JOB, origin='confirmed_duplicate_merge')]
    assert original == (before.read_bytes(), after.read_bytes())


@pytest.mark.parametrize('generated', [False, True])
def test_historical_owner_is_checked_against_real_source_and_exact_origin(duplicate_legacy_records, generated):
    historical_id = historical_owner(duplicate_legacy_records, generated)
    before, after = pair(duplicate_legacy_records)
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    assert result['summary']['applicationsAfter'] == 1
    assert result['summary']['addedApplications'] == {}
    assert result['summary']['generatedDuplicatePlaceholders'] == int(generated)
    assert result['duplicateMerges'][0] == dict(source_job_ids=[OFFICIAL_JOB],
        owner_job_id=historical_id, canonical_job_id=OFFICIAL_JOB, application_id=APPLICATION_ID,
        generated_job_ids=[historical_id] if generated else [], origin='confirmed_duplicate_merge')


@pytest.mark.parametrize('inventory_present', [False, True])
def test_existing_owner_and_explicit_receipt_times_survive_accounting(duplicate_legacy_records, inventory_present):
    path, owner, progress, _ = duplicate_legacy_records
    record = {key: value for key, value in owner.items() if key != 'id'}
    record['jobTitle'] = 'Authoritative synthetic edit'
    with sqlite3.connect(path) as db:
        create(db)
        db.execute('UPDATE applications SET application_id=?,record=?,record_version=12,progress=?,version=17 WHERE job_id=?',
            (APPLICATION_ID, json.dumps(record), json.dumps(progress), INVENTORY_JOB))
        db.execute('UPDATE applications SET confirmed_at=?,attempted_at=? WHERE job_id=?',
            (CONFIRMED_AT - 10, CONFIRMED_AT - 20, OFFICIAL_JOB))
        if not inventory_present:
            db.execute("DELETE FROM management_documents WHERE key='appliedList'")
    before, after = pair(duplicate_legacy_records)
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']


@pytest.mark.parametrize(('sql', 'failure'), [
    ("DELETE FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_applications_before'", 'duplicate_archive'),
    ("DELETE FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='duplicate_observations_before'", 'duplicate_archive'),
    ("UPDATE application_events SET payload=json_set(payload,'$.row.detail','fabricated') WHERE json_extract(payload,'$.table')='duplicate_applications_before'", 'duplicate_archive'),
    ("UPDATE applications SET evidence='[]'", 'live_submission_content'),
    ("UPDATE applications SET confirmed_at=confirmed_at+1", 'live_submission_content'),
    ("UPDATE applications SET attempted_at=attempted_at+1", 'live_submission_content'),
    ("UPDATE applications SET record_version=record_version+1", 'live_record_content'),
    ("UPDATE applications SET version=version+1", 'live_submission_content'),
    ("UPDATE applications SET progress=json_set(progress,'$.round',3)", 'live_progress_content'),
    ("DELETE FROM application_events WHERE kind='progress'", 'live_event_content:progress'),
    ("DELETE FROM job_aliases", 'duplicate_aliases'),
    ("UPDATE job_aliases SET canonical_id=alias_id", 'duplicate_aliases'),
    ("UPDATE observations SET job_id='fabricated'", 'source_rows:observations'),
    ("DELETE FROM application_events WHERE kind='migration_duplicate_merge'", 'duplicate_event'),
    ("UPDATE application_events SET job_id='fabricated' WHERE kind='migration_duplicate_merge'", 'duplicate_event'),
    ("UPDATE application_events SET application_id='fabricated' WHERE kind='migration_duplicate_merge'", 'duplicate_event'),
    ("UPDATE application_events SET created=1 WHERE kind='migration_duplicate_merge'", 'duplicate_event'),
    ("UPDATE application_events SET payload=json_set(payload,'$.confirmed_at',1) WHERE kind='migration_duplicate_merge'", 'duplicate_event'),
    ("UPDATE schema_migrations SET report=json_set(report,'$.duplicate_records[0].confirmed_at',1)", 'duplicate_mapping'),
])
def test_duplicate_tampering_cannot_be_excused_by_an_archive(duplicate_legacy_records, sql, failure):
    before, after = pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute(sql)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert failure in result['summary']['failures']


def test_forged_report_and_event_agreement_does_not_prove_timestamp(duplicate_legacy_records):
    before, after = pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute("UPDATE schema_migrations SET report=json_set(report,'$.duplicate_records[0].confirmed_at',1)")
        db.execute("UPDATE application_events SET payload=json_set(payload,'$.confirmed_at',1) WHERE kind='migration_duplicate_merge'")
        db.execute('UPDATE applications SET confirmed_at=1')
    result = accounting().reconcile(before, after)
    assert {'duplicate_mapping', 'duplicate_event', 'live_submission_content'} <= set(result['summary']['failures'])


def test_generated_archive_cannot_claim_old_or_final_state(duplicate_legacy_records):
    historical_owner(duplicate_legacy_records, True)
    before, after = pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute("UPDATE application_events SET payload=json_set(payload,'$.row.confirmed_at',1) WHERE json_extract(payload,'$.table')='duplicate_applications_generated'")
    assert 'duplicate_archive' in accounting().reconcile(before, after)['summary']['failures']


@pytest.mark.parametrize('tamper', [None, 'live', 'archive', 'policy', 'unknown'])
def test_keyed_references_and_source_index_have_explicit_lossless_rules(duplicate_legacy_records, tamper):
    path = duplicate_legacy_records[0]
    with sqlite3.connect(path) as db:
        for jid in (OFFICIAL_JOB, INVENTORY_JOB):
            db.execute('INSERT INTO web_opened VALUES(?,?,?)', (jid, 'newgrad', 123))
            db.execute('INSERT INTO job_role_family VALUES(?,?,?,?,?,?)', (jid, 'newgrad', 'synthetic', 'hash', '{}', 123))
            db.execute('INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (jid, 'newgrad', 'keep', 'synthetic', 'retained detail', '[]', 'hash', 100, 200, 2, 1))
            db.execute('INSERT INTO search_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                ('simplify:newgrad', jid, jid, 'synthetic', 'newgrad', 'synthetic', 'synthetic', 'remote', 'unknown', 1, 1, 100))
        db.execute('INSERT INTO audit VALUES(?,?,?,?,?,?)', (1, OFFICIAL_JOB, 'submitted', 'synthetic', 123, '{"kept":true}'))
    before, after = pair(duplicate_legacy_records)
    assert accounting().reconcile(before, after)['summary']['verified']
    if tamper is None: return
    with sqlite3.connect(after) as db:
        if tamper == 'live': db.execute("UPDATE job_screening SET detail='lost'")
        if tamper == 'archive': db.execute("DELETE FROM application_events WHERE json_extract(payload,'$.table')='duplicate_search_index_before'")
        if tamper == 'policy':
            db.execute("UPDATE schema_migrations SET report=json_set(report,'$.duplicate_records[0].references',json('[]'))")
        if tamper == 'unknown':
            db.execute('CREATE TABLE unknown_state(job_id TEXT,payload TEXT)')
            db.execute('INSERT INTO unknown_state VALUES(?,?)', (OFFICIAL_JOB, '{}'))
    if tamper == 'unknown':
        with sqlite3.connect(before) as db:
            db.execute('CREATE TABLE unknown_state(job_id TEXT,payload TEXT)')
            db.execute('INSERT INTO unknown_state VALUES(?,?)', (OFFICIAL_JOB, '{}'))
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    failure = {'live': 'duplicate_references', 'archive': 'duplicate_archive',
        'policy': 'duplicate_mapping', 'unknown': 'duplicate_references'}[tamper]
    assert failure in result['summary']['failures']


MAIL_RECEIPT = 'https://mail.google.com/mail/u/#all/0123456789abcdef'
OTHER_POSTING = 'https://jobs.lever.co/synthetic/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


SCREENING_TABLES = ('screening_seen', 'screening_batch_items', 'screening_rechecks',
    'screening_batches', 'screening_checkpoint')


def retained_screening_pair(legacy, active=True):
    """Build the explicit unchanged-row specification independently of runtime.

    Different old fingerprints/versions belong to their original job IDs. They
    are neither merged nor used as new submission proof. Include an unrelated
    member so a group-only comparison cannot hide collateral queue changes.
    """
    before, after = pair(legacy)
    schema = '''
        CREATE TABLE screening_checkpoint(id INTEGER PRIMARY KEY, cutoff REAL, initialized INTEGER);
        CREATE TABLE screening_batches(id TEXT PRIMARY KEY,since REAL,cutoff REAL,status TEXT,completed REAL);
        CREATE TABLE screening_seen(job_id TEXT,kind TEXT,fingerprint TEXT,present INTEGER,PRIMARY KEY(job_id,kind));
        CREATE TABLE screening_batch_items(run_id TEXT,job_id TEXT,kind TEXT,PRIMARY KEY(run_id,job_id,kind));
        CREATE TABLE screening_rechecks(source_run TEXT,job_id TEXT,kind TEXT,review_version INTEGER,
            PRIMARY KEY(source_run,job_id,kind));
    '''
    for path in (before, after):
        with sqlite3.connect(path) as db:
            db.executescript(schema)
            db.execute('INSERT INTO screening_checkpoint VALUES(1,100,1)')
            db.execute("INSERT INTO screening_batches VALUES('synthetic-complete',50,100,'complete',110)")
            db.execute('INSERT INTO screening_batches VALUES(?,?,?,?,?)',
                ('synthetic-current', 100, 120, 'active' if active else 'complete', None if active else 130))
            for index, jid in enumerate((OFFICIAL_JOB, INVENTORY_JOB, 'synthetic-unrelated')):
                db.execute('INSERT INTO screening_seen VALUES(?,?,?,?)', (jid, 'newgrad', f'old-fingerprint-{index}', index % 2))
                db.execute('INSERT INTO screening_batch_items VALUES(?,?,?)', ('synthetic-current', jid, 'newgrad'))
                db.execute('INSERT INTO screening_rechecks VALUES(?,?,?,?)', ('synthetic-complete', jid, 'newgrad', index + 1))
    # New report/event must describe the same spec; the auditor must derive it
    # independently from before rather than trusting these mutually agreeing claims.
    with sqlite3.connect(after) as db:
        report = json.loads(db.execute('SELECT report FROM schema_migrations').fetchone()[0])
        additions = [dict(table=table, count=2, policy='retain_original_reference') for table in SCREENING_TABLES[:3]]
        report['duplicate_records'][0]['references'].extend(additions)
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
        event = json.loads(db.execute("SELECT payload FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0])
        event['references'].extend(additions)
        db.execute("UPDATE application_events SET payload=? WHERE kind='migration_duplicate_merge'", (json.dumps(event),))
    return before, after


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('active', [True, False])
def test_screening_operational_history_is_retained_without_reinterpreting_it(duplicate_legacy_records, active, monkeypatch):
    before, after = retained_screening_pair(duplicate_legacy_records, active)
    from jobs_radar import migration_duplicate_records
    def forbidden(*_, **__):
        raise AssertionError('Independent accounting must not execute the migration')
    monkeypatch.setattr(migration_duplicate_records, 'reference_rows', forbidden)
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    assert result['summary']['confirmedDuplicateGroups'] == 1
    assert original == (before.read_bytes(), after.read_bytes())


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('sql', [
    "DELETE FROM screening_seen WHERE present=1",
    "UPDATE screening_seen SET fingerprint='fabricated'",
    "UPDATE screening_batch_items SET run_id='fabricated'",
    "UPDATE screening_rechecks SET review_version=review_version+1",
    "UPDATE screening_rechecks SET job_id='redirected' WHERE job_id='synthetic-unrelated'",
    "UPDATE screening_batches SET completed=999 WHERE id='synthetic-complete'",
    "UPDATE screening_batches SET status='complete' WHERE id='synthetic-current'",
    "UPDATE screening_checkpoint SET cutoff=999",
])
def test_screening_history_and_unrelated_members_must_remain_exact(duplicate_legacy_records, sql):
    before, after = retained_screening_pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute(sql)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_screening_history' in result['summary']['failures']


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('table', ['owner_submission_undo', 'application_progress_pending', 'unknown_pending'])
def test_operational_retention_never_allows_real_pending_or_undo(duplicate_legacy_records, table):
    before, after = retained_screening_pair(duplicate_legacy_records)
    for path in (before, after):
        with sqlite3.connect(path) as db:
            if table == 'owner_submission_undo':
                db.execute('INSERT INTO owner_submission_undo VALUES(?,1,9999999999,?,?)', (OFFICIAL_JOB, '{}', '[]'))
            else:
                db.execute(f'CREATE TABLE IF NOT EXISTS {table}(job_id TEXT PRIMARY KEY,payload TEXT)')
                db.execute(f'INSERT INTO {table} VALUES(?,?)', (OFFICIAL_JOB, '{}'))
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert ('duplicate_undo_expiry' if table == 'owner_submission_undo' else 'duplicate_references') in result['summary']['failures']


def undo_reference_pair(legacy, offset=-1):
    before, after = pair(legacy)
    with sqlite3.connect(after) as db:
        report = json.loads(db.execute('SELECT report FROM schema_migrations').fetchone()[0])
        start = report['started_at']
        policy = dict(table='owner_submission_undo', count=1, policy='retain_expired_reference')
        report['duplicate_records'][0]['references'].append(policy)
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
        event = json.loads(db.execute("SELECT payload FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0])
        event['references'].append(policy)
        db.execute("UPDATE application_events SET payload=? WHERE kind='migration_duplicate_merge'", (json.dumps(event),))
    for path in (before, after):
        with sqlite3.connect(path) as db:
            db.execute('INSERT INTO owner_submission_undo VALUES(?,7,?,?,?)',
                (OFFICIAL_JOB, start + offset, '{"status":"not_started","detail":"synthetic original"}', '[{"version":2}]'))
            db.execute('INSERT INTO owner_submission_undo VALUES(?,3,?,?,?)',
                ('synthetic-unrelated', start + 1000, '{"status":"submitted"}', '[]'))
    return before, after


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('offset', [-1, 0])
def test_expired_guard_uses_fixed_migration_start_and_retains_every_snapshot(duplicate_legacy_records, offset):
    before, after = undo_reference_pair(duplicate_legacy_records, offset)
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    assert original == (before.read_bytes(), after.read_bytes())


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('case', ['late_expiry', 'zero_expiry', 'negative_expiry', 'null_expiry', 'infinite_expiry',
    'missing_start', 'boolean_start', 'infinite_start', 'late_start'])
def test_undo_expiry_cannot_be_reinterpreted_at_a_later_audit(duplicate_legacy_records, case, monkeypatch):
    before, after = undo_reference_pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        report = json.loads(db.execute('SELECT report FROM schema_migrations').fetchone()[0])
        start = report['started_at']
        if case.endswith('_start'):
            if case == 'missing_start': report.pop('started_at')
            else: report['started_at'] = {'boolean_start': True, 'infinite_start': float('inf'), 'late_start': start + 1000}[case]
            db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
    if case.endswith('_expiry'):
        expiry = {'late_expiry': start + 1, 'zero_expiry': 0, 'negative_expiry': -1,
            'null_expiry': None, 'infinite_expiry': float('inf')}[case]
        for path in (before, after):
            with sqlite3.connect(path) as db:
                db.execute('UPDATE owner_submission_undo SET expires=? WHERE job_id=?', (expiry, OFFICIAL_JOB))
    monkeypatch.setattr('time.time', lambda: start + 10000)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_undo_expiry' in result['summary']['failures']


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('sql', [
    'DELETE FROM owner_submission_undo',
    'UPDATE owner_submission_undo SET version=version+1',
    "UPDATE owner_submission_undo SET application='{}'",
    "UPDATE owner_submission_undo SET reviews='[]'",
    "UPDATE owner_submission_undo SET job_id='changed' WHERE job_id='synthetic-unrelated'",
    'UPDATE owner_submission_undo SET expires=1',
])
def test_undo_whole_table_cannot_be_rewritten_or_lost(duplicate_legacy_records, sql):
    before, after = undo_reference_pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute(sql)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_undo_content' in result['summary']['failures']


def opened_reference_pair(legacy, canonical_present=True):
    before, after = pair(legacy)
    original_rows = [dict(job_id=OFFICIAL_JOB, kind='newgrad', opened_at=999.0)]
    expected_rows = [dict(job_id=INVENTORY_JOB, kind='newgrad', opened_at=999)]
    if canonical_present:
        original_rows += [dict(job_id=INVENTORY_JOB, kind='newgrad', opened_at=123.0),
            dict(job_id=OFFICIAL_JOB, kind='internship', opened_at=456.0)]
        expected_rows = [dict(job_id=INVENTORY_JOB, kind='newgrad', opened_at=123),
            dict(job_id=INVENTORY_JOB, kind='internship', opened_at=456)]
    with sqlite3.connect(before) as db:
        db.executemany('INSERT INTO web_opened VALUES(:job_id,:kind,:opened_at)', original_rows)
    with sqlite3.connect(after) as db:
        db.executemany('INSERT INTO web_opened VALUES(:job_id,:kind,:opened_at)', expected_rows)
        raw, created = db.execute('SELECT report,created FROM schema_migrations').fetchone()
        report = json.loads(raw)
        policy = dict(table='web_opened', count=len(original_rows), policy='preserve_canonical_opened')
        report['duplicate_records'][0]['references'].append(policy)
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
        event = json.loads(db.execute("SELECT payload FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0])
        event['references'].append(policy)
        db.execute("UPDATE application_events SET payload=? WHERE kind='migration_duplicate_merge'", (json.dumps(event),))
        for index, row in enumerate(original_rows):
            db.execute("INSERT INTO application_events(event_key,job_id,kind,payload,created) VALUES(?,?,'migration_evidence',?,?)",
                (f'synthetic-opened-archive-{index}', row['job_id'],
                 json.dumps(dict(table='duplicate_web_opened_before', row=row)), created))
    return before, after


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('canonical_present', [True, False])
def test_opened_timestamp_uses_existing_canonical_or_the_single_source(duplicate_legacy_records, canonical_present):
    before, after = opened_reference_pair(duplicate_legacy_records, canonical_present)
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize(('sql', 'failure'), [
    ("UPDATE web_opened SET opened_at=999 WHERE kind='newgrad'", 'duplicate_references'),
    ("UPDATE web_opened SET job_id='synthetic-wrong-target'", 'duplicate_references'),
    ("DELETE FROM application_events WHERE json_extract(payload,'$.table')='duplicate_web_opened_before'", 'duplicate_archive'),
    ("UPDATE application_events SET payload=json_set(payload,'$.row.opened_at',1) WHERE json_extract(payload,'$.table')='duplicate_web_opened_before'", 'duplicate_archive'),
])
def test_opened_timestamp_cannot_replace_owner_time_or_lose_source_archive(duplicate_legacy_records, sql, failure):
    before, after = opened_reference_pair(duplicate_legacy_records)
    with sqlite3.connect(after) as db:
        db.execute(sql)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert failure in result['summary']['failures']


def explicit_screening_pair(legacy):
    """Synthetic trusted authorization and independently constructed projection."""
    before, after = pair(legacy)
    rule = dict(id='synthetic-owner-choice', authorization='synthetic-explicit-approval',
        owner_job_id=INVENTORY_JOB, canonical_job_id=INVENTORY_JOB, source_job_ids=[OFFICIAL_JOB],
        kind='newgrad', decision='keep', expected=[
            dict(job_id=INVENTORY_JOB, state='trash', version=2, manual_keep=0),
            dict(job_id=OFFICIAL_JOB, state='keep', version=1, manual_keep=0)])
    raw = json.dumps(dict(schema_version=1, screening=[rule])).encode()
    original = [{**row, 'kind': 'newgrad', 'reason': 'synthetic', 'detail': 'Synthetic prior decision',
        'evidence': '[{"source":"synthetic"}]', 'fingerprint': 'synthetic-' + row['job_id'],
        'reviewed_at': 100.0, 'expires_at': 200.0} for row in rule['expected']]
    with sqlite3.connect(before) as db:
        db.executemany('INSERT INTO job_screening VALUES(:job_id,:kind,:state,:reason,:detail,:evidence,:fingerprint,:reviewed_at,:expires_at,:version,:manual_keep)', original)
    with sqlite3.connect(after) as db:
        report_raw, created = db.execute('SELECT report,created FROM schema_migrations').fetchone()
        report = json.loads(report_raw)
        start = report['started_at']
        expected = {**original[0], 'state': 'keep', 'reason': 'manual',
            'detail': 'Owner explicitly kept this posting while reconciling duplicate history.',
            'evidence': '[]', 'reviewed_at': start, 'expires_at': None, 'version': 3, 'manual_keep': 1}
        db.execute('INSERT INTO job_screening VALUES(:job_id,:kind,:state,:reason,:detail,:evidence,:fingerprint,:reviewed_at,:expires_at,:version,:manual_keep)', expected)
        import hashlib
        decision = dict(resolution_id=rule['id'], authorization=rule['authorization'],
            manifest_sha256=hashlib.sha256(raw).hexdigest(), kind='newgrad', decision='keep',
            from_version=2, to_version=3, applied_at=start)
        policy = dict(table='job_screening', count=2, policy='owner_screening_resolution')
        report['duplicate_records'][0]['references'].append(policy)
        report['duplicate_records'][0]['screening_resolutions'] = [decision]
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
        event = json.loads(db.execute("SELECT payload FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0])
        event['references'].append(policy)
        event['screening_resolutions'] = [decision]
        db.execute("UPDATE application_events SET payload=? WHERE kind='migration_duplicate_merge'", (json.dumps(event),))
        for index, row in enumerate(original):
            db.execute("INSERT INTO application_events(event_key,job_id,kind,payload,created) VALUES(?,?,'migration_evidence',?,?)",
                (f'synthetic-screening-archive-{index}', row['job_id'],
                 json.dumps(dict(table='duplicate_job_screening_before', row=row)), created))
    return before, after, raw


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
def test_explicit_screening_choice_is_derived_from_trusted_input_and_old_rows(duplicate_legacy_records, monkeypatch):
    before, after, raw = explicit_screening_pair(duplicate_legacy_records)
    module = accounting()
    monkeypatch.setattr(module._stream, 'resolution_manifest', lambda: raw)
    from jobs_radar import migration_duplicate_records
    def forbidden(*_, **__):
        raise AssertionError('The independent auditor must not execute runtime decisions')
    monkeypatch.setattr(migration_duplicate_records, 'screening_resolutions', forbidden)
    result = module.reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']


@pytest.mark.parametrize('duplicate_legacy_records', ['needs_input'], indirect=True)
@pytest.mark.parametrize('case', ['unapproved', 'wrong_member', 'old_version', 'old_manual_keep',
    'current_state', 'current_version', 'current_manual_keep', 'lost_archive', 'forged_manifest_hash'])
def test_screening_choice_never_becomes_general_keep_precedence(duplicate_legacy_records, monkeypatch, case):
    before, after, raw = explicit_screening_pair(duplicate_legacy_records)
    rule = json.loads(raw)
    failure = 'duplicate_screening_resolution'
    if case == 'unapproved':
        rule['screening'] = []
        failure = 'duplicate_references'
    if case == 'wrong_member': rule['screening'][0]['source_job_ids'] = ['synthetic-other']
    if case in {'old_version', 'old_manual_keep'}:
        field = 'version' if case == 'old_version' else 'manual_keep'
        with sqlite3.connect(before) as db:
            db.execute(f'UPDATE job_screening SET {field}={field}+1 WHERE job_id=?', (INVENTORY_JOB,))
    if case.startswith('current_'):
        field = case.removeprefix('current_')
        with sqlite3.connect(after) as db:
            db.execute(f'UPDATE job_screening SET {field}=?', ('trash' if field == 'state' else 0,))
        failure = 'duplicate_references'
    if case == 'lost_archive':
        with sqlite3.connect(after) as db:
            db.execute("DELETE FROM application_events WHERE json_extract(payload,'$.table')='duplicate_job_screening_before'")
        failure = 'duplicate_archive'
    if case == 'forged_manifest_hash':
        with sqlite3.connect(after) as db:
            db.execute("UPDATE schema_migrations SET report=json_set(report,'$.duplicate_records[0].screening_resolutions[0].manifest_sha256','forged')")
            db.execute("UPDATE application_events SET payload=json_set(payload,'$.screening_resolutions[0].manifest_sha256','forged') WHERE kind='migration_duplicate_merge'")
        failure = 'duplicate_mapping'
    module = accounting()
    monkeypatch.setattr(module._stream, 'resolution_manifest', lambda: json.dumps(rule).encode())
    result = module.reconcile(before, after)
    assert not result['summary']['verified']
    assert failure in result['summary']['failures']


def source_proof_pair(legacy, proof):
    """Build a valid synthetic pair, then substitute one full source proof.

    The before row, retained live evidence and exact before-row archive all get
    the same substitution. This tests the auditor's source semantics, rather
    than depending on the migration accepting or rejecting this new example.
    Timestamps, owner identity, record, timeline and mapping stay untouched.
    """
    before, after = pair(legacy)
    encoded = json.dumps([proof])
    with sqlite3.connect(before) as db:
        db.execute('UPDATE applications SET evidence=? WHERE job_id=?', (encoded, OFFICIAL_JOB))
    with sqlite3.connect(after) as db:
        db.execute('UPDATE applications SET evidence=? WHERE application_id=?', (encoded, APPLICATION_ID))
        archives = db.execute("SELECT rowid,payload FROM application_events WHERE kind='migration_evidence'").fetchall()
        changed = 0
        for rowid, raw in archives:
            payload = json.loads(raw)
            if payload.get('table') == 'duplicate_applications_before' and payload['row']['job_id'] == OFFICIAL_JOB:
                payload['row']['evidence'] = encoded
                db.execute('UPDATE application_events SET payload=? WHERE rowid=?', (json.dumps(payload), rowid))
                changed += 1
        assert changed == 1
    return before, after


@pytest.mark.parametrize('reference', [MAIL_RECEIPT,
    'https://mail.google.com/mail/u/?authuser=synthetic%40example.invalid#all/0123456789abcdef'])
def test_matching_mail_receipt_is_a_locator_not_a_different_posting(duplicate_legacy_records, reference, monkeypatch):
    before, after = source_proof_pair(duplicate_legacy_records, {
        'type': 'matching_receipt', 'reference': reference,
        'observed_at': CONFIRMED_AT, 'reported_by': 'email-sync',
    })
    from jobs_radar import migration_duplicate_records
    def forbidden(*_, **__):
        raise AssertionError('Auditor cannot delegate source trust to migration')
    monkeypatch.setattr(migration_duplicate_records, 'proof', forbidden)
    original = before.read_bytes(), after.read_bytes()
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    assert result['summary']['confirmedDuplicateGroups'] == 1
    with sqlite3.connect(after) as db:
        assert db.execute('SELECT confirmed_at FROM applications').fetchone()[0] == CONFIRMED_AT
    assert original == (before.read_bytes(), after.read_bytes())


@pytest.mark.parametrize('proof', [
    {'type': 'matching_receipt', 'reference': OTHER_POSTING},
    {'type': 'official_success', 'reference': MAIL_RECEIPT},
    {'type': 'matching_receipt', 'url': MAIL_RECEIPT},
    {'type': 'matching_receipt', 'job_url': MAIL_RECEIPT},
    {'type': 'matching_receipt', 'reference': MAIL_RECEIPT, 'job_url': OTHER_POSTING},
    {'type': 'matching_receipt', 'reference': MAIL_RECEIPT, 'nested': {'job_url': OTHER_POSTING}},
    {'type': 'matching_receipt', 'reference': MAIL_RECEIPT, 'nested': [{'type': 'matching_receipt', 'reference': MAIL_RECEIPT}]},
    {'type': 'matching_receipt', 'reference': 'http://mail.google.com/mail/u/#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com.example.invalid/mail/u/#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://synthetic@mail.google.com/mail/u/#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com:443/mail/u/#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/0/#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/?other=value#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/?authuser=#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/?authuser=a&authuser=b#all/0123456789abcdef'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/#all/not-a-message'},
    {'type': 'matching_receipt', 'reference': 'https://mail.google.com/mail/u/#all/0123456789abcdef/extra'},
])
def test_mail_locator_exception_does_not_hide_wrong_or_nested_posting_sources(duplicate_legacy_records, proof):
    before, after = source_proof_pair(duplicate_legacy_records, proof)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_submission_sources' in result['summary']['failures']


def test_mail_locator_cannot_promote_a_source_without_old_submitted_status(duplicate_legacy_records):
    before, after = source_proof_pair(duplicate_legacy_records,
        {'type': 'matching_receipt', 'reference': MAIL_RECEIPT})
    with sqlite3.connect(before) as db:
        db.execute("UPDATE applications SET status='submitted_unconfirmed' WHERE job_id=?", (OFFICIAL_JOB,))
    with sqlite3.connect(after) as db:
        for rowid, raw in db.execute("SELECT rowid,payload FROM application_events WHERE kind='migration_evidence'").fetchall():
            payload = json.loads(raw)
            if payload.get('table') == 'duplicate_applications_before' and payload['row']['job_id'] == OFFICIAL_JOB:
                payload['row']['status'] = 'submitted_unconfirmed'
                db.execute('UPDATE application_events SET payload=? WHERE rowid=?', (json.dumps(payload), rowid))
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert result['summary']['confirmedDuplicateGroups'] == 0


@pytest.fixture
def split_and_duplicate_undo(duplicate_legacy_records):
    """Two independent transformations share one DB, never the same undo row."""
    from test_migration_identity_split import legacy, OLD_ID, URLS
    before = duplicate_legacy_records[0]
    split = before.with_name('split-source.sqlite')
    legacy(split)
    with sqlite3.connect(split) as db:
        db.row_factory = sqlite3.Row
        review = dict(db.execute('SELECT * FROM job_screening').fetchone())
        def item(url, detail, kind='newgrad'):
            return {**review, 'kind': kind, 'detail': detail,
                    'evidence': json.dumps([{'url': url}])}
        reviews = [item(URLS[0], 'Synthetic anchor one'),
                   item(URLS[1], 'Synthetic other posting'),
                   item('https://example.invalid/ambiguous', 'Synthetic ambiguous'),
                   item(URLS[0], 'Synthetic wrong kind', 'internship'),
                   item(URLS[0], 'Synthetic anchor two')]
        db.execute('UPDATE owner_submission_undo SET application=?,reviews=?',
                   ('{"synthetic":"original snapshot"}', json.dumps(reviews)))
    with sqlite3.connect(before) as db:
        db.execute('ATTACH DATABASE ? AS split', (str(split),))
        tables = db.execute("SELECT name FROM split.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        for (table,) in tables:
            if table == 'management_documents':
                inventory = json.loads(db.execute("SELECT value FROM main.management_documents WHERE key='appliedList'").fetchone()[0])
                inventory += json.loads(db.execute("SELECT value FROM split.management_documents WHERE key='appliedList'").fetchone()[0])
                db.execute("UPDATE main.management_documents SET value=? WHERE key='appliedList'", (json.dumps(inventory),))
            else:
                quoted = '"' + table.replace('"', '""') + '"'
                db.execute('INSERT INTO main.' + quoted + ' SELECT * FROM split.' + quoted)
    before, after = pair(duplicate_legacy_records)
    return before, after, OLD_ID, [reviews[0], reviews[4]]


def test_split_undo_projection_and_duplicate_retention_can_coexist(split_and_duplicate_undo, monkeypatch):
    from jobs_radar import migration_identity_split
    before, after, jid, kept = split_and_duplicate_undo
    def forbidden(*_, **__):
        raise AssertionError('Audit must independently derive the old split anchor and review subset')
    monkeypatch.setattr(migration_identity_split, 'matching_keys', forbidden)
    monkeypatch.setattr(migration_identity_split, 'split_legacy_identities', forbidden)
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    with sqlite3.connect(after) as db:
        assert json.loads(db.execute('SELECT reviews FROM owner_submission_undo WHERE job_id=?', (jid,)).fetchone()[0]) == kept
    assert original == (before.read_bytes(), after.read_bytes())


@pytest.mark.parametrize('change', ['application', 'version', 'expires', 'job_id',
                                  'reviews_empty', 'reviews_reordered', 'reviews_wrong_kind',
                                  'archive_missing', 'archive_changed'])
def test_split_undo_exception_never_hides_other_changes(split_and_duplicate_undo, change):
    before, after, jid, kept = split_and_duplicate_undo
    with sqlite3.connect(after) as db:
        if change in {'application', 'version', 'expires', 'job_id'}:
            expressions = {'application': "'{\"tampered\":true}'", 'version': 'version+1',
                           'expires': 'expires+1', 'job_id': "'synthetic-tampered-id'"}
            db.execute('UPDATE owner_submission_undo SET ' + change + '=' + expressions[change] + ' WHERE job_id=?', (jid,))
        elif change.startswith('reviews_'):
            altered = [] if change == 'reviews_empty' else list(reversed(kept))
            if change == 'reviews_wrong_kind':
                altered = [{**kept[0], 'kind': 'internship'}, kept[1]]
            db.execute('UPDATE owner_submission_undo SET reviews=? WHERE job_id=?', (json.dumps(altered), jid))
            # An after-report assertion is never authority to drop a kept item.
            report = json.loads(db.execute("SELECT report FROM schema_migrations WHERE name='applications-v2'").fetchone()[0])
            report['identity_splits'][0]['undo_reviews_archived'] = 5 - len(altered)
            db.execute("UPDATE schema_migrations SET report=? WHERE name='applications-v2'", (json.dumps(report),))
        else:
            where = "kind='migration_evidence' AND json_extract(payload,'$.table')='owner_submission_undo'"
            if change == 'archive_missing':
                db.execute('DELETE FROM application_events WHERE ' + where)
            else:
                db.execute("UPDATE application_events SET payload=json_set(payload,'$.row.application','{}') WHERE " + where)
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert 'duplicate_undo_content' in result['summary']['failures']
