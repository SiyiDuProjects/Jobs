"""Explicit, transactional migration to the single application store.

Run migrate_path with dry_run first against a verified backup. Every retired row
is retained as migration evidence in application_events before its table is
removed. Runtime startup never silently migrates a populated old database.
"""
import hashlib
import json
import sqlite3
import time
import tempfile
from contextlib import closing
from pathlib import Path

VERSION = 'applications-v2'
RETIRED = ('claims', 'claim_purposes', 'historical', 'application_progress',
           'application_progress_events', 'application_progress_migrations', 'application_progress_pending',
           'recruiting_progress', 'recruiting_events', 'extension_receipts')


def table_exists(c, name):
    return bool(c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def create(c):
    columns = {r[1] for r in c.execute('PRAGMA table_info(applications)')}
    for name, kind in {
        'application_id': 'TEXT', 'job_key': 'TEXT', 'record': 'TEXT',
        'progress': 'TEXT', 'record_version': 'INTEGER NOT NULL DEFAULT 0',
        'deleted': 'INTEGER NOT NULL DEFAULT 0', 'attempted_at': 'REAL',
        'confirmed_at': 'REAL', 'submission_error': 'TEXT',
    }.items():
        if name not in columns:
            c.execute(f'ALTER TABLE applications ADD COLUMN {name} {kind}')
    if 'job_key' not in {r[1] for r in c.execute('PRAGMA table_info(jobs)')}:
        c.execute('ALTER TABLE jobs ADD COLUMN job_key TEXT')
    c.execute('CREATE UNIQUE INDEX IF NOT EXISTS application_record_id ON applications(application_id)')
    c.execute('CREATE INDEX IF NOT EXISTS application_job_key ON applications(job_key)')
    c.execute('CREATE INDEX IF NOT EXISTS jobs_job_key ON jobs(job_key)')
    c.execute('''CREATE TABLE IF NOT EXISTS application_events(
        event_key TEXT PRIMARY KEY, application_id TEXT, job_id TEXT, kind TEXT NOT NULL,
        payload TEXT NOT NULL, created REAL NOT NULL, device_id TEXT, checksum TEXT,
        updated REAL, state TEXT, result TEXT)''')
    c.execute('CREATE INDEX IF NOT EXISTS application_events_application ON application_events(application_id,kind)')
    c.execute('CREATE INDEX IF NOT EXISTS application_events_job ON application_events(job_id,kind)')
    c.execute('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,created REAL,report TEXT NOT NULL)')


def old_data(c):
    return any(table_exists(c, t) and c.execute(f'SELECT 1 FROM {t} LIMIT 1').fetchone() for t in RETIRED) or (
        table_exists(c, 'management_documents') and c.execute("SELECT 1 FROM management_documents WHERE key='appliedList' AND value!='[]'").fetchone())


def initialize(store):
    with store.connect(True) as c:
        ready = table_exists(c, 'schema_migrations') and c.execute('SELECT 1 FROM schema_migrations WHERE name=?', (VERSION,)).fetchone()
        if not ready and old_data(c):
            raise ValueError('Application migration required: verify backup, run applications-v2 dry-run, then explicitly apply before starting the service')
        create(c)
        if not ready:
            _migrate(c)


class _LegacyRows:
    """Reiterable SQL view over legacy rows kept unchanged until final DROP.

    Keep the original SELECT order for evidence indices. Split/duplicate passes
    only read these retired tables; each pass gets a fresh cursor, not a consumed
    generator or a whole-history Python list.
    """
    def __init__(self, connection, query):
        self.connection, self.query = connection, query

    def __iter__(self):
        with closing(self.connection.execute(self.query)) as cursor:
            for row in cursor:
                yield dict(row)


def _archive(c, table, rows):
    for index, row in enumerate(rows):
        original = dict(row)
        raw = json.dumps(original, ensure_ascii=False, sort_keys=True)
        key = f'migration:{table}:{index}:' + hashlib.sha256(raw.encode()).hexdigest()
        c.execute('INSERT OR IGNORE INTO application_events(event_key,job_id,kind,payload,created) VALUES(?,?,?,?,?)',
                  (key, original.get('job_id'), 'migration_evidence', json.dumps({'table': table, 'row': original}, ensure_ascii=False), time.time()))


def migrated_identity(value):
    """Decode old identity formats only during migration; runtime uses job_key."""
    from .job_match import job_key
    if value.startswith('greenhouse:'):
        parts=value.split(':')
        if len(parts)==3:return job_key(f'https://job-boards.greenhouse.io/{parts[1]}/jobs/{parts[2]}')
    if value.startswith(('jobs.lever.co:','jobs.eu.lever.co:','jobs.ashbyhq.com:')):
        host,company,posting=value.split(':',2)
        return job_key(f'https://{host}/{company}/{posting}')
    return job_key(value) or value


def _migrate(c):
    done = c.execute('SELECT report FROM schema_migrations WHERE name=?', (VERSION,)).fetchone() if table_exists(c, 'schema_migrations') else None
    if done:
        return {**json.loads(done[0]), 'already_applied': True}
    started_at = time.time()
    # Disk-backed, transaction-local provenance, captured before ALTER or any
    # historical placeholder/state update. Only merged rows become evidence.
    c.execute('CREATE TABLE _migration_application_origins(jid TEXT PRIMARY KEY, original TEXT NOT NULL)')
    for row in c.execute('SELECT * FROM applications'):
        c.execute('INSERT INTO _migration_application_origins VALUES(?,?)',
                  (row['job_id'], json.dumps(dict(row), ensure_ascii=False)))
    create(c)
    from . import application_records as records
    from .job_match import job_key
    from .application_progress import put, state
    report = {'version': VERSION, 'started_at': started_at, 'source_counts': {}, 'mappings': [], 'conflicts': []}
    retired = {}
    for name in RETIRED:
        exists = table_exists(c, name)
        rows = _LegacyRows(c, f'SELECT * FROM {name}') if exists else ()
        retired[name] = rows
        report['source_counts'][name] = c.execute(f'SELECT count(*) FROM {name}').fetchone()[0] if exists else 0
        _archive(c, name, rows)
    # Preserve complete old revisions as evidence, not a second writable store.
    inventory = []
    for name in ('management_documents', 'management_revisions'):
        if not table_exists(c, name):
            continue
        rows = _LegacyRows(c, f"SELECT * FROM {name} WHERE key='appliedList'")
        _archive(c, name, rows)
        if name == 'management_documents':
            current = c.execute("SELECT value FROM management_documents WHERE key='appliedList'").fetchone()
            if current:
                inventory = json.loads(current[0])
            del current
    from .migration_identity_split import split_legacy_identities
    report['identity_splits'] = split_legacy_identities(c, retired, _archive)
    for row in c.execute("SELECT job_id,json_extract(payload,'$.apply_url') url FROM observations").fetchall():
        key = job_key(row['url'])
        prior = c.execute('SELECT job_key FROM jobs WHERE id=?', (row['job_id'],)).fetchone()
        if prior and prior[0] and prior[0] != key:
            report['conflicts'].append({'job_id': row['job_id'], 'reason': 'multiple_posting_identities'})
            continue
        c.execute('UPDATE jobs SET job_key=? WHERE id=?', (key, row['job_id']))
        c.execute('UPDATE applications SET job_key=? WHERE job_id=?', (key, row['job_id']))
    # Block unmatched historic identities too: future collection must discover
    # these held outcomes before it creates an untouched application.
    for old in retired['historical']:
        target = c.execute('SELECT id FROM jobs WHERE identity=?', (old['identity'],)).fetchone()
        jid = target[0] if target else 'historical:' + hashlib.sha256(old['identity'].encode()).hexdigest()[:24]
        c.execute("INSERT OR IGNORE INTO applications(job_id,status,updated,detail,job_key) VALUES(?,?,?,?,?)",
                  (jid, old['status'], time.time(), old['reference'], migrated_identity(old['identity'])))
        c.execute("UPDATE applications SET status=?,detail=? WHERE job_id=? AND status='not_started'", (old['status'], old['reference'], jid))
    from .migration_duplicate_records import validate_inventory, merge_duplicate_records
    validate_inventory(c, inventory)
    for row in inventory:
        value = records.upsert(c, row, migration=True)
        report['mappings'].append({'old_record_id': row.get('id'), 'application_id': value['id'], 'job_id': value['job_id']})
    report['duplicate_records'], duplicate_jobs = merge_duplicate_records(c, retired, _archive, migration_started=started_at)
    for mapping in report['mappings']:
        mapping['job_id'] = duplicate_jobs.get(mapping['job_id'], mapping['job_id'])
    for old in retired['application_progress']:
        mapped = next((r['application_id'] for r in report['mappings'] if r['old_record_id'] == old['id']), old['id'])
        progress = json.loads(old['payload'])
        progress['application_id'] = mapped
        if not c.execute('SELECT 1 FROM applications WHERE application_id=?',(mapped,)).fetchone():
            c.execute("INSERT INTO applications(job_id,status,updated,application_id,deleted) VALUES(?,'submitted_unconfirmed',?,?,1)",('retired:'+mapped,time.time(),mapped))
        current = state(c, mapped)
        if current and current.get('version', 0) > progress.get('version', 0):
            report['conflicts'].append({'application_id': mapped, 'reason': 'multiple_progress_records'})
            continue
        put(c, progress)
    for old in retired['recruiting_progress']:
        jid = duplicate_jobs.get(old['job_id'], old['job_id'])
        app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        if not app or app['status']!='submitted':continue
        if app['progress'] and json.loads(app['progress']).get('version',0)>0:continue
        records.add_manual(c,jid)
        app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        if not app['application_id']:continue
        progress=records.seed_progress(app['application_id'],'applied' if old['stage']=='received' else old['stage'],'email')
        progress.update(observed_at=old['received_at'],reference=old['message_id'],summary=old['summary'],version=old['version'],receipt_confirmed=old['stage']=='received')
        put(c,progress)
    for old in retired['application_progress_events']:
        mapped = next((r['application_id'] for r in report['mappings'] if r['old_record_id'] == old['application_id']), old['application_id'])
        payload = json.loads(old['payload']); payload['application_id'] = mapped
        c.execute('INSERT OR IGNORE INTO application_events(event_key,application_id,kind,payload,created) VALUES(?,?,?,?,?)',
                  (old['event_key'], mapped, 'progress', json.dumps(payload, ensure_ascii=False), payload.get('recorded_at') or time.time()))
    for old in retired['recruiting_events']:
        jid = duplicate_jobs.get(old['job_id'], old['job_id'])
        app = c.execute('SELECT application_id FROM applications WHERE job_id=?', (jid,)).fetchone()
        c.execute('INSERT OR IGNORE INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,?,?,?)',
                  ('mail:' + old['mailbox'] + ':' + old['message_id'], app[0] if app else None, jid, 'mail', json.dumps(old), old['created']))
    for old in retired['application_progress_pending']:
        c.execute("INSERT OR IGNORE INTO application_events(event_key,kind,payload,created) VALUES(?,'pending',?,?)",
                  ('pending:'+old['job_id'],old['payload'],time.time()))
    for old in retired['extension_receipts']:
        jid = duplicate_jobs.get(old['job_id'], old['job_id'])
        c.execute('''INSERT OR IGNORE INTO application_events(event_key,job_id,kind,payload,created,device_id,checksum,updated,state,result)
            VALUES(?,?,'extension',?,?,?,?,?,?,?)''', (old['event_id'], jid, old['payload'], old['received'], old['device_id'], old['checksum'], old['updated'], old['state'], old['result']))
    # Board outcomes already verified by their existing evidence remain intact.
    c.execute("UPDATE applications SET attempted_at=updated WHERE status IN ('submitted','submitted_unconfirmed') AND attempted_at IS NULL")
    for app in c.execute("SELECT * FROM applications WHERE status='submitted'").fetchall():
        evidence = json.loads(app['evidence'] or '[]')
        confirmed = any(e.get('type') in {'official_success', 'matching_receipt', 'application_history', 'extension_confirmation', 'owner_confirmation'} for e in evidence)
        target_status='submitted' if confirmed else 'submitted_unconfirmed'
        c.execute('UPDATE applications SET status=?,confirmed_at=? WHERE job_id=?', (target_status,(app['confirmed_at'] if app['confirmed_at'] is not None else app['updated']) if confirmed else None, app['job_id']))
        if target_status!=app['status']:report['mappings'].append({'job_id':app['job_id'],'old_status':app['status'],'status':target_status,'reason':'confirmation_evidence_missing'})
    for app in c.execute("SELECT job_id FROM applications WHERE record IS NULL AND status IN ('submitted','submitted_unconfirmed')").fetchall():
        records.add_manual(c,app['job_id'])
    report['applications'] = c.execute('SELECT count(*) FROM applications').fetchone()[0]
    report['records'] = c.execute('SELECT count(*) FROM applications WHERE record IS NOT NULL').fetchone()[0]
    report['events'] = c.execute('SELECT count(*) FROM application_events').fetchone()[0]
    if report['conflicts']:
        raise ValueError('Migration requires identity/progress review: ' + json.dumps(report['conflicts']))
    for name in RETIRED:
        c.execute(f'DROP TABLE IF EXISTS {name}')
    for name in ('management_documents', 'management_revisions'):
        if table_exists(c, name):
            c.execute(f"DELETE FROM {name} WHERE key='appliedList'")
    c.execute('DROP TABLE _migration_application_origins')
    c.execute('INSERT INTO schema_migrations VALUES(?,?,?)', (VERSION, time.time(), json.dumps(report)))
    return report


def migrate_path(path, dry_run=True):
    """Dry-run uses an adjacent disk snapshot; no source writes or RAM copy.

    The database may exceed the service memory limit and /tmp capacity. SQLite
    backup includes WAL content and the adjacent controlled directory has the
    same storage/permissions as the source. Handles close before cleanup.
    """
    target = Path(path)
    if not target.is_file():
        raise ValueError('Existing database required')
    temporary = tempfile.TemporaryDirectory(prefix='.applications-migration-',dir=target.parent) if dry_run else None
    source = None
    c = None
    try:
        source = sqlite3.connect(f'file:{target.resolve().as_posix()}?mode=ro',uri=True) if dry_run else None
        c = sqlite3.connect(Path(temporary.name)/'snapshot.sqlite' if temporary else target)
        if source:
            source.backup(c)
            source.close()
            source=None
        c.row_factory=sqlite3.Row
        c.execute('BEGIN IMMEDIATE')
        report=_migrate(c)
        if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise ValueError('Migrated database integrity failed')
        if dry_run:c.rollback()
        else:c.commit()
        return {**report,'dry_run':dry_run}
    except Exception:
        if c:c.rollback()
        raise
    finally:
        if c:c.close()
        if source:source.close()
        if temporary:temporary.cleanup()
