import json
import sqlite3
import tracemalloc
from contextlib import closing

import pytest

from test_docker_rehearsal import module
from test_migration_accounting import migrated, accounting
from jobs_radar.application_schema import migrate_path
from test_migration_identity_split import OLD_ID, URLS


def test_streamed_accounting_checks_explicit_expected_origins_and_preserves_input_bytes(migrated):
    before, after = migrated
    original = before.read_bytes(), after.read_bytes()
    result = module('reconcile_application_migration_stream').reconcile(before, after)
    assert result['summary']['verified']
    assert result['summary']['inventoryBefore'] == 3
    assert result['summary']['inventoryUniqueMapped'] == 2
    assert result['summary']['addedApplications'] == {'identity_split': 1, 'external_inventory': 1,
        'historical_placeholder': 1, 'orphan_progress': 1}
    assert result['inventoryRedirects'] == [{'old_record_id': 'merged-old-id',
        'application_id': 'retained-application-id', 'job_id': OLD_ID, 'same_posting': True}]
    assert original == (before.read_bytes(), after.read_bytes())
    assert not list(after.parent.glob('application-accounting-*'))


def test_streamed_accounting_reports_explicit_losses_and_identity_conflicts(migrated):
    before, after = migrated
    changes = [
        ("DELETE FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='application_progress'", 'retired_archive:application_progress'),
        ("UPDATE applications SET deleted=1 WHERE application_id='retained-application-id'", 'inventory_mapping_targets'),
        ("UPDATE applications SET job_key='wrong-posting' WHERE application_id='external-old-id'", 'inventory_posting_identity'),
        ("UPDATE owner_profiles SET profile='{}'", 'protected_table:owner_profiles'),
        ("DELETE FROM oauth_tokens", 'protected_table:oauth_tokens'),
    ]
    expected = set()
    for change, failure in changes:
        with sqlite3.connect(after) as db:
            db.execute(change)
        expected.add(failure)
        result = module('reconcile_application_migration_stream').reconcile(before, after)
        assert not result['summary']['verified']
        assert expected <= set(result['summary']['failures'])


def test_other_document_history_is_filtered_in_sql_and_not_loaded_into_python(migrated):
    before, after = migrated
    for database in (before, after):
        with sqlite3.connect(database) as db:
            for revision in range(4):
                db.execute('INSERT INTO management_revisions VALUES(?,?,?,1)',
                           ('profileArray', revision, json.dumps({'private_resume': 'x' * (8 * 1024 * 1024)})))
    # The historically named public entry must now retain the same bounded
    # behavior, so a caller cannot accidentally select the retired eager code.
    auditor = accounting()
    tracemalloc.start()
    try:
        result = auditor.reconcile(before, after)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result['summary']['verified']
    assert peak < 4 * 1024 * 1024, f'Python allocated {peak} bytes while irrelevant revisions must remain in SQLite'


@pytest.mark.parametrize(('change', 'failure'), [
    ("UPDATE applications SET record='{}' WHERE application_id='retained-application-id'", 'live_record_content'),
    ("UPDATE applications SET progress=NULL WHERE application_id='retained-application-id'", 'live_progress_content'),
    ("UPDATE applications SET confirmed_at=NULL,evidence='[]' WHERE application_id='retained-application-id'", 'live_submission_content'),
    ("INSERT INTO applications(job_id,status) VALUES('historical:never-existed','submitted')", 'application_row_accounting'),
    ("INSERT INTO applications(job_id,status) VALUES('retired:never-existed','submitted')", 'application_row_accounting'),
    ('DELETE FROM observations', 'source_rows:observations'),
    ('DELETE FROM jobs', 'source_rows:jobs'),
    ("DELETE FROM applications WHERE job_id LIKE 'historical:%'", 'application_row_accounting'),
    ("DELETE FROM applications WHERE job_id LIKE 'retired:%'", 'application_row_accounting'),
    ("UPDATE applications SET attempted_at=0 WHERE job_id='board-only'", 'live_submission_content'),
    ("UPDATE applications SET updated=0 WHERE job_id='board-only'", 'live_submission_content'),
    ("UPDATE applications SET updated=1,attempted_at=1 WHERE job_id LIKE 'historical:%'", 'live_submission_content'),
    ("UPDATE applications SET record_version=0 WHERE application_id='retained-application-id'", 'live_record_content'),
    ("UPDATE applications SET progress=json_set(progress,'$.round',99) WHERE application_id='retained-application-id'", 'live_progress_content'),
])
def test_independent_accounting_rejects_previously_false_success(migrated, change, failure):
    before, after = migrated
    with sqlite3.connect(after) as db:
        db.execute(change)
    result = module('reconcile_application_migration_stream').reconcile(before, after)
    assert not result['summary']['verified']
    assert failure in result['summary']['failures']


