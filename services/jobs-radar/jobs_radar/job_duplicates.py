"""Explicit, reversible consolidation of source aliases; never merge by title.

Old job/application/audit rows remain intact. Only discovery observations move;
job_aliases records the redirect and removes archived aliases from counts.
Call consolidate inside an administrator-owned transaction after a DB backup.
"""
import json
import time

from .job_match import job_index, job_key


def preferred_job(c, ids):
    # Reuse existing processed records before untouched ones on new ingestion.
    rank = {'submitted': 0, 'submitted_unconfirmed': 1, 'needs_input': 2,
            'in_progress': 3, 'skipped': 4, 'retryable_failure': 5, 'not_started': 6}
    rows = [c.execute('SELECT j.id,j.first_seen,a.status FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.id=?', (jid,)).fetchone() for jid in ids]
    return min(rows, key=lambda r: (rank.get(r['status'], 9), r['first_seen'], r['id']))['id']


def consolidate(c, dry_run=True):
    now = time.time()
    groups = []
    for key, ids in job_index(c).items():
        if len(ids) < 2: continue
        ids = sorted(ids)
        canonical = preferred_job(c, ids)
        marks = ','.join('?' for _ in ids)
        reason = None
        apps = [dict(r) for r in c.execute(f'SELECT * FROM applications WHERE job_id IN ({marks})', ids)]
        states = {r['status'] for r in apps}
        # Untouched duplicates inherit the existing outcome, including a held
        # outcome. Conflicting processed states or an explicit reset stay held.
        if len(states - {'not_started'}) > 1: reason = 'application_state_conflict'
        if len(states)>1 and any(r['status']=='not_started' and r['version']>0 for r in apps): reason = 'owner_reset_conflict'
        if c.execute(f'SELECT 1 FROM owner_submission_undo WHERE job_id IN ({marks}) AND expires>?', [*ids, now]).fetchone(): reason = 'active_submission_undo'
        if c.execute(f"SELECT 1 FROM job_screening WHERE job_id IN ({marks}) AND state='trash' AND expires_at>?", [*ids, now]).fetchone(): reason = 'active_removal_undo'
        # An old job ID must not connect two different requisitions transitively.
        keys = {job_key(r[0]) for r in c.execute(f"SELECT json_extract(payload,'$.apply_url') FROM observations WHERE job_id IN ({marks})", ids)}
        if keys != {key}: reason = 'conflicting_source_identities'
        reviews = [dict(r) for r in c.execute(f'SELECT * FROM job_screening WHERE job_id IN ({marks})', ids)]
        from .application_progress import job_progress
        progress = [p for jid in ids if (p:=job_progress(c,jid))]
        if len({(r['stage'], r['message_id']) for r in progress}) > 1: reason = 'recruiting_progress_conflict'
        group = {'canonical_id': canonical, 'aliases': [i for i in ids if i != canonical], 'reason': reason}
        groups.append(group)
        if dry_run or reason: continue
        # Keep all original evidence, fencing versions and audit IDs for inspection.
        for alias in group['aliases']:
            c.execute('INSERT INTO job_aliases VALUES(?,?,?)', (alias, canonical, now))
            c.execute('UPDATE observations SET job_id=? WHERE job_id=?', (canonical, alias))
            c.execute('UPDATE search_index SET job_id=? WHERE job_id=?', (canonical, alias))
        # Preserve explicit restores; otherwise a deleted alias stays suppressed.
        for kind in {r['kind'] for r in reviews}:
            options = [r for r in reviews if r['kind'] == kind]
            chosen = max(options, key=lambda r: (bool(r['manual_keep']), r['state'] == 'trash', r['reviewed_at']))
            version = max(r['version'] for r in options) + 1
            c.execute('INSERT OR REPLACE INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                      (canonical, kind, chosen['state'], chosen['reason'], chosen['detail'], chosen['evidence'],
                       chosen['fingerprint'], chosen['reviewed_at'], chosen['expires_at'], version, chosen['manual_keep']))
        for row in c.execute(f'SELECT kind,max(opened_at) opened_at FROM web_opened WHERE job_id IN ({marks}) GROUP BY kind', ids).fetchall():
            c.execute('INSERT OR REPLACE INTO web_opened VALUES(?,?,?)', (canonical, row['kind'], row['opened_at']))
        c.execute(f'UPDATE jobs SET first_seen=(SELECT min(first_seen) FROM jobs WHERE id IN ({marks})) WHERE id=?', [*ids, canonical])
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'source_alias_consolidation','jobs-admin',?,?)", (canonical, now, json.dumps(group)))
    return {'groups': len(groups), 'mergeable': sum(not g['reason'] for g in groups),
            'held': sum(bool(g['reason']) for g in groups), 'dry_run': dry_run, 'details': groups}
