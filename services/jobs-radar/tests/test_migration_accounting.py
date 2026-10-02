import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest

from jobs_radar.application_records import seed_progress
from jobs_radar.application_schema import migrate_path
from test_application_model_v2 import record
from test_migration_identity_split import legacy, OLD_ID, URLS
from test_store import observation


def accounting():
    source = Path(__file__).parents[1] / 'deploy/reconcile_application_migration.py'
    spec = importlib.util.spec_from_file_location('migration_accounting', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def migrated(tmp_path):
    before, after = tmp_path / 'before.sqlite', tmp_path / 'after.sqlite'
    legacy(before)
    with sqlite3.connect(before) as db:
        inventory = json.loads(db.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()[0])
        inventory.append({**record(URLS[0]), 'id': 'merged-old-id'})
        inventory.append({**record('https://example.invalid/uncollected'), 'id': 'external-old-id'})
        db.execute("UPDATE management_documents SET value=? WHERE key='appliedList'", (json.dumps(inventory),))
        db.execute("INSERT INTO jobs VALUES('board-only','board-only',1,2)")
        db.execute("INSERT INTO applications VALUES('board-only','submitted',2,1,'Legacy attempt','[]',NULL)")
        source = observation(url='https://example.invalid/board-only')
        db.execute("INSERT INTO observations VALUES('simplify:newgrad','board-only','board-only',?,1,2,1)", (json.dumps(source),))
        db.execute("INSERT INTO historical VALUES('unknown-historical','submitted','original historical reason')")
        db.execute("INSERT INTO application_progress VALUES('orphan-progress',?)", (json.dumps(seed_progress('orphan-progress', 'applied', 'owner')),))
        db.execute("INSERT INTO owner_profiles VALUES('profile','{\"privateFact\":\"retained\"}','revision',0)")
        db.execute("INSERT INTO oauth_tokens VALUES('token','access','{}',9999999999,'family')")
    with sqlite3.connect(before) as source, sqlite3.connect(after) as destination:
        source.backup(destination)
    migrate_path(after, dry_run=False)
    return before, after


def test_accounting_explains_merge_display_and_each_new_application_origin_without_writes(migrated):
    before, after = migrated
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    summary = result['summary']
    assert summary['verified'], summary['failures']
    assert summary['inventoryBefore'] == 3
    assert summary['inventoryUniqueMapped'] == 2
    assert summary['oldRecordIdsAbsent'] == summary['redirectedInventoryIds'] == 1
    assert result['inventoryRedirects'] == [{'old_record_id': 'merged-old-id', 'application_id': 'retained-application-id', 'job_id': OLD_ID, 'same_posting': True}]
    assert summary['redirectedIdsWithSamePosting'] == 1
    assert summary['newRecordIds'] == 1
    assert summary['generatedRecords'] == {'prior_board_outcome': 1}
    assert summary['applicationsBefore'] == 2 and summary['applicationsAfter'] == 6
    assert summary['addedApplications'] == {'identity_split': 1, 'external_inventory': 1, 'historical_placeholder': 1, 'orphan_progress': 1}
    assert summary['statusChanges'] == {'confirmation_evidence_missing': 1}
    assert summary['confirmationDowngradesReported'] == 2  # Includes the historical placeholder.
    assert summary['recordSubmissionStatuses'] == {'submitted': 1, 'submitted_unconfirmed': 2}
    assert summary['protectedTablesUnchanged']
    assert original == (before.read_bytes(), after.read_bytes())
    serialized = json.dumps(result)
    assert 'privateFact' not in serialized and 'https://' not in serialized
    assert 'Legacy attempt' not in serialized and 'original historical reason' not in serialized


@pytest.mark.parametrize(('tamper', 'expected'), [
    ("DELETE FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='application_progress'", 'retired_archive:application_progress'),
    ("DELETE FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='management_documents'", 'inventory_archive:management_documents'),
    ("UPDATE applications SET deleted=1 WHERE application_id='retained-application-id'", 'inventory_mapping_targets'),
    ("UPDATE applications SET job_key='unrelated-posting' WHERE application_id='retained-application-id'", 'inventory_posting_identity'),
    ("UPDATE owner_profiles SET profile='{}'", 'protected_table:owner_profiles'),
    ("DELETE FROM oauth_tokens", 'protected_table:oauth_tokens'),
    ("INSERT INTO applications(job_id,status) VALUES('mystery','not_started')", 'application_row_accounting'),
    ("UPDATE applications SET status='needs_input' WHERE job_id='board-only'", 'status_change_accounting'),
])
def test_unexplained_or_lost_data_fails_accounting_without_repair(migrated, tamper, expected):
    before, after = migrated
    with sqlite3.connect(after) as db:
        db.execute(tamper)
    original = (before.read_bytes(), after.read_bytes())
    result = accounting().reconcile(before, after)
    assert not result['summary']['verified']
    assert expected in result['summary']['failures']
    assert original == (before.read_bytes(), after.read_bytes())


def test_accounting_requires_separate_complete_migration_databases(migrated):
    before, after = migrated
    with pytest.raises(ValueError, match='Separate'):
        accounting().reconcile(before, before)
    with sqlite3.connect(after) as db:
        db.execute('DELETE FROM schema_migrations')
    with pytest.raises(ValueError, match='completed'):
        accounting().reconcile(before, after)
