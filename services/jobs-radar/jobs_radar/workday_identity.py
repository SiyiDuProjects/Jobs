"""Resolve public Workday postings from first-party CXS responses.

Only this server-side reader registers identities. Feed/page supplied metadata
cannot establish equivalence. Raw URL keys remain intact for old receipts.
"""
import asyncio
import hashlib
import json
import re
import time
from urllib.parse import quote, unquote, urlsplit

import httpx


def initialize(c):
    c.executescript('''
        CREATE TABLE IF NOT EXISTS workday_postings(
            raw_key TEXT PRIMARY KEY, canonical_key TEXT NOT NULL, url TEXT NOT NULL,
            cxs_url TEXT NOT NULL, posting_id TEXT NOT NULL, title TEXT NOT NULL,
            response_sha256 TEXT NOT NULL, checked_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS workday_postings_canonical ON workday_postings(canonical_key);
        CREATE TABLE IF NOT EXISTS workday_posting_checks(
            url TEXT PRIMARY KEY, checked_at REAL NOT NULL, result TEXT NOT NULL);
    ''')


def endpoint(url):
    """Derive an HTTPS endpoint on an exact Workday-owned tenant host.

    Locale, source parameters and /apply tails are display/navigation details.
    Posting suffixes are preserved. Never follow a source-provided redirect.
    """
    try:
        p = urlsplit(url)
        if (p.scheme != 'https' or p.username or p.password or p.port not in (None, 443)
                or len(url) > 4096 or any(ord(ch) <= 32 for ch in url)):
            return None
        host = (p.hostname or '').lower()
        match = re.fullmatch(r'([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com', host)
        parts = p.path.strip('/').split('/')
        if match:
            tenant = match[1]
            if parts and re.fullmatch(r'[a-z]{2}-[A-Z]{2}', parts[0]):
                parts = parts[1:]
            if len(parts) < 4 or parts[1] != 'job':
                return None
            site, path = parts[0], parts[2:4]
        else:
            # Shared myworkdaysite hosts need a separate tenant-scoped legacy
            # key migration. Their existing keys do not establish tenant scope.
            return None
        if not all(re.fullmatch(r'[A-Za-z0-9_-]+', part) for part in (tenant, site)):
            return None
        decoded = [unquote(part) for part in path]
        if any(not part or part in ('.', '..') or '/' in part or '\\' in part
               or any(ord(ch) < 32 for ch in part) for part in decoded):
            return None
        from .job_match import job_key
        raw = job_key(url)
        if not raw:
            return None
        cxs = f'https://{host}/wday/cxs/{tenant}/{site}/job/' + '/'.join(quote(part, safe='-_,') for part in decoded)
        return dict(raw_key=raw, host=host, tenant=tenant, url=f'https://{host}/{site}/job/' + '/'.join(path), cxs_url=cxs)
    except (TypeError, ValueError):
        return None


