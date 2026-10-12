"""Persistent, rebuildable browsing fields. Application state stays in its ledger.

Source/title writes enqueue affected jobs through SQLite triggers. Store commits
rebuild those jobs in the same transaction, including writes from other processes.
Reads do no classification or source decoding. Future-dated sources are rebuilt
when they enter the discovery window; no TTL or response cache is involved.
"""
import json
import time
import hashlib
from pathlib import Path

from .geography import matches_region, non_us_only, screening_locations
from .intern_companies import normalize_company
from .role_families import classify
from .scope import STREAM_IDS

# Derived browsing rules are rebuilt once after a code change, including a
# rollback. No deployment needs to remember to flush an in-memory cache.
VERSION = 'board-index-v1:' + hashlib.sha256(b''.join(
    Path(__file__).with_name(name).read_bytes()
    for name in ('board_index.py','board.py','geography.py','role_families.py',
                 'intern_companies.py','scope.py','profile.schema.json')
)).hexdigest()


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS board_jobs(
        job_id TEXT, kind TEXT, active INTEGER, company_key TEXT, company_fold TEXT,
        title TEXT, text_search TEXT, location_search TEXT, foreign_only INTEGER,
        ca INTEGER, ca_remote INTEGER, focus_remote INTEGER, engineering INTEGER,
        data_engineering INTEGER, family TEXT, basis TEXT, fingerprint TEXT,
        added_at REAL, sort_at REAL, payload TEXT, PRIMARY KEY(job_id,kind))''')
    c.execute('CREATE INDEX IF NOT EXISTS board_jobs_added ON board_jobs(kind,active,added_at DESC,job_id)')
    c.execute('CREATE INDEX IF NOT EXISTS board_jobs_sorted ON board_jobs(kind,active,sort_at DESC,job_id)')
    c.execute('''CREATE TABLE IF NOT EXISTS board_source_companies(
        job_id TEXT, kind TEXT, company_key TEXT, PRIMARY KEY(job_id,kind,company_key))''')
    c.execute('''CREATE TABLE IF NOT EXISTS board_faang_sources(
        stream TEXT, source_id TEXT, company_fold TEXT, PRIMARY KEY(stream,source_id))''')
    c.execute('CREATE INDEX IF NOT EXISTS board_faang_company ON board_faang_sources(company_fold)')
    c.execute('CREATE TABLE IF NOT EXISTS board_refresh(job_id TEXT PRIMARY KEY,due REAL NOT NULL)')
    c.execute('CREATE INDEX IF NOT EXISTS board_refresh_due ON board_refresh(due)')
    c.execute('CREATE TABLE IF NOT EXISTS board_index_version(version TEXT PRIMARY KEY)')
    current = c.execute('SELECT 1 FROM board_index_version WHERE version=?', (VERSION,)).fetchone()
    for table, key, columns in (
        ('observations', 'job_id', 'job_id,stream,source_id,payload,present,first_seen'),
        ('search_index', 'job_id', 'job_id,stream,source_id,kind,active,visible,posted_at'),
        ('job_title_overrides', 'job_id', 'job_id,title'),
        ('jobs', 'id', 'id,first_seen'),
    ):
        for event, references in (('INSERT', ['NEW']), ('UPDATE', ['OLD', 'NEW']), ('DELETE', ['OLD'])):
            if not current:
                c.execute(f'DROP TRIGGER IF EXISTS board_{table}_{event.lower()}')
            change = event + (' OF ' + columns if event == 'UPDATE' else '')
            guard = (' WHEN ' + ' OR '.join(f'OLD.{name} IS NOT NEW.{name}' for name in columns.split(','))) if event == 'UPDATE' else ''
            body = ''.join(f'INSERT INTO board_refresh VALUES({ref}.{key},0) ON CONFLICT(job_id) DO UPDATE SET due=0;' for ref in references)
            c.execute(f'CREATE TRIGGER IF NOT EXISTS board_{table}_{event.lower()} AFTER {change} ON {table}{guard} BEGIN {body} END')
    if not current:
        c.execute('DELETE FROM board_jobs')
        c.execute('DELETE FROM board_source_companies')
        c.execute('DELETE FROM board_faang_sources')
        c.execute('INSERT INTO board_refresh SELECT id,0 FROM jobs WHERE true ON CONFLICT(job_id) DO UPDATE SET due=0')
        c.execute('DELETE FROM board_index_version')
        c.execute('INSERT INTO board_index_version VALUES(?)', (VERSION,))
    refresh(c)


def pending(c):
    return c.execute('SELECT 1 FROM board_refresh WHERE due<=? LIMIT 1', (time.time(),)).fetchone() is not None


def refresh(c):
    from .board import fingerprint, engineering_title, safe_url
    import re
    now = time.time()
    ids = [r[0] for r in c.execute('SELECT job_id FROM board_refresh WHERE due<=?', (now,))]
    if not ids:
        return
    c.execute('''DELETE FROM board_faang_sources WHERE NOT EXISTS (
        SELECT 1 FROM observations o WHERE o.stream=board_faang_sources.stream
        AND o.source_id=board_faang_sources.source_id)''')
    for offset in range(0, len(ids), 250):
        batch = ids[offset:offset + 250]
        marks = ','.join('?' for _ in batch)
        jobs = {r['id']:dict(r) for r in c.execute(f'''SELECT j.id,j.first_seen,t.title AS override_title
            FROM jobs j LEFT JOIN job_title_overrides t ON t.job_id=j.id WHERE j.id IN ({marks})''', batch)}
        grouped = {jid:[] for jid in batch}
        for row in c.execute(f'''SELECT o.*,s.kind AS indexed_kind,s.active,s.visible,s.posted_at
                FROM observations o LEFT JOIN search_index s USING(stream,source_id)
                WHERE o.job_id IN ({marks}) ORDER BY o.stream,o.source_id''', batch):
            grouped[row['job_id']].append(dict(row))
        # FAANG membership is global and live; a source disappearing must also
        # remove the employer exception from other jobs at that company.
        for jid, observations in grouped.items():
            c.execute('DELETE FROM board_jobs WHERE job_id=?', (jid,))
            c.execute('DELETE FROM board_source_companies WHERE job_id=?', (jid,))
            c.execute('DELETE FROM board_refresh WHERE job_id=?', (jid,))
            future = []
            for item in observations:
                item['source'] = json.loads(item['payload'])
                c.execute('DELETE FROM board_faang_sources WHERE stream=? AND source_id=?', (item['stream'],item['source_id']))
                if item['present'] and item['source'].get('section') == 'FAANG+':
                    c.execute('INSERT INTO board_faang_sources VALUES(?,?,?)', (item['stream'],item['source_id'],item['source'].get('company','').casefold()))
                if (item['stream'] in STREAM_IDS and item['present'] and item['active'] and item['visible']
                        and item['posted_at'] is not None and item['posted_at'] > now):
                    future.append(item['posted_at'])
            if future:
                c.execute('INSERT INTO board_refresh VALUES(?,?)', (jid,min(future)))
            job = jobs.get(jid)
            if not job:
                continue
            # The job survives source cleanup; re-discovery must not reset its age.
            added = min([job['first_seen'], *(o['first_seen'] for o in observations)])
            for kind in ('newgrad','internship'):
                history = [o for o in observations if o['source'].get('kind') == kind]
                active = [o for o in observations if o['indexed_kind'] == kind and o['stream'] in STREAM_IDS
                          and o['present'] and o['active'] and o['visible']
                          and (o['posted_at'] is None or o['posted_at'] <= now)]
                sources = [o['source'] for o in active or history]
                if not sources:
                    continue
                sources.sort(key=lambda s:({'simplify':0,'speedyapply':1}.get(s['source'],9),s.get('source_id','')))
                primary = sources[0]
                company = primary['company']
                title = job['override_title'] or primary['title']
                locations = list(dict.fromkeys(loc for s in sources for loc in s.get('locations',[])))
                urls = list(dict.fromkeys(s['apply_url'] for s in sources if safe_url(s.get('apply_url'))))
                token = fingerprint(sources)
                family, basis = classify(sources,None,token)
                posted = max((s.get('posted_at') or 0 for s in sources),default=0) or None
                payload = dict(id=jid,kind=kind,company=company,title=title,locations=locations,
                    categories=list(dict.fromkeys(s.get('category','') for s in sources)),
                    sources=list(dict.fromkeys(s['source'] for s in sources)),
                    apply_url=urls[0] if urls else None,
                    source_url=next((s.get('source_url') for s in sources if safe_url(s.get('source_url'))),None),
                    posted_at=posted,first_seen=job['first_seen'],added_at=added,
                    active=bool(active),fingerprint=token)
                c.execute('INSERT INTO board_jobs VALUES('+','.join('?' for _ in range(20))+')', (
                    jid,kind,bool(active),normalize_company(company),company.casefold(),title,
                    (company+' '+title).casefold(),' '.join(locations).casefold(),
                    non_us_only(screening_locations(sources)),
                    *(matches_region(locations,region) for region in ('ca','ca_remote','focus_remote')),
                    engineering_title(title),bool(re.search(r'\bdata[\s-]+engineer(?:ing|s)?\b',title,re.I)),
                    family,basis,token,added,added,json.dumps(payload,ensure_ascii=False)))
                c.executemany('INSERT INTO board_source_companies VALUES(?,?,?)',
                    [(jid,kind,name) for name in {normalize_company(s.get('company','')) for s in sources}])
