"""Private, owner-wide Profile storage under the server-owned schema."""
import hashlib
import copy
import json
import secrets
import time
import uuid
from datetime import datetime, timezone


class ProfileConflict(ValueError):
    pass


class Profiles:
    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS profile_grants(device_id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,expires REAL);
              CREATE TABLE IF NOT EXISTS owner_profiles(id TEXT PRIMARY KEY,profile TEXT NOT NULL,last_sync TEXT NOT NULL,deleted INTEGER DEFAULT 0);
              CREATE TABLE IF NOT EXISTS owner_profile_revisions(id TEXT,last_sync TEXT,profile TEXT,created REAL,PRIMARY KEY(id,last_sync));
            ''')

    def grant(self, device_id):
        token = secrets.token_urlsafe(48)
        with self.store.connect(True) as c:
            c.execute('INSERT OR REPLACE INTO profile_grants VALUES(?,?,?)',
                      (device_id, hashlib.sha256(token.encode()).hexdigest(), time.time()+180*86400))
        return token

    def authenticate(self, token):
        if not isinstance(token,str) or len(token)!=64:
            return None
        with self.store.connect() as c:
            row=c.execute('''SELECT g.device_id FROM profile_grants g JOIN extension_devices d ON d.device_id=g.device_id
              WHERE g.token_hash=? AND g.expires>? AND d.expires>? AND d.revoked=0''',
              (hashlib.sha256(token.encode()).hexdigest(),time.time(),time.time())).fetchone()
            return row['device_id'] if row else None

    @staticmethod
    def profile(value):
        from .profile_contract import assert_profile
        return assert_profile(value)

    def list(self):
        with self.store.connect() as connection:
            return [{'id': row['id'], 'profileName': json.loads(row['profile'])['profileName']}
                    for row in connection.execute('SELECT * FROM owner_profiles WHERE deleted=0 ORDER BY rowid')]

    def get(self, profile_id=None, *, include_attachment=True):
        from .profile_contract import VERSION
        identifier = self.identifier(profile_id) if profile_id else None
        with self.store.connect() as connection:
            row = (connection.execute('SELECT * FROM owner_profiles WHERE id=? AND deleted=0', (identifier,)).fetchone()
                   if identifier else connection.execute('SELECT * FROM owner_profiles WHERE deleted=0 ORDER BY rowid LIMIT 1').fetchone())
        if not row:
            raise KeyError('Profile not found')
        profile = self.profile(json.loads(row['profile']))
        if not include_attachment:
            profile.get('resumeData', {}).pop('resumeBase64', None)
        return {'id': row['id'], 'profile': profile, 'last_sync': row['last_sync'], 'schema_version': VERSION}

    def agent_read(self, profile_id=None):
        """Read-only facts; no credential-store access or binary attachment payloads."""
        from .profile_contract import VERSION
        if profile_id:
            return self.get(profile_id, include_attachment=False)
        return {'schema_version': VERSION, 'profiles': self.list()}

    def at_version(self, profile_id, version):
        """Read the exact server revision selected by a page, never a newer version."""
        identifier = self.identifier(profile_id)
        if not isinstance(version, str) or not 1 <= len(version) <= 100:
            raise ValueError('A Profile version is required')
        with self.store.connect() as connection:
            current = connection.execute('SELECT * FROM owner_profiles WHERE id=? AND deleted=0', (identifier,)).fetchone()
            if not current:
                raise ValueError('本页 Profile 不可用')
            if current['last_sync'] == version:
                raw = current['profile']
            else:
                revision = connection.execute('SELECT profile FROM owner_profile_revisions WHERE id=? AND last_sync=?', (identifier, version)).fetchone()
                if not revision:
                    raise ProfileConflict('本页 Profile 版本不可用；请重新读取后继续')
                raw = revision['profile']
        return self.profile(json.loads(raw))

    def save(self, profile, *, profile_id=None, expected_sync=None, allow_create=False, create_only=False):
        from .profile_contract import VERSION
        value = copy.deepcopy(self.profile(profile))
        identifier = self.identifier(profile_id) if profile_id else str(uuid.uuid4())
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True)
        with self.store.connect(True) as connection:
            old = connection.execute('SELECT * FROM owner_profiles WHERE id=?', (identifier,)).fetchone()
            if old:
                if old['deleted']:
                    raise ProfileConflict('此资料已删除；请重新读取资料列表')
                if old['profile'] == raw:
                    return {'id': identifier, 'last_sync': old['last_sync'], 'schema_version': VERSION}
                if create_only:
                    raise ProfileConflict('创建标识已用于另一份资料；本次未覆盖现有资料')
                if expected_sync != old['last_sync']:
                    raise ProfileConflict('另一处已修改这份资料；当前未保存的修改仍在页面中，请重新读取后处理版本冲突')
                connection.execute('INSERT OR IGNORE INTO owner_profile_revisions VALUES(?,?,?,?)',
                                   (identifier, old['last_sync'], old['profile'], time.time()))
            elif profile_id and not allow_create:
                raise KeyError('Profile not found')
            elif connection.execute('SELECT count(*) FROM owner_profiles WHERE deleted=0').fetchone()[0] >= 100:
                raise ValueError('最多保存 100 份资料')
            stamp = datetime.now(timezone.utc).isoformat()
            connection.execute('INSERT INTO owner_profiles VALUES(?,?,?,0) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,last_sync=excluded.last_sync',
                               (identifier, raw, stamp))
        return {'id': identifier, 'last_sync': stamp, 'schema_version': VERSION}

    def delete(self, profile_id, *, expected_sync):
        identifier = self.identifier(profile_id)
        with self.store.connect(True) as connection:
            old = connection.execute('SELECT * FROM owner_profiles WHERE id=?', (identifier,)).fetchone()
            if not old:
                raise KeyError('Profile not found')
            if old['last_sync'] != expected_sync:
                raise ProfileConflict('资料已发生变化；请重新读取后删除')
            following = connection.execute('SELECT id FROM owner_profiles WHERE id!=? AND deleted=0 ORDER BY rowid LIMIT 1', (identifier,)).fetchone()
            if not following:
                raise ValueError('保留至少一份资料')
            if not old['deleted']:
                connection.execute('INSERT OR IGNORE INTO owner_profile_revisions VALUES(?,?,?,?)',
                                   (identifier, old['last_sync'], old['profile'], time.time()))
                connection.execute('UPDATE owner_profiles SET deleted=1 WHERE id=?', (identifier,))
        return self.get(following['id'])

    @staticmethod
    def identifier(value):
        try: return str(uuid.UUID(value))
        except (ValueError,TypeError,AttributeError): raise ValueError('Invalid Profile ID')
