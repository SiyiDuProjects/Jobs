"""Content-addressed compressed revisions; old inline JSON remains readable."""
import hashlib
import json
import time
import zlib

PREFIX = 'jobs-zlib-sha256:'


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS management_revision_blobs(
        digest TEXT PRIMARY KEY,payload BLOB NOT NULL,raw_bytes INTEGER NOT NULL)''')


def pack(c, raw):
    data = raw.encode('utf-8')
    if len(data) < 1024:
        return raw
    compressed = zlib.compress(data)
    if len(compressed) + 100 >= len(data):
        return raw
    digest = hashlib.sha256(data).hexdigest()
    inserted = c.execute('INSERT OR IGNORE INTO management_revision_blobs VALUES(?,?,?)', (digest,compressed,len(data))).rowcount
    if not inserted and _blob(c,digest) != data:
        raise ValueError('Management history integrity check failed')
    return PREFIX + digest


def _blob(c, digest):
    row = c.execute('SELECT payload,raw_bytes FROM management_revision_blobs WHERE digest=?', (digest,)).fetchone()
    if row is None:
        raise ValueError('Management history content is missing')
    try:
        data = zlib.decompress(row['payload'])
    except (zlib.error,TypeError):
        raise ValueError('Management history integrity check failed') from None
    if len(data) != row['raw_bytes'] or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Management history integrity check failed')
    return data


def unpack(c, raw):
    return json.loads(_blob(c,raw[len(PREFIX):])) if raw.startswith(PREFIX) else json.loads(raw)


def save(c, key, revision, raw):
    c.execute('INSERT OR IGNORE INTO management_revisions VALUES(?,?,?,?)', (key,revision,pack(c,raw),time.time()))


def compact(c, limit, after=None):
    """Explicit bounded maintenance; verify every transformed revision first."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('History compaction limit must be 1..1000')
    if after is not None and (not isinstance(after, (list,tuple)) or len(after)!=2 or not isinstance(after[0],str) or type(after[1]) is not int or after[1]<0):
        raise ValueError('Invalid history compaction cursor')
    changed = 0
    clause = ' AND (key>? OR (key=? AND revision>?))' if after is not None else ''
    params = (*([after[0],after[0],after[1]] if after is not None else []),limit)
    rows = c.execute('SELECT key,revision,value FROM management_revisions WHERE length(value)>=1024'+clause+' ORDER BY key,revision LIMIT ?', params).fetchall()
    for row in rows:
        replacement = pack(c,row['value'])
        if replacement == row['value']: continue
        if unpack(c,replacement) != json.loads(row['value']):
            raise ValueError('Management history round trip failed')
        c.execute('UPDATE management_revisions SET value=? WHERE key=? AND revision=?', (replacement,row['key'],row['revision']))
        changed += 1
    return {'checked':len(rows),'compacted':changed,'next_cursor':[rows[-1]['key'],rows[-1]['revision']] if len(rows)==limit else None}
