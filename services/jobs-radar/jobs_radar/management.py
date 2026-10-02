"""Private management documents. Explicit keys, optimistic writes and revision history.

The existing Radar application ledger is NOT replaced by an imported extension list.
Application records project their submitted state onto matching existing jobs.
"""
import json
import re
import time
import hashlib
from .profiles import ProfileConflict, Profiles


class Management:
    KEYS = {'boardCardOrder', 'settings', 'configList', 'dailyGoal', 'jobsKindProfiles'}

    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS management_documents(key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS management_revisions(key TEXT,revision INTEGER,value TEXT NOT NULL,created REAL,PRIMARY KEY(key,revision));
            ''')

    @classmethod
    def valid_key(cls, key):
        if key in cls.KEYS:
            return True
        if isinstance(key, str) and key.startswith('jobsResponses:'):
            try:
                Profiles.identifier(key.split(':', 1)[1])
                return True
            except ValueError:
                pass
        return False

    def validate(self, key, value):
        if not self.valid_key(key):
            raise ValueError('Unsupported management data')
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
        if len(raw.encode()) > 12*1024*1024:
            raise ValueError('Management document too large')
        def inspect(item):
            if isinstance(item, dict):
                if any(k.lower() in {'password', 'accountpassword', 'token', 'api_key', 'apikey', 'profiletoken'} for k in item):
                    raise ValueError('Credentials must remain on this browser')
                for v in item.values(): inspect(v)
            elif isinstance(item, list):
                for v in item: inspect(v)
        inspect(value)
        if key == 'configList' or key.startswith('jobsResponses:'):
            if not isinstance(value, list): raise ValueError('Expected a list')
        if key.startswith('jobsResponses:'):
            from .saved_responses import normalize_list
            with self.store.connect() as c:
                previous = c.execute('SELECT value FROM management_documents WHERE key=?', (key,)).fetchone()
            value = normalize_list(value, json.loads(previous['value']) if previous else [])
            raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
        if key in {'settings','boardCardOrder','jobsKindProfiles'} and not isinstance(value,dict):
            raise ValueError('Expected an object')
        if key == 'dailyGoal' and (type(value) is not int or not 1 <= value <= 999): raise ValueError('Invalid daily goal')
        if key == 'jobsKindProfiles':
            if set(value)-{'intern','newgrad'}: raise ValueError('Invalid job kind')
            for pid in value.values():
                Profiles.identifier(pid)
                with self.store.connect() as c:
                    if not c.execute('SELECT 1 FROM owner_profiles WHERE id=? AND deleted=0',(pid,)).fetchone(): raise ValueError('Profile unavailable')
        return raw

    def snapshot(self):
        with self.store.connect() as c:
            result={r['key']: {'value': json.loads(r['value']), 'revision': r['revision']} for r in c.execute('SELECT * FROM management_documents')}
            from .application_progress import pending_reviews, project_display
            from .application_records import read
            result['appliedList']={'value':project_display(c,read(c)),'revision':0}
            pending=pending_reviews(c)
            if pending: result['applicationProgressReview']={'value':pending,'revision':0}
            return result

    @staticmethod
    def _contexts(key, value):
        containers = [('', value)] if key == 'settings' else [(str(i), item) for i, item in enumerate(value or [])] if key == 'configList' else []
        result = {}
        for index, container in containers:
            if not isinstance(container, dict): continue
            premium = container.get('premiumSettings')
            if isinstance(premium, dict) and premium.get('responseContext'):
                result[('/' + index if index else '') + '/premiumSettings/responseContext'] = premium['responseContext']
        return result

    @staticmethod
    def _context_hash(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

    def write(self, changes, *, context_removals=None, return_snapshot=True):
        if not isinstance(changes,list) or len(changes)>120: raise ValueError('Invalid changes')
        checked=[]
        for item in changes:
            if not isinstance(item,dict) or type(item.get('revision')) is not int or item['revision']<0: raise ValueError('Invalid revision')
            checked.append((item['key'], self.validate(item['key'],item.get('value')), item['revision']))
        if len({k for k,_,_ in checked})!=len(checked): raise ValueError('Duplicate keys')
        if context_removals is not None and (not isinstance(context_removals, dict) or set(context_removals) - {k for k, _, _ in checked}):
            raise ValueError('Invalid context migration')
        with self.store.connect(True) as c:
            # Check the entire batch before writing anything.
            for key,raw,rev in checked:
                old=c.execute('SELECT * FROM management_documents WHERE key=?',(key,)).fetchone()
                before = self._contexts(key, json.loads(old['value']) if old else None)
                after = self._contexts(key, json.loads(raw))
                removals = (context_removals or {}).get(key, {})
                if not isinstance(removals, dict): raise ValueError('Invalid context migration')
                for path, digest in removals.items():
                    if path not in before or path in after or self._context_hash(before[path]) != digest:
                        raise ProfileConflict('旧补充说明发生变化，请重新核对迁移')
                if {path: value for path, value in before.items() if path not in removals} != after:
                    raise ProfileConflict('旧补充说明需要先完成资料迁移，当前设置未保存')
                if old and old['value']==raw: continue
                if (old['revision'] if old else 0)!=rev:
                    raise ProfileConflict('内容已在另一处修改；当前修改已保留，请刷新同步后重试')
            for key,raw,rev in checked:
                old=c.execute('SELECT * FROM management_documents WHERE key=?',(key,)).fetchone()
                if old and old['value']==raw: continue
                if old:
                    c.execute('INSERT OR IGNORE INTO management_revisions VALUES(?,?,?,?)',(key,old['revision'],old['value'],time.time()))
                c.execute('INSERT INTO management_documents VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision',(key,raw,rev+1))
        return self.snapshot() if return_snapshot else {'written': [key for key, _, _ in checked]}
