"""Device-bound, explicit migration journal and private, exact-byte recovery vault.

This facility does not run from ordinary synchronization. Browser deletion is
authorized only by a durable, per-source claim after backup and reconciliation.
"""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import threading
import time
import uuid

from .storage_migration_contract import (
    DEADLINE, LIMITS, MigrationError, canonical, checkpoint, fail, hash_value, identifier, manifest,
    reject_credentials, sha, strict_json, validate_source,
)

_LOCK = threading.RLock()
_UPLOAD_LOCK = threading.Lock()


class StorageMigrations:
    def __init__(self, store, profiles, management, *, vault=None, limits=None):
        self.store, self.profiles, self.management = store, profiles, management
        self.limits = {**LIMITS, **(limits or {})}
        self.vault = Path(vault or store.path.parent / 'storage-migrations').absolute()
        self._directory(self.vault)
        with store.connect(True) as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS installed_migrations(
                    id TEXT PRIMARY KEY, device TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    build TEXT NOT NULL, phase TEXT NOT NULL, created REAL NOT NULL,
                    updated REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
                    backup_id TEXT, server_manifest_hash TEXT, error_code TEXT,
                    pinned INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS installed_migration_entries(
                    migration_id TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL,
                    origin TEXT NOT NULL DEFAULT 'client', uploaded INTEGER NOT NULL DEFAULT 0,
                    nodes INTEGER NOT NULL DEFAULT 0, cleaned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(migration_id,id));
                CREATE TABLE IF NOT EXISTS installed_migration_operations(
                    migration_id TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL,
                    PRIMARY KEY(migration_id,id));
                CREATE TABLE IF NOT EXISTS installed_migration_permits(
                    migration_id TEXT NOT NULL, entry_id TEXT NOT NULL, id TEXT NOT NULL,
                    expires REAL NOT NULL, before_hash TEXT, after_hash TEXT,
                    observed_state TEXT NOT NULL DEFAULT 'present',
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(migration_id,entry_id));
                CREATE TABLE IF NOT EXISTS installed_migration_previews(
                    migration_id TEXT NOT NULL,operation_id TEXT NOT NULL,choice TEXT NOT NULL,
                    metadata TEXT NOT NULL,PRIMARY KEY(migration_id,operation_id,choice));
                CREATE TABLE IF NOT EXISTS installed_migration_archives(
                    id TEXT PRIMARY KEY, device TEXT NOT NULL, manifest_hash TEXT NOT NULL,
                    archive_sha256 TEXT NOT NULL, created REAL NOT NULL);
            ''')

    @staticmethod
    def _directory(path):
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)(): fail()
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not path.is_dir() or os.name == 'posix' and stat.S_IMODE(path.stat().st_mode) & 0o077:
            fail('migration_invalid_source')

    @asynccontextmanager
    async def admission(self):
        # Fail rather than queue unbounded request bodies behind a slow upload.
        if not _UPLOAD_LOCK.acquire(blocking=False):
            raise MigrationError('migration_limit', 503)
        token = DEADLINE.set(time.monotonic() + self.limits['requestTimeoutMs'] / 1000)
        try:
            async with asyncio.timeout(self.limits['requestTimeoutMs'] / 1000):
                yield
        except TimeoutError:
            raise MigrationError('migration_limit', 503) from None
        finally:
            DEADLINE.reset(token)
            _UPLOAD_LOCK.release()

    def _space(self, additional):
        total = 0
        def unreadable(error):
            fail('migration_limit', 413)
        for parent, dirs, files in os.walk(self.vault, followlinks=False, onerror=unreadable):
            checkpoint()
            for name in dirs + files:
                path = Path(parent) / name
                if path.is_symlink() or getattr(path, 'is_junction', lambda: False)(): fail()
            for name in files:
                info = (Path(parent) / name).stat()
                if not stat.S_ISREG(info.st_mode): fail()
                total += info.st_size
        if (total + additional > self.limits['maxVaultBytesIncludingTemporaryCopies'] or
                shutil.disk_usage(self.vault).free - additional < self.limits['minimumFreeBytes']):
            fail('migration_limit', 413)

    def _path(self, mid, name):
        identifier(mid)
        directory = self.vault / mid
        self._directory(directory)
        if name.endswith(('.backup', '.restore')):
            directory /= 'backup' if name.endswith('.backup') else 'restore'
            self._directory(directory)
        path = directory / name
        if path.parent != directory or path.is_symlink(): fail()
        return path

    @staticmethod
    def _fsync_directory(path):
        if os.name == 'posix':
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try: os.fsync(descriptor)
            finally: os.close(descriptor)

    def _write(self, path, data):
        checkpoint()
        self._space(len(data))
        temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(8))
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, path)
            self._fsync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def _hash_file(self, path, *, deadline=None):
        if path.is_symlink() or not path.is_file(): fail('migration_restore_unverified')
        digest, size = hashlib.sha256(), 0
        with path.open('rb') as source:
            for block in iter(lambda: source.read(256 * 1024), b''):
                checkpoint()
                if deadline and time.monotonic() > deadline: fail('migration_limit', 503)
                size += len(block); digest.update(block)
                if size > self.limits['maxEntryBytes']: fail('migration_limit', 413)
        return size, digest.hexdigest()

    def _copy(self, source, destination, metadata, deadline):
        if destination.exists():
            if self._hash_file(destination, deadline=deadline) != (metadata['size'], metadata['sha256']):
                fail('migration_restore_unverified')
            return
        self._space(metadata['size'])
        if source.is_symlink(): fail()
        temporary = destination.with_name('.' + destination.name + '.partial')
        # A previous interrupted copy is not evidence. Its bytes remain counted
        # until this known private staging file is safely replaced.
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            digest, size = hashlib.sha256(), 0
            with source.open('rb') as incoming, os.fdopen(descriptor, 'wb') as target:
                for block in iter(lambda: incoming.read(256 * 1024), b''):
                    checkpoint()
                    if time.monotonic() > deadline: fail('migration_limit', 503)
                    size += len(block)
                    if size > metadata['size']: fail('migration_source_changed')
                    digest.update(block); target.write(block)
                if (size, digest.hexdigest()) != (metadata['size'], metadata['sha256']): fail('migration_source_changed')
                target.flush(); os.fsync(target.fileno())
            os.replace(temporary, destination); self._fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def _session(self, c, device, mid):
        identifier(mid)
        row = c.execute('SELECT * FROM installed_migrations WHERE id=? AND device=?', (mid, device)).fetchone()
        if row is None: fail('migration_owner_mismatch', 404)
        return row

    def _entries(self, c, mid, origin=None):
        query = 'SELECT * FROM installed_migration_entries WHERE migration_id=?'
        args = [mid]
        if origin: query += ' AND origin=?'; args.append(origin)
        return [dict(row, metadata=json.loads(row['metadata'])) for row in c.execute(query + ' ORDER BY rowid', args)]

    def _match(self, row, digest):
        if row['manifest_hash'] != digest: fail('migration_manifest_conflict')
        if row['phase'] == 'superseded': fail('migration_source_changed')

    def status(self, device, mid):
        with self.store.connect() as c:
            row = self._session(c, device, mid)
            entries = self._entries(c, mid)
        result = dict(migrationId=mid, deviceId=device, manifestHash=row['manifest_hash'], clientBuild=row['build'],
                      phase=row['phase'], uploaded=[e['id'] for e in entries if e['uploaded'] and e['origin'] == 'client'],
                      cleaned=[e['id'] for e in entries if e['cleaned'] and e['origin'] == 'client'])
        if row['revision']: result['planRevision'] = row['revision']
        if row['error_code']: result['errorCode'] = row['error_code']
        if row['backup_id']:
            result['backup'] = dict(backupId=row['backup_id'], migrationId=mid, deviceId=device,
                manifestHash=row['manifest_hash'], durable=True, restoreVerified=True,
                entries=[{k: e['metadata'][k] for k in ('entryId', 'size', 'sha256')} for e in entries if e['origin'] == 'client'],
                serverManifestHash=row['server_manifest_hash'], serverEntries=[
                    {k: e['metadata'][k] for k in ('key', 'revision', 'size', 'sha256')} for e in entries if e['origin'] == 'server'])
        return result

    def create(self, device, text, digest):
        if not isinstance(device, str) or not 1 <= len(device) <= 200: fail('migration_auth_required', 401)
        value = manifest(text, digest); mid = value['migrationId']
        with _LOCK, self.store.connect(True) as c:
            if c.execute('SELECT 1 FROM installed_migration_archives WHERE id=?', (mid,)).fetchone():
                fail('migration_manifest_conflict')
            old = c.execute('SELECT * FROM installed_migrations WHERE id=?', (mid,)).fetchone()
            if old:
                if old['device'] != device or old['manifest_hash'] != digest: fail('migration_manifest_conflict')
                if self._path(mid, 'manifest.json').read_bytes() != text.encode(): fail('migration_manifest_conflict')
            else:
                sessions = c.execute('SELECT phase FROM installed_migrations WHERE device=?', (device,)).fetchall()
                if len(sessions) >= self.limits['maxRetainedSessionsPerDevice']: fail('migration_limit', 413)
                if any(r['phase'] not in {'complete', 'superseded'} for r in sessions): fail('migration_required_input')
                self._write(self._path(mid, 'manifest.json'), text.encode('utf-8'))
                stamp = time.time()
                c.execute('INSERT INTO installed_migrations(id,device,manifest_hash,build,phase,created,updated) VALUES(?,?,?,?,?,?,?)',
                          (mid, device, digest, value['clientBuild'], 'receiving', stamp, stamp))
                for entry in value['entries']:
                    c.execute('INSERT INTO installed_migration_entries(migration_id,id,metadata) VALUES(?,?,?)',
                              (mid, entry['entryId'], canonical(entry).decode()))
        return self.status(device, mid)

    def upload(self, device, mid, eid, text, size, digest):
        identifier(eid)
        if not isinstance(text, str): fail()
        raw = text.encode('utf-8'); value, nodes = strict_json(raw)
        with _LOCK, self.store.connect(True) as c:
            session = self._session(c, device, mid)
            row = c.execute('SELECT * FROM installed_migration_entries WHERE migration_id=? AND id=? AND origin=\'client\'', (mid, eid)).fetchone()
            if not row: fail()
            entry = json.loads(row['metadata'])
            if type(size) is not int or size != len(raw) or digest != sha(raw) or (size, digest) != (entry['size'], entry['sha256']): fail('migration_source_changed')
            validate_source(entry['storageKey'], value, pointer=entry.get('pointer'))
            if entry['storageArea'] == 'session' and entry['storageKey'] == 'jobsManagementBaseV1':
                allowed = {e['metadata']['storageKey'] for e in self._entries(c, mid, 'client')
                           if e['metadata']['storageArea'] == 'session' and e['metadata']['storageKey'].startswith('jobsResponses:')}
                if set(value) - allowed: fail('migration_invalid_source')
            if row['uploaded']:
                if self._hash_file(self._path(mid, eid + '.json')) != (size, digest): fail('migration_source_changed')
            else:
                if session['phase'] != 'receiving': fail('migration_required_input')
                total = c.execute('SELECT coalesce(sum(nodes),0) FROM installed_migration_entries WHERE migration_id=?', (mid,)).fetchone()[0]
                if total + nodes > self.limits['maxTotalJsonNodes']: fail('migration_limit', 413)
                self._write(self._path(mid, eid + '.json'), raw)
                c.execute('UPDATE installed_migration_entries SET uploaded=1,nodes=? WHERE migration_id=? AND id=?', (nodes, mid, eid))
        return dict(migrationId=mid, entryId=eid, size=size, sha256=digest, stored=True)

    def read_entry(self, mid, entry):
        path = self._path(mid, entry['entryId'] + '.json')
        if self._hash_file(path) != (entry['size'], entry['sha256']): fail('migration_source_changed')
        with path.open('rb') as stream:
            return strict_json(stream.read(self.limits['maxEntryBytes'] + 1))[0]

    def _capture_server(self, c, mid):
        # Capture only the two demonstrated containers. Original database JSON
        # bytes are retained unchanged, not reconstructed from parsed fields.
        for key in ('settings', 'configList'):
            checkpoint()
            old = c.execute('SELECT * FROM management_documents WHERE key=?', (key,)).fetchone()
            if not old: continue
            raw = old['value'].encode('utf-8'); value, nodes = strict_json(raw)
            reject_credentials(value)
            configs = [value] if key == 'settings' else value
            if not isinstance(configs, list) or any(not isinstance(v, dict) for v in configs): fail()
            if any(isinstance(v.get('premiumSettings'), dict) and 'responseContext' in v['premiumSettings'] and not isinstance(v['premiumSettings']['responseContext'], str) for v in configs): fail()
            if not any(isinstance(v.get('premiumSettings'), dict) and v['premiumSettings'].get('responseContext') for v in configs): continue
            eid = str(uuid.uuid5(uuid.UUID(mid), 'server:' + key))
            prior = c.execute('SELECT metadata FROM installed_migration_entries WHERE migration_id=? AND id=?', (mid, eid)).fetchone()
            if prior: continue
            entries = self._entries(c, mid)
            if (len(entries) + 1 > self.limits['maxEntries'] or sum(e['metadata']['size'] for e in entries) + len(raw) > self.limits['maxTotalBytes']
                    or sum(e['nodes'] for e in entries) + nodes > self.limits['maxTotalJsonNodes']): fail('migration_limit', 413)
            metadata = dict(entryId=eid, key=key, revision=old['revision'], size=len(raw), sha256=sha(raw))
            self._write(self._path(mid, eid + '.json'), raw)
            c.execute('INSERT INTO installed_migration_entries(migration_id,id,metadata,origin,uploaded,nodes) VALUES(?,?,?,\'server\',1,?)',
                      (mid, eid, canonical(metadata).decode(), nodes))

    def seal(self, device, mid, digest):
        deadline = time.monotonic() + self.limits['requestTimeoutMs'] / 1000
        with _LOCK, self.store.connect(True) as c:
            session = self._session(c, device, mid); self._match(session, digest)
            if not session['backup_id']:
                if session['phase'] != 'receiving': fail('migration_required_input')
                if any(not e['uploaded'] for e in self._entries(c, mid)): fail('migration_incomplete_backup')
                self._capture_server(c, mid)
                entries = self._entries(c, mid)
                server_manifest = canonical([e['metadata'] for e in entries if e['origin'] == 'server'])
                self._write(self._path(mid, 'server-manifest.json'), server_manifest)
                for entry in entries:
                    checkpoint()
                    meta = entry['metadata']; source = self._path(mid, entry['id'] + '.json')
                    backup = self._path(mid, entry['id'] + '.backup')
                    restore = self._path(mid, entry['id'] + '.restore')
                    self._copy(source, backup, meta, deadline)
                    try:
                        self._copy(backup, restore, meta, deadline)
                        if self._hash_file(restore, deadline=deadline) != (meta['size'], meta['sha256']): fail('migration_restore_unverified')
                    finally:
                        restore.unlink(missing_ok=True)
                c.execute('UPDATE installed_migrations SET backup_id=?,server_manifest_hash=?,phase=\'backed_up\',updated=? WHERE id=?',
                          (str(uuid.uuid4()), sha(server_manifest), time.time(), mid))
        return self.status(device, mid)

    def supersede(self, device, mid, digest, replacement):
        identifier(replacement)
        with _LOCK, self.store.connect(True) as c:
            row = self._session(c, device, mid); self._match(row, digest)
            if replacement == mid or row['phase'] in {'cleaning', 'complete'}: fail('migration_required_input')
            if (c.execute('SELECT 1 FROM installed_migrations WHERE id=?', (replacement,)).fetchone() or
                    c.execute('SELECT 1 FROM installed_migration_archives WHERE id=?', (replacement,)).fetchone()):
                fail('migration_manifest_conflict')
            if c.execute('SELECT count(*) FROM installed_migrations WHERE device=?', (device,)).fetchone()[0] >= self.limits['maxRetainedSessionsPerDevice']:
                fail('migration_limit', 413)
            c.execute('UPDATE installed_migrations SET phase=\'superseded\',updated=? WHERE id=?', (time.time(), mid))
            c.execute('DELETE FROM installed_migration_permits WHERE migration_id=?', (mid,))
        return self.status(device, mid)

    def _verify_incomplete_archive(self, device, mid, digest, snapshot, archive, deadline, *, sealed=False):
        """Read recovery copies back; original files stay in the counted vault."""
        session, entries = snapshot['session'], snapshot['entries']
        if (snapshot.get('version') != 1 or session['id'] != mid or session['device'] != device or
                session['manifest_hash'] != digest or session['phase'] != 'superseded' or
                session['backup_id'] or session['server_manifest_hash']):
            fail('migration_restore_unverified')
        if len(entries) > self.limits['maxEntries']: fail('migration_limit', 413)
        original = self._path(mid, 'manifest.json')
        size, observed = self._hash_file(original, deadline=deadline)
        if observed != digest or size > self.limits['maxManifestBytes']: fail('migration_restore_unverified')
        document = manifest(original.read_bytes().decode('utf-8'), digest)
        client_entries = [json.loads(row['metadata']) for row in entries if row['origin'] == 'client']
        if document['migrationId'] != mid or document['clientBuild'] != session['build'] or document['entries'] != client_entries:
            fail('migration_restore_unverified')
        files = [('manifest.json', dict(size=size, sha256=digest))]
        nodes = total_bytes = uploaded = 0
        seen = set()
        for row in entries:
            checkpoint(); identifier(row['id'])
            if (row['migration_id'] != mid or row['id'] in seen or row['cleaned'] or
                    row['origin'] not in {'client', 'server'} or row['uploaded'] not in {0, 1}):
                fail('migration_restore_unverified')
            seen.add(row['id'])
            meta, _ = strict_json(row['metadata'], max_bytes=self.limits['maxEntryBytes'], max_nodes=self.limits['maxJsonNodes'])
            if meta['entryId'] != row['id'] or type(meta['size']) is not int or not 0 <= meta['size'] <= self.limits['maxEntryBytes']:
                fail('migration_restore_unverified')
            hash_value(meta['sha256']); total_bytes += meta['size']
            if total_bytes > self.limits['maxTotalBytes']: fail('migration_limit', 413)
            if not row['uploaded']: continue
            source = self._path(mid, row['id'] + '.json')
            if self._hash_file(source, deadline=deadline) != (meta['size'], meta['sha256']):
                fail('migration_restore_unverified')
            _, count = strict_json(source.read_bytes(), max_bytes=self.limits['maxEntryBytes'], max_nodes=self.limits['maxJsonNodes'])
            if count != row['nodes']: fail('migration_restore_unverified')
            nodes += count; uploaded += 1
            if nodes > self.limits['maxTotalJsonNodes']: fail('migration_limit', 413)
            files.append((row['id'] + '.json', meta))
        raw = canonical(snapshot)
        strict_json(raw, max_bytes=self.limits['maxEntryBytes'], max_nodes=self.limits['maxJsonNodes'])
        files.append(('snapshot.json', dict(size=len(raw), sha256=sha(raw))))
        for name, meta in files:
            checkpoint()
            target = archive / name
            if target.is_symlink(): fail('migration_restore_unverified')
            if sealed and not target.is_file(): fail('migration_restore_unverified')
            if name == 'snapshot.json':
                if not target.exists(): self._write(target, raw)
            else:
                self._copy(self._path(mid, name), target, meta, deadline)
            if self._hash_file(target, deadline=deadline) != (meta['size'], meta['sha256']):
                fail('migration_restore_unverified')
            restored = archive / ('.' + name + '.restore')
            try:
                self._copy(target, restored, meta, deadline)
                if self._hash_file(restored, deadline=deadline) != (meta['size'], meta['sha256']):
                    fail('migration_restore_unverified')
            finally:
                restored.unlink(missing_ok=True)
        checkpoint()
        return dict(migrationId=mid, archived=True, archiveSha256=sha(raw), restoreVerified=True,
                    entries=len(entries), uploaded=uploaded)

    def archive_superseded_incomplete(self, device, mid, digest, *, administrator=False):
        """Explicit local administration only; deliberately has no HTTP route.

        Retire an unsealed, unused superseded journal only after exact recovery
        copies pass. Its immutable tombstone and original vault bytes remain.
        """
        if administrator is not True: fail('migration_auth_required', 403)
        identifier(mid); hash_value(digest)
        deadline = time.monotonic() + self.limits['requestTimeoutMs'] / 1000
        if DEADLINE.get() is not None: deadline = min(deadline, DEADLINE.get())
        token = DEADLINE.set(deadline)
        try:
            checkpoint()
            with _LOCK, self.store.connect(True) as c:
                prior = c.execute('SELECT * FROM installed_migration_archives WHERE id=?', (mid,)).fetchone()
                if prior:
                    if prior['device'] != device: fail('migration_owner_mismatch', 404)
                    if prior['manifest_hash'] != digest: fail('migration_manifest_conflict')
                    archive = self._path(mid, 'archive'); self._directory(archive)
                    saved = archive / 'snapshot.json'
                    if self._hash_file(saved, deadline=deadline)[1] != prior['archive_sha256']:
                        fail('migration_restore_unverified')
                    snapshot, _ = strict_json(saved.read_bytes(), max_bytes=self.limits['maxEntryBytes'], max_nodes=self.limits['maxJsonNodes'])
                    return self._verify_incomplete_archive(device, mid, digest, snapshot, archive, deadline, sealed=True)
                session = self._session(c, device, mid)
                if session['manifest_hash'] != digest: fail('migration_manifest_conflict')
                if session['phase'] != 'superseded' or session['backup_id'] or session['server_manifest_hash']:
                    fail('migration_required_input')
                for table in ('installed_migration_operations', 'installed_migration_permits', 'installed_migration_previews'):
                    if c.execute('SELECT 1 FROM ' + table + ' WHERE migration_id=? LIMIT 1', (mid,)).fetchone():
                        fail('migration_required_input')
                entries = [dict(row) for row in c.execute(
                    'SELECT * FROM installed_migration_entries WHERE migration_id=? ORDER BY rowid LIMIT ?',
                    (mid, self.limits['maxEntries'] + 1))]
                if len(entries) > self.limits['maxEntries']: fail('migration_limit', 413)
                if any(row['cleaned'] for row in entries): fail('migration_required_input')
                snapshot = dict(version=1, session=dict(session), entries=entries)
                archive = self._path(mid, 'archive'); self._directory(archive)
                result = self._verify_incomplete_archive(device, mid, digest, snapshot, archive, deadline)
                checkpoint()
                c.execute('INSERT INTO installed_migration_archives VALUES(?,?,?,?,?)',
                          (mid, device, digest, result['archiveSha256'], time.time()))
                c.execute('DELETE FROM installed_migration_entries WHERE migration_id=?', (mid,))
                c.execute('DELETE FROM installed_migrations WHERE id=?', (mid,))
            return result
        finally:
            DEADLINE.reset(token)

    def plan(self, device, mid):
        from .storage_migration_plan import plan
        with _LOCK: return plan(self, device, mid)

    def preview(self, device, mid, conflict, choice, cursor=None):
        from .storage_migration_preview import preview
        with _LOCK: return preview(self, device, mid, conflict, choice, cursor)

    def resolve(self, device, mid, revision, conflict, choice, preview_id=None):
        from .storage_migration_plan import resolve
        with _LOCK: return resolve(self, device, mid, revision, conflict, choice, preview_id)

    def apply(self, device, mid, revision, digest):
        from .storage_migration_plan import apply
        with _LOCK: return apply(self, device, mid, revision, digest)

    def verify(self, device, mid, digest):
        from .storage_migration_plan import verify
        with _LOCK: return verify(self, device, mid, digest)

    def claim(self, device, mid, eid, digest, source_hash, build, before=None, observed='present'):
        identifier(eid)
        # Re-read every authoritative destination before issuing a new claim.
        self.verify(device, mid, digest)
        with _LOCK, self.store.connect(True) as c:
            row = self._session(c, device, mid); self._match(row, digest)
            if row['phase'] not in {'ready_to_clean', 'cleaning'} or row['build'] != build: fail('migration_permit_invalid')
            entry = next((e for e in self._entries(c, mid, 'client') if e['id'] == eid), None)
            if not entry: fail('migration_permit_invalid')
            meta = entry['metadata']
            if meta['sha256'] != source_hash or meta['disposition'] == 'retain_identity': fail('migration_permit_invalid')
            if observed not in {'present', 'session_absent'} or observed == 'session_absent' and meta['storageArea'] != 'session': fail('migration_permit_invalid')
            old = c.execute('SELECT * FROM installed_migration_permits WHERE migration_id=? AND entry_id=?', (mid, eid)).fetchone()
            if old and old['acknowledged']: fail('migration_ack_conflict')
            transition = old and old['observed_state'] == 'present' and observed == 'session_absent'
            if old and old['observed_state'] != observed and not transition: fail('migration_permit_invalid')
            if meta.get('pointer'):
                siblings = {e['id'] for e in self._entries(c, mid, 'client') if e['metadata']['storageKey'] == meta['storageKey']}
                claims = [r for r in c.execute('SELECT * FROM installed_migration_permits WHERE migration_id=? ORDER BY rowid', (mid,)) if r['entry_id'] in siblings]
                if any(not r['acknowledged'] and r['entry_id'] != eid for r in claims): fail('migration_writer_active')
                expected = next((r['after_hash'] for r in reversed(claims) if r['acknowledged']), meta['containerSha256'])
                if before != expected: fail('migration_source_changed')
            elif before is not None: fail()
            permit_id = old['id'] if old and not transition else secrets.token_urlsafe(32)
            expires = time.time() + self.limits['permitLifetimeSeconds']
            c.execute('INSERT INTO installed_migration_permits(migration_id,entry_id,id,expires,before_hash,observed_state) VALUES(?,?,?,?,?,?) '
                      'ON CONFLICT(migration_id,entry_id) DO UPDATE SET id=excluded.id,expires=excluded.expires,observed_state=excluded.observed_state', (mid, eid, permit_id, expires, before, observed))
            c.execute('UPDATE installed_migrations SET phase=\'cleaning\',updated=? WHERE id=?', (time.time(), mid))
            result = dict(permitId=permit_id, migrationId=mid, deviceId=device, manifestHash=digest, clientBuild=build,
                          backupId=row['backup_id'], entryId=eid, selector=meta['selector'], sha256=source_hash,
                          disposition=meta['disposition'], observedState=observed, expiresAt=int(expires * 1000))
            if before is not None: result['containerBeforeSha256'] = before
            return result

    def ack(self, device, mid, eid, permit, digest, result, after=None):
        with _LOCK, self.store.connect(True) as c:
            row = self._session(c, device, mid); self._match(row, digest)
            claim = c.execute('SELECT * FROM installed_migration_permits WHERE migration_id=? AND entry_id=? AND id=?', (mid, eid, permit)).fetchone()
            if not claim: fail('migration_permit_invalid')
            expected = 'session_expired' if claim['observed_state'] == 'session_absent' else 'path_absent' if claim['before_hash'] else 'absent'
            if result != expected or (expected != 'path_absent' and after is not None): fail('migration_ack_conflict')
            if expected == 'path_absent': hash_value(after)
            if claim['acknowledged'] and claim['after_hash'] != after: fail('migration_ack_conflict')
            c.execute('UPDATE installed_migration_permits SET acknowledged=1,after_hash=? WHERE migration_id=? AND entry_id=?', (after, mid, eid))
            c.execute('UPDATE installed_migration_entries SET cleaned=1 WHERE migration_id=? AND id=?', (mid, eid))
        return self.status(device, mid)

    def complete(self, device, mid, digest, remaining):
        if type(remaining) is not int or remaining != 0: fail('migration_required_input')
        with self.store.connect() as c:
            row = self._session(c, device, mid); self._match(row, digest)
            if row['phase'] == 'complete': return self.status(device, mid)
        self.verify(device, mid, digest)
        with _LOCK, self.store.connect(True) as c:
            row = self._session(c, device, mid); self._match(row, digest)
            if row['phase'] not in {'ready_to_clean', 'cleaning', 'complete'}: fail('migration_required_input')
            if any(not e['cleaned'] and e['metadata']['disposition'] != 'retain_identity' for e in self._entries(c, mid, 'client')):
                fail('migration_required_input')
            c.execute('UPDATE installed_migrations SET phase=\'complete\',pinned=0,updated=? WHERE id=?', (time.time(), mid))
        return self.status(device, mid)
