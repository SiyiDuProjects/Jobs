"""Current application schema. Populated legacy databases are never upgraded at startup."""
import json
import time

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
        if not ready and (old_data(c) or c.execute('SELECT 1 FROM applications LIMIT 1').fetchone()):
            raise ValueError('Unsupported legacy application database; restore a verified current-format backup or use the archived migration release')
        create(c)
        from .application_kind import backfill
        backfill(c)
        if not ready:
            c.execute('INSERT INTO schema_migrations VALUES(?,?,?)', (VERSION, time.time(), json.dumps({'initialized': True})))
