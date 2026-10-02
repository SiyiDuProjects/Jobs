"""Build an OFFLINE legacy recovery bundle without replacing either input.

This is an evidence-preserving rehearsal, not permission to start the old image
on the public network. Its application tables are frozen: old whole-list writes
cannot represent v2 unknown submissions, deletions or receipt ordering safely.
The complete current database is backed up and verified before any projection.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

from verify_restore import fingerprint, readonly, rehearse


LEGACY_APPLICATION_COLUMNS = ('job_id', 'status', 'version', 'updated', 'detail', 'evidence', 'owner_run_id')
LEGACY_JOB_COLUMNS = ('id', 'identity', 'first_seen', 'last_seen')
PROJECTED = {
    'applications', 'jobs', 'claims', 'claim_purposes', 'historical',
    'application_progress', 'application_progress_events', 'application_progress_migrations',
    'application_progress_pending', 'recruiting_progress', 'recruiting_events', 'extension_receipts',
}
FROZEN = PROJECTED - {'jobs'} | {'owner_submission_undo'}
LIMITATIONS = [
    'Offline recovery only; keep all network clients and collectors disconnected.',
    'Application writes are blocked by database triggers. This is not an online rollback.',
    'Only confirmed, visible records enter legacy appliedList; unknown and deleted records remain held in applications and the complete v2 backup.',
    'V2-only fields, tables, events and diagnostic schema remain available in the complete v2 backup. Redacted personal values are not reconstructed.',
    'Old claims are not reactivated. Browser sessions end and pending commands cannot replay.',
    'Any non-application rehearsal writes change the candidate only; discard the candidate after the rehearsal or separately reconcile before any switch.',
]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def columns(db, table):
    return tuple(row[1] for row in db.execute('PRAGMA table_info(' + quote(table) + ')'))


def tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def insert(db, table, value):
    names = columns(db, table)
    if set(value) != set(names):
        raise ValueError('Unexpected projected columns for ' + table)
    db.execute('INSERT INTO ' + quote(table) + ' VALUES(' + ','.join('?' for _ in names) + ')',
               [value[name] for name in names])


def copy_table(source, destination, table, names=None):
    names = names or columns(destination, table)
    selected = ','.join(map(quote, names))
    reader = source.execute('SELECT ' + selected + ' FROM ' + quote(table))
    sql = 'INSERT INTO ' + quote(table) + '(' + selected + ') VALUES(' + ','.join('?' for _ in names) + ')'
    while batch := reader.fetchmany(256):
        destination.executemany(sql, batch)


def legacy_schema(prechange, current, output):
    """Use actual verified schema, not an assumed list of table definitions."""
    old_tables, current_tables = tables(prechange), tables(current)
    required = PROJECTED | {'management_documents', 'management_revisions'}
    if not required <= old_tables:
        raise ValueError('Pre-change database does not contain the expected legacy application schema')
    if columns(prechange, 'applications') != LEGACY_APPLICATION_COLUMNS or columns(prechange, 'jobs') != LEGACY_JOB_COLUMNS:
        raise ValueError('Unsupported pre-change application/job schema')
    if 'application_events' not in current_tables or 'confirmed_at' not in columns(current, 'applications'):
        raise ValueError('Current database must use applications-v2')
    if not current.execute("SELECT 1 FROM schema_migrations WHERE name='applications-v2'").fetchone():
        raise ValueError('Current database has not completed applications-v2 migration')
    for table in old_tables - PROJECTED:
        if table not in current_tables:
            raise ValueError('Legacy table missing from current database: ' + table)
        old_shape = list(prechange.execute('PRAGMA table_info(' + quote(table) + ')'))
        new_shape = list(current.execute('PRAGMA table_info(' + quote(table) + ')'))
        if [tuple(row) for row in old_shape] != [tuple(row) for row in new_shape]:
            raise ValueError('Unreviewed schema difference: ' + table)
    schema = list(prechange.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name"))
    if any(row['type'] not in {'table', 'index'} for row in schema):
        raise ValueError('Legacy views or triggers require independent review')
    for row in schema:
        output.execute(row['sql'])
    for table in sorted(old_tables - PROJECTED):
        copy_table(current, output, table)
    copy_table(current, output, 'jobs', LEGACY_JOB_COLUMNS)
    copy_table(current, output, 'applications', LEGACY_APPLICATION_COLUMNS)
    return old_tables - PROJECTED, current_tables - old_tables


def project_applications(source, output):
    inventory = []
    counts = {'confirmedRecords': 0, 'heldUnknownRecords': 0, 'deletedRecords': 0, 'heldExternalRecords': 0}
    for app in source.execute('SELECT * FROM applications ORDER BY job_id'):
        if app['deleted']:
            counts['deletedRecords'] += 1
        confirmed = app['confirmed_at'] is not None and app['status'] == 'submitted'
        # A malformed confirmed flag must not become an old accepted submission.
        if app['status'] == 'submitted' and not confirmed:
            output.execute("UPDATE applications SET status='submitted_unconfirmed' WHERE job_id=?", (app['job_id'],))
        if app['progress']:
            progress = json.loads(app['progress'])
            insert(output, 'application_progress', {'id': app['application_id'], 'payload': app['progress']})
            if confirmed:
                stage = 'received' if progress['stage'] == 'applied' and progress.get('receipt_confirmed') else progress['stage']
                insert(output, 'recruiting_progress', dict(job_id=app['job_id'], stage=stage,
                    received_at=progress.get('observed_at') or 0, message_id=progress.get('reference', '') if progress.get('source') == 'email' else '',
                    summary=progress.get('summary', ''), version=progress.get('version', 0)))
        if app['record'] and not app['deleted']:
            if confirmed:
                row = json.loads(app['record'])
                row['id'] = app['application_id']
                if app['progress']:
                    row['status'] = json.loads(app['progress'])['stage']
                inventory.append(row)
                counts['confirmedRecords'] += 1
            else:
                counts['heldUnknownRecords'] += 1
                if not source.execute('SELECT 1 FROM jobs WHERE id=?', (app['job_id'],)).fetchone():
                    counts['heldExternalRecords'] += 1
    # Neither stale pre-change revisions nor removed records are resurrected.
    output.execute("DELETE FROM management_documents WHERE key='appliedList'")
    output.execute("DELETE FROM management_revisions WHERE key='appliedList'")
    insert(output, 'management_documents', dict(key='appliedList', value=json.dumps(inventory, ensure_ascii=False), revision=1))
    insert(output, 'application_progress_migrations', {'name': 'unified-v1', 'created': time.time()})
    return counts


def project_events(source, output):
    counts = {}
    for event in source.execute('SELECT * FROM application_events ORDER BY created,rowid'):
        kind = event['kind']
        counts[kind] = counts.get(kind, 0) + 1
        if kind == 'progress':
            insert(output, 'application_progress_events', {key: event[key] for key in ('event_key', 'application_id', 'payload')})
        elif kind == 'pending':
            value = json.loads(event['payload'])
            insert(output, 'application_progress_pending', {'job_id': value['job_id'], 'payload': event['payload']})
        elif kind == 'mail':
            value = json.loads(event['payload'])
            if isinstance(value.get('application_before'), dict):
                value['application_before'] = json.dumps({key: value['application_before'].get(key) for key in LEGACY_APPLICATION_COLUMNS})
            insert(output, 'recruiting_events', value)
        elif kind == 'extension':
            # Preserve the exact payload, checksum and terminal result. Never
            # reinterpret tracker/attempt as an ATS confirmation for the old API.
            insert(output, 'extension_receipts', dict(event_id=event['event_key'], device_id=event['device_id'],
                checksum=event['checksum'], payload=event['payload'], received=event['created'], updated=event['updated'],
                state=event['state'], job_id=event['job_id'], result=event['result']))
    return counts


def end_execution(output):
    present = tables(output)
    if 'browser_control_sessions' in present:
        output.execute("UPDATE browser_control_sessions SET active=0,pages='[]'")
    if 'browser_control_commands' in present:
        output.execute("UPDATE browser_control_commands SET state=CASE state WHEN 'queued' THEN 'cancelled' WHEN 'dispatched' THEN 'unknown' ELSE state END,args='{}'")
    if 'browser_snapshot_requests' in present:
        output.execute('DELETE FROM browser_snapshot_requests')
    # Undo snapshots have v2 fields and may reference an expired version. Keep
    # them intact in the v2 backup; do not let old code replay them into old rows.
    output.execute('DELETE FROM owner_submission_undo')


def freeze_applications(output):
    for table in sorted(FROZEN):
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            output.execute('CREATE TRIGGER ' + quote('recovery_freeze_' + table + '_' + action) +
                ' BEFORE ' + action + ' ON ' + quote(table) + " BEGIN SELECT RAISE(ABORT,'Offline recovery: application writes are disabled'); END")
    for table in ('management_documents', 'management_revisions'):
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            condition = "OLD.key='appliedList'" if action == 'DELETE' else "NEW.key='appliedList'"
            if action == 'UPDATE':
                condition += " OR OLD.key='appliedList'"
            output.execute('CREATE TRIGGER ' + quote('recovery_freeze_' + table + '_' + action) +
                ' BEFORE ' + action + ' ON ' + quote(table) + ' WHEN ' + condition +
                " BEGIN SELECT RAISE(ABORT,'Offline recovery: application writes are disabled'); END")


def recover(prechange, current, bundle):
    prechange, current = Path(prechange).resolve(strict=True), Path(current).resolve(strict=True)
    bundle = Path(bundle).resolve()
    if prechange == current:
        raise ValueError('Separate pre-change and current databases required')
    # Exclusive directory reserves all output names; no existing output can be
    # silently reused. Failed bundles retain their verified backup for review.
    bundle.mkdir(mode=0o700, parents=False, exist_ok=False)
    saved = bundle / 'current-v2.sqlite'
    rehearse(current, saved)
    current_fingerprint = fingerprint(saved)
    previous_fingerprint = fingerprint(prechange)
    candidate = bundle / 'candidate.sqlite'
    building = bundle / 'candidate.building.sqlite'
    try:
        with readonly(prechange) as old, readonly(saved) as source, closing(sqlite3.connect(building)) as output:
            old.row_factory = source.row_factory = sqlite3.Row
            output.row_factory = sqlite3.Row
            output.execute('BEGIN IMMEDIATE')
            copied, archive_only = legacy_schema(old, source, output)
            app_counts = project_applications(source, output)
            event_counts = project_events(source, output)
            end_execution(output)
            freeze_applications(output)
            if output.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or output.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Legacy candidate integrity failed')
            output.commit()
        candidate_fingerprint = fingerprint(building)
        adjusted = {'management_documents', 'management_revisions', 'owner_submission_undo',
                    'browser_control_sessions', 'browser_control_commands', 'browser_snapshot_requests'}
        for table in copied - adjusted:
            if candidate_fingerprint['hashes'][table] != current_fingerprint['hashes'][table]:
                raise ValueError('Current rows were not preserved: ' + table)
        if fingerprint(prechange) != previous_fingerprint or fingerprint(saved) != current_fingerprint:
            raise ValueError('A recovery input changed during verification')
        report = dict(mode='offline-only', onlineRollbackReady=False, applicationWritesBlocked=True,
            backup='current-v2.sqlite', candidate='candidate.sqlite', integrity='ok',
            prechangeFingerprint=previous_fingerprint, currentFingerprint=current_fingerprint,
            candidateFingerprint=candidate_fingerprint, copiedTables=sorted(copied - adjusted),
            archivedOnlyTables={table: current_fingerprint['counts'][table] for table in sorted(archive_only)},
            applicationProjection=app_counts, eventKinds=event_counts, limitations=LIMITATIONS)
        with readonly(prechange) as schema_source:
            report['prechangeSchemaSha256'] = hashlib.sha256('\n'.join(
                row[0] for row in schema_source.execute("SELECT coalesce(sql,'') FROM sqlite_master ORDER BY type,name")
            ).encode()).hexdigest()
        (bundle / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(building, candidate)
        return report
    except BaseException:
        (bundle / 'FAILED').write_text('Candidate is incomplete and must not be activated. The current-v2 backup is retained.\n', encoding='utf-8')
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prechange', type=Path, required=True)
    parser.add_argument('--current', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True, help='New directory beside the database, with space for two complete copies')
    args = parser.parse_args()
    report = recover(args.prechange, args.current, args.bundle)
    print(json.dumps({key: report[key] for key in ('mode', 'onlineRollbackReady', 'integrity', 'applicationProjection', 'eventKinds')}, sort_keys=True))