def remigrate(before, after):
    with closing(sqlite3.connect(before)) as source, closing(sqlite3.connect(after)) as destination:
        source.backup(destination)
    migrate_path(after, dry_run=False)


@pytest.fixture
def with_events(migrated):
    before, after = migrated
    with closing(sqlite3.connect(before)) as db, db:
        db.execute('INSERT INTO application_progress_events VALUES(?,?,?)', ('progress-1', 'merged-old-id',
            json.dumps(dict(application_id='merged-old-id', recorded_at=12345, to='interview', round=2, applied=True))))
        db.execute('INSERT INTO recruiting_events VALUES(?,?,?,?,?,?,?,?,?,?)',
            ('mailbox', 'message-1', OLD_ID, 'interview', 12346, 'Synthetic mail', 'same posting', 12347, 1, '{}'))
        db.execute('INSERT INTO application_progress_pending VALUES(?,?)', ('pending-1', json.dumps(dict(stage='offer', candidates=[]))))
        db.execute('INSERT INTO extension_receipts VALUES(?,?,?,?,?,?,?,?,?)', ('receipt-1', 'device-1', 'checksum-1',
            json.dumps(dict(job_url=URLS[0], proof='ats_confirmation')), 12348, 12349, 'recorded', OLD_ID, '{"state":"submitted"}'))
    remigrate(before, after)
    result = module('reconcile_application_migration_stream').reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    return before, after


@pytest.mark.parametrize(('change', 'failure'), [
    ("DELETE FROM application_events WHERE kind='extension'", 'live_event_content:extension'),
    ("UPDATE application_events SET checksum='changed' WHERE kind='extension'", 'live_event_content:extension'),
    ("UPDATE application_events SET updated=0 WHERE kind='extension'", 'live_event_content:extension'),
    ("UPDATE application_events SET created=0 WHERE kind='extension'", 'live_event_content:extension'),
    ("UPDATE application_events SET result='{}' WHERE kind='extension'", 'live_event_content:extension'),
    ("UPDATE application_events SET payload='{}' WHERE kind='mail'", 'live_event_content:mail'),
    ("UPDATE application_events SET application_id='merged-old-id' WHERE kind='progress'", 'live_event_content:progress'),
    ("DELETE FROM application_events WHERE kind='progress'", 'live_event_content:progress'),
    ("UPDATE application_events SET created=0 WHERE kind='pending'", 'live_event_content'),
])
def test_usable_receipt_and_progress_events_are_checked_beside_archives(with_events, change, failure):
    before, after = with_events
    with closing(sqlite3.connect(after)) as db, db:
        db.execute(change)
    result = module('reconcile_application_migration_stream').reconcile(before, after)
    assert not result['summary']['verified']
    assert failure in result['summary']['failures']


def test_merged_progress_uses_source_versions_and_preserves_all_details(migrated):
    before, after = migrated
    with closing(sqlite3.connect(before)) as db, db:
        original = json.loads(db.execute("SELECT payload FROM application_progress WHERE id='retained-application-id'").fetchone()[0])
        original.update(application_id='merged-old-id', version=4, round=3, reference='synthetic reference', observed_at=12345)
        db.execute('INSERT INTO application_progress VALUES(?,?)', ('merged-old-id', json.dumps(original)))
    remigrate(before, after)
    auditor = module('reconcile_application_migration_stream')
    assert auditor.reconcile(before, after)['summary']['verified']
    with closing(sqlite3.connect(after)) as db, db:
        db.execute("UPDATE applications SET progress=json_set(progress,'$.reference','lost') WHERE application_id='retained-application-id'")
    assert 'live_progress_content' in auditor.reconcile(before, after)['summary']['failures']


def test_source_mail_progress_is_preserved_when_it_supersedes_an_unedited_seed(migrated):
    before, after = migrated
    with closing(sqlite3.connect(before)) as db, db:
        db.execute("UPDATE application_progress SET payload=json_set(payload,'$.version',0) WHERE id='retained-application-id'")
        db.execute('INSERT INTO recruiting_progress VALUES(?,?,?,?,?,?)', (OLD_ID, 'received', 12345, 'mail-2', 'Synthetic receipt', 3))
    remigrate(before, after)
    auditor = module('reconcile_application_migration_stream')
    assert auditor.reconcile(before, after)['summary']['verified']
    with closing(sqlite3.connect(after)) as db, db:
        db.execute("UPDATE applications SET progress=json_set(progress,'$.receipt_confirmed',json('false')) WHERE application_id='retained-application-id'")
    assert 'live_progress_content' in auditor.reconcile(before, after)['summary']['failures']


