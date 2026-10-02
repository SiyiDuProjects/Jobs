"""One-time diagnostic redaction and readable platform IDs; run after a verified backup."""
import hashlib
import json
import time

from .browser_history import initialize, redact, redaction_salt
from .job_match import job_key
from .store import encoded

VERSION = 'diagnostics-v2-2026-09-26'
PLATFORMS = dict(zip(
    'qI eL dL bL DL UL GL oR sR FR XR QR iz uz Oz Nz Uz Jz oB sB EB BB VB YB aV gV QV PR bH oracleRunApplication'.split(),
    'adp ashby bamboohr breezy comeet dayforce dover eightfold freshteam gusto icims jazzhr jobvite lever paylocity phenom pinpoint polymer rippling seek smartrecruiters successfactors tesla tiktok ultipro workable workday greenhouse indeed oracle'.split()))


def migrate(c):
    c.execute('CREATE TABLE IF NOT EXISTS diagnostic_migrations(name TEXT PRIMARY KEY, report TEXT NOT NULL)')
    existing = c.execute('SELECT report FROM diagnostic_migrations WHERE name=?', (VERSION,)).fetchone()
    if existing:
        return {**json.loads(existing['report']), 'alreadyApplied': True}
    initialize(c)
    count, renamed = 0, 0
    for row in c.execute('SELECT * FROM browser_diagnostic_history').fetchall():
        data = json.loads(row['data'])
        old_platform = data['ats']
        data.update(schemaVersion=2, runId=data.get('runId') or 'migrated-' + row['id'],
                    build=data.get('build') or 'pre-migration', jobKey=job_key(data['url']),
                    ats=PLATFORMS.get(old_platform, old_platform))
        redact(data, redaction_salt(c), row['device'] + ':' + data['runId'])
        c.execute('UPDATE browser_diagnostic_history SET data=? WHERE id=?', (encoded(data), row['id']))
        count += 1
        renamed += data['ats'] != old_platform
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'browser_control_sessions' in tables:
        c.execute("UPDATE browser_control_sessions SET active=0,pages='[]'")
    if 'browser_control_commands' in tables:
        c.execute("UPDATE browser_control_commands SET state=CASE WHEN state='queued' THEN 'cancelled' WHEN state='dispatched' THEN 'unknown' ELSE state END,args='{}'")
    report = {'migration': VERSION, 'runsRedacted': count, 'platformsRenamed': renamed,
              'oldBrowserSessionsEnded': True, 'appliedAt': int(time.time())}
    c.execute('INSERT INTO diagnostic_migrations VALUES(?,?)', (VERSION, encoded(report)))
    return report
