"""Explicit, reversible consolidation of source aliases; never merge by title.

Old job/application/audit rows remain intact. Only discovery observations move;
job_aliases records the redirect and removes archived aliases from counts.
Every changed source/index row is journaled in the same transaction. This does
not copy unrelated Profiles, attachments or diagnostics for each small merge.
"""
import json
import time

from .job_match import job_index, posting_key


def preferred_job(c, ids):
    # Reuse existing processed records before untouched ones on new ingestion.
    rank = {'submitted': 0, 'submitted_unconfirmed': 1, 'needs_input': 2,
            'in_progress': 3, 'skipped': 4, 'retryable_failure': 5, 'not_started': 6}
    rows = [c.execute('SELECT j.id,j.first_seen,a.status,a.record,a.attempted_at,a.confirmed_at FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.id=?', (jid,)).fetchone() for jid in ids]
    # Keep the sole owner inventory/timeline on the active canonical member.
    # Multiple owners are held by consolidate, never combined by this ranking.
    return min(rows, key=lambda r: (not bool(r['record']), r['confirmed_at'] is None,
        r['attempted_at'] is None, rank.get(r['status'], 9), r['first_seen'], r['id']))['id']


def consolidate(c, dry_run=True, *, keys=None):
    now = time.time()
    groups = []
    for key, ids in job_index(c).items():
        if keys is not None and key not in keys: continue
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
        source_keys = {posting_key(r[0], c) for r in c.execute(f"SELECT json_extract(payload,'$.apply_url') FROM observations WHERE job_id IN ({marks})", ids)}
        if source_keys != {key}: reason = 'conflicting_source_identities'
        reviews = [dict(r) for r in c.execute(f'SELECT * FROM job_screening WHERE job_id IN ({marks})', ids)]
        from .application_progress import job_progress
        progress = [p for jid in ids if (p:=job_progress(c,jid))]
        if len({(r['stage'], r['message_id']) for r in progress}) > 1: reason = 'recruiting_progress_conflict'
        if len({r['application_id'] for r in apps if r['application_id']}) > 1:
            reason = 'application_identity_conflict'
        group = {'canonical_id': canonical, 'aliases': [i for i in ids if i != canonical], 'reason': reason}
        groups.append(group)
        if dry_run or reason: continue
        # A compact before-image is enough to reverse this source-only change.
        # Applications and events are never mutated. Keep journals atomically
        # with the merge instead of making a full database copy on every tick.
        before = {
            table: [dict(r) for r in c.execute(f'SELECT {columns} FROM {table} WHERE job_id IN ({marks})', ids)]
            for table, columns in (
                ('observations', 'stream,source_id,job_id'),
                ('search_index', 'stream,source_id,job_id'),
                ('job_screening', '*'), ('web_opened', '*'))}
        before['job_aliases'] = [dict(r) for r in c.execute(
            f'SELECT * FROM job_aliases WHERE canonical_id IN ({marks}) OR alias_id IN ({marks})', [*ids, *ids])]
        before['first_seen'] = c.execute('SELECT first_seen FROM jobs WHERE id=?', (canonical,)).fetchone()[0]
        # Keep all original evidence, fencing versions and audit IDs for inspection.
        for alias in group['aliases']:
            c.execute('INSERT INTO job_aliases VALUES(?,?,?)', (alias, canonical, now))
            # An already consolidated member may later acquire a new sibling
            # with the sole owner record. Keep every historical ID one hop away.
            c.execute('UPDATE job_aliases SET canonical_id=? WHERE canonical_id=?', (canonical, alias))
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
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'source_alias_consolidation','jobs-admin',?,?)",
                  (canonical, now, json.dumps({**group, 'before': before})))
    return {'groups': len(groups), 'mergeable': sum(not g['reason'] for g in groups),
            'held': sum(bool(g['reason']) for g in groups), 'dry_run': dry_run, 'details': groups}