async def fetch(client, target):
    async with client.stream('GET', target['cxs_url'], follow_redirects=False, timeout=10,
                             headers={'Accept': 'application/json'}) as response:
        response.raise_for_status()
        if response.status_code != 200:
            raise ValueError('workday_response_status')
        data = bytearray()
        async for chunk in response.aiter_bytes():
            data.extend(chunk)
            if len(data) > 1024 * 1024:
                raise ValueError('workday_response_size')
    info = json.loads(data).get('jobPostingInfo')
    if not isinstance(info, dict):
        raise ValueError('workday_posting_missing')
    req, posting, title = (info.get(k) for k in ('jobReqId', 'id', 'title'))
    if (not isinstance(req, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', req)
            or not isinstance(posting, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,128}', posting)
            or not isinstance(title, str) or not 1 <= len(title.strip()) <= 1000):
        raise ValueError('workday_posting_invalid')
    # Separate namespace: an unfetched URL ending in jobReqId is not proof.
    canonical = json.dumps([target['host'], 'workday', '@official', target['tenant'], req], separators=(',', ':'))
    return {**target, 'canonical_key': canonical, 'posting_id': posting,
            'title': title, 'response_sha256': hashlib.sha256(data).hexdigest(), 'checked_at': time.time()}


def register(c, evidence):
    from .verified_postings import _CANONICAL
    legacy = _CANONICAL.get(evidence['raw_key'])
    official = json.loads(evidence['canonical_key'])
    if legacy and json.loads(legacy)[-1] != official[-1]:
        raise ValueError('workday_identity_changed')
    old = c.execute('SELECT canonical_key FROM workday_postings WHERE raw_key=?', (evidence['raw_key'],)).fetchone()
    if old and old[0] != evidence['canonical_key']:
        # A changed/reused URL needs review; never silently reassign histories.
        raise ValueError('workday_identity_changed')
    c.execute('''INSERT INTO workday_postings VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(raw_key) DO UPDATE SET url=excluded.url,cxs_url=excluded.cxs_url,
        posting_id=excluded.posting_id,title=excluded.title,
        response_sha256=excluded.response_sha256,checked_at=excluded.checked_at''',
        tuple(evidence[k] for k in ('raw_key', 'canonical_key', 'url', 'cxs_url',
                                    'posting_id', 'title', 'response_sha256', 'checked_at')))


async def refresh(store, client, *, limit=200):
    """Bounded incremental reconciliation of all known Workday posting URLs.

    Successful reads are cached for seven days; failures retry after six hours.
    Requests happen outside database transactions. Identity failures leave the
    original postings available and distinct, without failing source collection.
    """
    if not 1 <= limit <= 1000:
        raise ValueError('Workday identity limit must be 1..1000')
    now = time.time()
    with store.connect() as c:
        urls = [r[0] for r in c.execute("SELECT DISTINCT json_extract(payload,'$.apply_url') FROM observations WHERE json_extract(payload,'$.apply_url') IS NOT NULL")]
        checks = {r['url']: dict(r) for r in c.execute('SELECT * FROM workday_posting_checks')}
    targets = {t['cxs_url']: t for url in urls if (t := endpoint(url))}
    due = [t for t in targets.values() if t['cxs_url'] not in checks or now - checks[t['cxs_url']]['checked_at'] >=
           (7 * 86400 if checks[t['cxs_url']]['result'] == 'verified' else 6 * 3600)]
    due.sort(key=lambda t: (checks.get(t['cxs_url'], {}).get('checked_at', 0), t['cxs_url']))
    selected = due[:limit]
    semaphore = asyncio.Semaphore(4)

    async def read(target):
        async with semaphore:
            try:
                async with asyncio.timeout(15):
                    return target, await fetch(client, target), None
            except (TimeoutError, httpx.HTTPError, ValueError, TypeError, AttributeError):
                return target, None, 'unavailable'

    results = await asyncio.gather(*(read(t) for t in selected))
    verified = failed = conflicts = 0
    with store.connect(True) as c:
        for target, evidence, error in results:
            if evidence:
                try:
                    register(c, evidence)
                    verified += 1
                except ValueError:
                    error = 'identity_conflict'
                    conflicts += 1
            else:
                failed += 1
            c.execute('INSERT OR REPLACE INTO workday_posting_checks VALUES(?,?,?)',
                      (target['cxs_url'], now, error or 'verified'))
        from .job_duplicates import consolidate
        keys = {r[0] for r in c.execute('SELECT DISTINCT canonical_key FROM workday_postings')}
        preview = consolidate(c, keys=keys)
    backup = None
    if preview['mergeable']:
        import secrets
        backup = store.backup(store.path.parent / 'identity-backups' / f'workday-{int(now)}-{secrets.token_hex(4)}.sqlite')
        with store.connect(True) as c:
            merged = consolidate(c, False, keys=keys)
    else:
        merged = preview
    return dict(checked=len(selected), verified=verified, unavailable=failed, conflicts=conflicts,
                remaining=max(0, len(due) - len(selected)), merged=merged['mergeable'] if backup else 0,
                held=merged['held'], backup=backup)
