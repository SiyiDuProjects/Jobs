"""Temporary, explicitly prepared Profile/settings-only recovery over complete v2 data.

The previous application's runtime is never started. A sealed snapshot preserves
every table; the active copy keeps all v2 rows and holds application execution.
"""
import base64
from contextlib import contextmanager, closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import time

MODE = 'restricted-profile-settings'
CODE = 'recovery_application_pause'
MESSAGE = '受限恢复模式：投递已暂停；资料和设置仍可使用。未确认的提交请保留，不要重投。'
PREFIX = 'restricted_recovery_'
WRITABLE = {'owner_profiles', 'owner_profile_revisions', 'management_documents', 'management_revisions', 'web_sessions', 'audit'}
SETTING_KEYS = {'settings', 'configList', 'dailyGoal', 'jobsKindProfiles', 'boardCardOrder'}
MAX_DATABASE_BYTES = 2 * 1024**3
MIN_FREE_BYTES = 256 * 1024**2
MAX_ROW_BYTES = 16 * 1024**2


def writable_document(key):
    if key in SETTING_KEYS: return True
    if not isinstance(key, str) or not key.startswith('jobsResponses:'): return False
    from .management import Management
    from .profiles import Profiles
    return Management.valid_key(key) and key.split(':',1)[1] == Profiles.identifier(key.split(':',1)[1])


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def deadline_check(deadline):
    if time.monotonic() >= deadline:
        raise TimeoutError('Restricted recovery preparation deadline exceeded')


def file_hash(path, *, deadline=None):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(256 * 1024), b''):
            if deadline is not None: deadline_check(deadline)
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def connection(path, *, readonly=False, deadline=None):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=2)
    try:
        # Old revision blobs have not necessarily passed today's request
        # limits. Let SQLite reject an oversized row before Python fetches it.
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_ROW_BYTES)
        db.row_factory = sqlite3.Row
        if deadline is not None:
            db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        yield db
        db.commit()
    except BaseException:
        db.set_progress_handler(None, 0)
        db.rollback()
        raise
    finally:
        db.close()