@pytest.mark.parametrize('date', ['2026-01-15T12:00:00+00:00', '', 'invalid legacy display date'])
def test_inventory_attempt_time_and_unknown_legacy_date_are_accounted_independently(migrated, date):
    before, after = migrated
    with closing(sqlite3.connect(before)) as db, db:
        db.execute("UPDATE applications SET status='not_started' WHERE job_id=?", (OLD_ID,))
        inventory = json.loads(db.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()[0])
        inventory[0]['date'] = date
        db.execute("UPDATE management_documents SET value=? WHERE key='appliedList'", (json.dumps(inventory),))
    remigrate(before, after)
    auditor = module('reconcile_application_migration_stream')
    result = auditor.reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    with closing(sqlite3.connect(after)) as db, db:
        db.execute("UPDATE applications SET attempted_at=0 WHERE application_id='retained-application-id'")
    assert 'live_submission_content' in auditor.reconcile(before, after)['summary']['failures']


def test_forged_split_report_cannot_explain_a_new_identity(migrated):
    before, after = migrated
    with closing(sqlite3.connect(after)) as db, db:
        report = json.loads(db.execute('SELECT report FROM schema_migrations').fetchone()[0])
        report['identity_splits'].append(dict(old_job_id=OLD_ID, postings=[dict(job_id='fabricated', job_key='forged')]))
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(report),))
        db.execute("INSERT INTO applications(job_id,status) VALUES('fabricated','not_started')")
    result = module('reconcile_application_migration_stream').reconcile(before, after)
    assert 'identity_split_sources' in result['summary']['failures']
    assert 'application_row_accounting' in result['summary']['failures']


def test_failure_closes_readers_and_removes_only_its_scratch_files(migrated, monkeypatch):
    before, after = migrated
    auditor = module('reconcile_application_migration_stream')
    original = before.read_bytes(), after.read_bytes()
    marker = after.parent / 'keep-evidence'
    marker.write_text('synthetic evidence')
    def fail(*_):
        raise OSError('Synthetic scratch disk failure')
    monkeypatch.setattr(auditor.Digests, 'add', fail)
    with pytest.raises(OSError, match='Synthetic scratch'):
        auditor.reconcile(before, after)
    assert original == (before.read_bytes(), after.read_bytes())
    assert marker.read_text() == 'synthetic evidence'
    assert not list(after.parent.glob('application-accounting-*'))


def test_auditor_does_not_replay_the_migration_or_reuse_its_projections(migrated, monkeypatch):
    from jobs_radar import application_schema, application_records, migration_identity_split
    def forbidden(*_, **__):
        raise AssertionError('Audit expectations must be independent of migration writers')
    for owner, name in ((application_schema, '_migrate'), (application_schema, 'migrate_path'),
                        (application_records, 'upsert'), (application_records, 'seed_progress'),
                        (migration_identity_split, 'split_legacy_identities')):
        monkeypatch.setattr(owner, name, forbidden)
    before, after = migrated
    assert module('reconcile_application_migration_stream').reconcile(before, after)['summary']['verified']


def test_url_less_inventory_keeps_its_own_id_without_inventing_a_posting(migrated):
    before, after = migrated
    with closing(sqlite3.connect(before)) as db, db:
        inventory = json.loads(db.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()[0])
        template = {**inventory[0], 'jobLink': '', 'companyName': 'Synthetic no-link company'}
        inventory.extend({**template, 'id': aid} for aid in ('no-link-one', 'no-link-two'))
        db.execute("UPDATE management_documents SET value=? WHERE key='appliedList'", (json.dumps(inventory),))
    remigrate(before, after)
    auditor = module('reconcile_application_migration_stream')
    result = auditor.reconcile(before, after)
    assert result['summary']['verified'], result['summary']['failures']
    with closing(sqlite3.connect(after)) as db, db:
        mappings = json.loads(db.execute('SELECT report FROM schema_migrations').fetchone()[0])
        row = next(item for item in mappings['mappings'] if item.get('old_record_id') == 'no-link-one')
        row.update(application_id='no-link-two', job_id='external:no-link-two')
        db.execute('UPDATE schema_migrations SET report=?', (json.dumps(mappings),))
    # Identical visible metadata and two empty URLs do not authorize a merge.
    result = auditor.reconcile(before, after)
    assert 'inventory_posting_identity' in result['summary']['failures']