def table_names(db):
    return [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def fingerprint(path, *, deadline=None, selected=None):
    """Constant row-count memory. The backup API retains table rowids/order."""
    deadline = deadline or time.monotonic() + 120
    result = {}
    with connection(path, readonly=True, deadline=deadline) as db:
        if [tuple(row) for row in db.execute('PRAGMA quick_check')] != [('ok',)]:
            raise ValueError('Recovery database integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Recovery database foreign keys failed')
        for name in table_names(db):
            if selected is not None and name not in selected:
                continue
            deadline_check(deadline)
            schema = db.execute('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', (name,)).fetchone()[0]
            info = list(db.execute('PRAGMA table_info(' + quote(name) + ')'))
            order = ','.join(quote(row['name']) for row in sorted(info, key=lambda row: row['pk']) if row['pk']) if 'WITHOUT ROWID' in schema.upper() else 'rowid'
            digest, count = hashlib.sha256(), 0
            for row in db.execute('SELECT * FROM ' + quote(name) + ' ORDER BY ' + order):
                deadline_check(deadline)
                values = [dict(blob=base64.b64encode(value).decode('ascii')) if isinstance(value, bytes) else value for value in row]
                for part in json.JSONEncoder(ensure_ascii=False, separators=(',', ':'), allow_nan=False).iterencode(values):
                    digest.update(part.encode('utf-8'))
                digest.update(b'\n'); count += 1
            result[name] = dict(count=count, sha256=digest.hexdigest())
    return result


def runtime_files():
    root = Path(__file__).parent
    files = {path.relative_to(root).as_posix(): file_hash(path) for path in sorted(root.glob('*.py'))}
    for pattern in ('*.json', 'static/index.html', 'static/board.js', 'static/board.css', 'static/manage/index.html'):
        for path in sorted(root.glob(pattern)):
            files[path.relative_to(root).as_posix()] = file_hash(path)
    if not {'static/board.js', 'static/board.css', 'static/index.html'} <= set(files):
        raise ValueError('Packaged management website is missing')
    return files


def copy_database(source, destination, deadline):
    destination = Path(destination)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    with connection(source, readonly=True, deadline=deadline) as original, closing(sqlite3.connect(destination)) as output:
        def progress(status, remaining, total):
            deadline_check(deadline)
            if total * original.execute('PRAGMA page_size').fetchone()[0] > MAX_DATABASE_BYTES:
                raise ValueError('Recovery database exceeds disk budget')
        original.backup(output, pages=256, progress=progress, sleep=.05)


def guards(db):
    commands = {}
    for table in table_names(db):
        if table in WRITABLE:
            continue
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            name = PREFIX + table + '_' + action
            commands[name] = ('CREATE TRIGGER ' + quote(name) + ' BEFORE ' + action + ' ON ' + quote(table) +
                             " BEGIN SELECT RAISE(ABORT,'recovery_application_pause'); END")
    keys = ','.join("'" + key + "'" for key in sorted(SETTING_KEYS))
    uuid_glob = 'jobsResponses:' + '-'.join('[0-9a-fA-F]' * count for count in (8,4,4,4,12))
    def blocked(prefix):
        field = prefix + '.key'
        return '(' + field + ' IS NULL OR NOT (' + field + ' IN (' + keys + ") OR " + field + " GLOB '" + uuid_glob + "'))"
    for table in ('management_documents', 'management_revisions'):
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            terms = []
            if action != 'DELETE': terms.append(blocked('NEW'))
            if action != 'INSERT': terms.append(blocked('OLD'))
            name = PREFIX + table + '_' + action
            commands[name] = ('CREATE TRIGGER ' + quote(name) + ' BEFORE ' + action + ' ON ' + quote(table) + ' WHEN ' + ' OR '.join(terms) +
                             " BEGIN SELECT RAISE(ABORT,'recovery_application_pause'); END")
    for action in ('INSERT', 'UPDATE', 'DELETE'):
        name = PREFIX + 'audit_' + action
        condition = " WHEN NEW.event IS NOT 'web_login' OR NEW.actor IS NOT 'owner' OR NEW.job_id IS NOT NULL" if action == 'INSERT' else ''
        commands[name] = ('CREATE TRIGGER ' + quote(name) + ' BEFORE ' + action + ' ON audit' + condition +
                         " BEGIN SELECT RAISE(ABORT,'recovery_application_pause'); END")
    return commands


def verify_guards(db):
    expected = guards(db)
    actual = {row['name']: row['sql'] for row in db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE ?", (PREFIX + '%',))}
    if actual != expected:
        raise ValueError('Restricted recovery guards are missing or changed')


def prepare(current, bundle, *, release, image_id, timeout=120):
    if not re.fullmatch(r'[0-9a-f]{12,40}', release) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('Verified release and immutable image ID are required')
    if not 0 < timeout <= 300:
        raise ValueError('Invalid recovery deadline')
    current = Path(current).resolve(strict=True); bundle = Path(bundle).absolute()
    if bundle.exists() or bundle.is_symlink():
        raise FileExistsError('Recovery bundle must be new')
    runtime = runtime_files()
    deadline = time.monotonic() + timeout
    with connection(current, readonly=True, deadline=deadline) as db:
        if not db.execute("SELECT 1 FROM schema_migrations WHERE name='applications-v2'").fetchone():
            raise ValueError('Restricted recovery requires the complete v2 database')
        required = WRITABLE | {'applications', 'application_events', 'owner_submission_undo'}
        if not required <= set(table_names(db)):
            raise ValueError('Restricted recovery tables are incomplete')
        size = db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]
        if size > MAX_DATABASE_BYTES or shutil.disk_usage(bundle.parent).free < size * 3 + MIN_FREE_BYTES:
            raise ValueError('Insufficient recovery disk budget')
    bundle.mkdir(mode=0o700)
    try:
        snapshot, active = bundle/'current-v2.sqlite', bundle/'recovery.sqlite'
        copy_database(current, snapshot, deadline)
        baseline = fingerprint(snapshot, deadline=deadline)
        copy_database(snapshot, active, deadline)
        if fingerprint(active, deadline=deadline) != baseline:
            raise ValueError('Actual recovery restore did not match the complete snapshot')
        with connection(active, deadline=deadline) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM sqlite_master WHERE name LIKE ?", (PREFIX+'%',)).fetchone():
                raise ValueError('Nested restricted recovery is not supported')
            present = set(table_names(db))
            if 'browser_control_sessions' in present:
                db.execute("UPDATE browser_control_sessions SET active=0,pages='[]'")
            if 'browser_control_commands' in present:
                db.execute("UPDATE browser_control_commands SET state=CASE state WHEN 'queued' THEN 'cancelled' WHEN 'dispatched' THEN 'unknown' ELSE state END,args='{}'")
            if 'browser_snapshot_requests' in present:
                db.execute('DELETE FROM browser_snapshot_requests')
            for sql in guards(db).values(): db.execute(sql)
        frozen = fingerprint(active, deadline=deadline, selected=set(baseline)-WRITABLE)
        report = dict(version=1, mode=MODE, release=release, imageId=image_id, runtime=runtime,
                      snapshotSha256=file_hash(snapshot, deadline=deadline), snapshot=baseline, frozen=frozen,
                      restoreProof='all-tables-equal-before-execution-hold', applicationWrites='paused',
                      oldRuntimeStarted=False, activeDatabase='recovery.sqlite', snapshotDatabase='current-v2.sqlite')
        descriptor = os.open(bundle/'manifest.pending', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as out:
            json.dump(report, out, ensure_ascii=False, indent=2); out.flush(); os.fsync(out.fileno())
        os.replace(bundle/'manifest.pending', bundle/'manifest.json')
        sync_directory(bundle)
        return report
    except BaseException:
        (bundle/'FAILED').write_text('Incomplete recovery bundle; no activation is permitted. Originals retained.\n', encoding='utf-8')
        raise


def manifest(bundle, *, verify_runtime=True):
    bundle = Path(bundle).resolve(strict=True)
    if (bundle/'FAILED').exists(): raise ValueError('Recovery preparation failed')
    report = json.loads((bundle/'manifest.json').read_text(encoding='utf-8'))
    if report.get('version') != 1 or report.get('mode') != MODE:
        raise ValueError('Unsupported restricted recovery manifest')
    if verify_runtime and report['runtime'] != runtime_files():
        raise ValueError('Recovery runtime or management webpage differs from the prepared image')
    with connection(bundle/'recovery.sqlite', readonly=True) as db: verify_guards(db)
    return report


@contextmanager
def service_lock(bundle):
    """An OS-released lifetime lock prevents exporting while the server runs."""
    path = Path(bundle)/'service.lock'
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.fstat(descriptor).st_size == 0: os.write(descriptor, b'1')
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Stop the recovery server before export or another start') from error
        yield
    finally:
        os.close(descriptor)


def export_resume(bundle, *, timeout=120):
    """Export the latest active copy, never restore the pre-recovery snapshot."""
    bundle = Path(bundle).resolve(strict=True); report = manifest(bundle)
    if not (bundle/'.pause-profile-writes').is_file():
        raise ValueError('Pause Profile writes before exporting the active recovery database')
    with service_lock(bundle):
        return _export_resume(bundle, report, timeout)


def _export_resume(bundle, report, timeout):
    if not 0 < timeout <= 300: raise ValueError('Invalid recovery deadline')
    deadline = time.monotonic() + timeout
    if fingerprint(bundle/'recovery.sqlite', deadline=deadline, selected=set(report['frozen'])) != report['frozen']:
        raise ValueError('Protected recovery data changed; preserve bundle for review')
    destination, ready = bundle/'resume-v2.sqlite.partial', bundle/'resume-v2.sqlite'
    if ready.exists():
        existing=small_json(bundle/'resume-report.json',256*1024)
        if existing.get('mode')!=MODE or existing.get('resumeDatabase')!='resume-v2.sqlite' or (existing.get('release'),existing.get('imageId'))!=(report['release'],report['imageId']):
            raise ValueError('Existing recovery export identity mismatch')
        if file_hash(ready,deadline=deadline)!=existing.get('sha256') or fingerprint(bundle/'recovery.sqlite',deadline=deadline)!=existing.get('data'):
            raise ValueError('Existing recovery export is not the latest active data')
        return existing
    size = (bundle/'recovery.sqlite').stat().st_size
    if shutil.disk_usage(bundle).free < size + MIN_FREE_BYTES: raise ValueError('Insufficient recovery export disk budget')
    copy_database(bundle/'recovery.sqlite', destination, deadline)
    expected = fingerprint(destination, deadline=deadline)
    if {name: value for name, value in expected.items() if name in report['frozen']} != report['frozen']:
        raise ValueError('Protected recovery data changed during export')
    with connection(destination, deadline=deadline) as db:
        verify_guards(db)
        for name in guards(db): db.execute('DROP TRIGGER ' + quote(name))
    if fingerprint(destination, deadline=deadline) != expected:
        raise ValueError('Resume export lost recovery-period edits')
    digest = file_hash(destination, deadline=deadline)
    os.replace(destination, ready)
    sync_directory(bundle)
    exported = dict(version=1, mode=MODE, release=report['release'], imageId=report['imageId'],
                    resumeDatabase='resume-v2.sqlite', data=expected, sha256=digest)
    publish_json(bundle/'resume-report.json', exported)
    return exported


def sync_directory(path):
    if os.name == 'nt': return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def publish_json(path, value):
    pending = path.with_name(path.name+'.pending')
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor,'w',encoding='utf-8') as output:
        json.dump(value,output,ensure_ascii=False,indent=2); output.flush(); os.fsync(output.fileno())
    # link publishes without replacing an existing intent, even if another
    # operator races the existence check. A failed pending file is retained.
    os.link(pending,path); pending.unlink(); sync_directory(path.parent)


def small_json(path, limit=4096):
    def pairs(items):
        value={}
        for key,item in items:
            if key in value: raise ValueError('Duplicate recovery marker key')
            value[key]=item
        return value
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > limit:
        raise ValueError('Invalid recovery metadata file')
    with path.open('rb') as source: raw=source.read(limit+1)
    if len(raw)>limit: raise ValueError('Recovery metadata is too large')
    value=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite recovery metadata')))
    if not isinstance(value,dict): raise ValueError('Invalid recovery metadata object')
    return value


def scoped_bundle(database, value):
    if not isinstance(value,str) or not re.fullmatch(r'migrations/restricted-[a-f0-9]{12,64}',value):
        raise ValueError('Invalid restricted recovery bundle path')
    data=Path(database).absolute().parent.resolve(strict=True)
    bundle=data/value
    if (data/'migrations').is_symlink() or bundle.is_symlink() or bundle.resolve(strict=True).parent != (data/'migrations').resolve(strict=True):
        raise ValueError('Recovery bundle must remain inside data/migrations')
    for name in ['manifest.json','recovery.sqlite','current-v2.sqlite']:
        if (bundle/name).is_symlink(): raise ValueError('Recovery files must not be symbolic links')
    return bundle


def active_recovery(database):
    """Fail closed before ordinary Store initialization if the marker exists."""
    marker=Path(database).absolute().parent/'.restricted-recovery.json'
    try: marker.lstat()
    except FileNotFoundError: return None
    value=small_json(marker)
    if set(value)!={'version','mode','bundle','release','imageId','manifestSha256'} or type(value['version']) is not int or value['version']!=1 or value['mode']!=MODE:
        raise ValueError('Invalid restricted recovery marker')
    bundle=scoped_bundle(database,value['bundle'])
    if file_hash(bundle/'manifest.json')!=value['manifestSha256']:
        raise ValueError('Recovery marker does not identify this prepared manifest')
    report=manifest(bundle)
    if (value['release'],value['imageId'])!=(report['release'],report['imageId']):
        raise ValueError('Recovery image identity differs from its prepared manifest')
    return bundle


def write_marker(database,bundle,*,release,image_id):
    data=Path(database).absolute().parent.resolve(strict=True)
    bundle=Path(bundle).resolve(strict=True)
    try: relative=bundle.relative_to(data).as_posix()
    except ValueError: raise ValueError('Recovery bundle must be under data/migrations') from None
    bundle=scoped_bundle(database,relative)
    flag=data/'.release-maintenance'
    if flag.is_symlink() or not flag.is_file(): raise ValueError('Keep global release maintenance active')
    report=manifest(bundle)
    if (release,image_id)!=(report['release'],report['imageId']): raise ValueError('Verified recovery image identity mismatch')
    active=active_recovery(database)
    if active is not None:
        if active!=bundle: raise ValueError('Another recovery marker is already active')
        return dict(mode=MODE,marker='.restricted-recovery.json',bundle=relative)
    with service_lock(bundle):
        publish_json(data/'.restricted-recovery.json',dict(version=1,mode=MODE,bundle=relative,
            release=release,imageId=image_id,manifestSha256=file_hash(bundle/'manifest.json')))
    return dict(mode=MODE,marker='.restricted-recovery.json',bundle=relative)


def clear_marker(database,*,timeout=120):
    bundle=active_recovery(database)
    if bundle is None: raise ValueError('Restricted recovery marker is absent')
    global_pause=Path(database).absolute().parent/'.release-maintenance'
    if global_pause.is_symlink() or not global_pause.is_file(): raise ValueError('Keep global release maintenance active')
    if not (bundle/'.pause-profile-writes').is_file(): raise ValueError('Pause Profile writes before resuming applications')
    if not 0<timeout<=300: raise ValueError('Invalid recovery deadline')
    deadline=time.monotonic()+timeout
    with service_lock(bundle):
        report=small_json(bundle/'resume-report.json',256*1024)
        prepared=manifest(bundle)
        if report.get('version')!=1 or report.get('mode')!=MODE or report.get('resumeDatabase')!='resume-v2.sqlite' or (report.get('release'),report.get('imageId'))!=(prepared['release'],prepared['imageId']):
            raise ValueError('Verified latest recovery export is required')
        resume=bundle/'resume-v2.sqlite'
        if resume.is_symlink() or file_hash(resume,deadline=deadline)!=report['sha256']:
            raise ValueError('Recovery resume export changed')
        with connection(database,readonly=True,deadline=deadline) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name LIKE ?",(PREFIX+'%',)).fetchone():
                raise ValueError('The promoted database still has recovery guards')
        if fingerprint(database,deadline=deadline)!=report['data']:
            raise ValueError('Promote the exact latest recovery export before clearing the marker')
        marker=Path(database).absolute().parent/'.restricted-recovery.json'
        marker.unlink(); sync_directory(marker.parent)
    return dict(mode=MODE,markerCleared=True,applicationWrites='still-paused-by-global-maintenance')


class RecoveryStore:
    """No normal Store initialization, migrations, collectors or worker startup."""
    def __init__(self, bundle):
        self.bundle = Path(bundle).resolve(strict=True)
        self.report = manifest(self.bundle)
        self.path = self.bundle/'recovery.sqlite'

    @contextmanager
    def connect(self, write=False):
        with connection(self.path) as db:
            verify_guards(db)
            def authorize(action, one, two, database, trigger):
                if action in {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}:
                    return sqlite3.SQLITE_OK if one in WRITABLE else sqlite3.SQLITE_DENY
                if action in {sqlite3.SQLITE_ALTER_TABLE, sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_TRIGGER,
                              sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH,
                              sqlite3.SQLITE_CREATE_VTABLE, sqlite3.SQLITE_DROP_VTABLE}:
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            if write: db.execute('BEGIN IMMEDIATE')
            yield db
