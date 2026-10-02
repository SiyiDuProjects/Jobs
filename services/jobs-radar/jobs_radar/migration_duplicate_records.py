"""One-time same-posting merge; ordinary runtime upserts must never do this.

The sole owner inventory/timeline survives. Historical submission facts are
merged only with an unambiguous posting and provenance. Every removed active
application has an exact pre-migration archive and an explicit redirect.
"""
import hashlib
import json
import math
import re
import time
from pathlib import Path

from .job_match import job_key
from .migration_identity_split import references

CONFIRMATIONS = {'official_success', 'matching_receipt', 'application_history',
                 'extension_confirmation', 'owner_confirmation'}
RETIRED = {'claims', 'claim_purposes', 'recruiting_progress', 'recruiting_events',
           'extension_receipts'}
# Screening membership/fingerprints describe the original identities. Keeping
# them cannot requeue a confirmed application: screening requires version zero.
IMMUTABLE = {'audit', 'application_events', 'screening_seen',
             'screening_batch_items', 'screening_rechecks'}
EXPIRED = {'owner_submission_undo'}
MOVE = {'observations', 'search_index'}
KEYED = {'job_screening', 'job_role_family', 'web_opened'}
REVIEW = {'application_progress_pending'}


def fail(reason):
    # No payload, URL, or personal metadata enters the exception/log.
    raise ValueError('Duplicate application migration requires review: ' + reason)


def validate_inventory(c, inventory):
    """Preserve the existing selection rule, refusing its ambiguous cases."""
    keys = {}
    for record in inventory:
        key = job_key(record.get('jobLink', ''))
        if not key:
            continue
        rows = [dict(r) for r in c.execute('SELECT * FROM applications WHERE job_key=?', (key,))]
        if len(rows) < 2:
            continue
        if key in keys:
            fail('multiple inventory records for one posting')
        keys[key] = record
        if len({r['application_id'] for r in rows if r['application_id']}) > 1:
            fail('multiple application identities')
        if any(r['application_id'] == record.get('id') and record.get('id') for r in rows):
            continue
        if record.get('job_id') in {r['job_id'] for r in rows}:
            continue
        ranked = sorted(rows, key=lambda r: (r['record'] is not None, r['updated']), reverse=True)
        if (ranked[0]['record'] is not None, ranked[0]['updated']) == (ranked[1]['record'] is not None, ranked[1]['updated']):
            fail('ambiguous inventory owner')


def timestamp(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        fail('missing original submission time')
    return value


def submission_time(original, column):
    value = original.get(column)
    return timestamp(original['updated'] if value is None else value)


def email_receipt_reference(value):
    """Recognize the locator emitted by Recruiting.email_url, not new proof.

    This only changes how an already confirmed legacy row's top-level receipt
    reference is interpreted. Explicit posting fields still require identity.
    """
    if not isinstance(value, str):
        return False
    # Match raw bytes: URL parsing can discard controls or accept unquoted
    # query characters which the existing producer never emits.
    return bool(re.fullmatch(r'https://mail\.google\.com/mail/u/'
                             r'(?:\?authuser=(?:[A-Za-z0-9_.~/-]|%[0-9A-Fa-f]{2})+)?'
                             r'#all/[0-9A-Fa-f]{12,40}', value))


def proof(app, key):
    evidence = json.loads(app['evidence'] or '[]')
    if not isinstance(evidence, list) or any(not isinstance(item, dict) for item in evidence):
        fail('invalid submission evidence')
    recognized = [item for item in evidence if item.get('type') in CONFIRMATIONS]
    for item in recognized:
        posting_fields = item
        if item.get('type') == 'matching_receipt' and email_receipt_reference(item.get('reference')):
            posting_fields = {name: value for name, value in item.items() if name != 'reference'}
        for url in references(posting_fields):
            if url.startswith(('http://', 'https://')) and job_key(url) != key:
                fail('confirmation refers to a different posting')
    return app['status'] == 'submitted' and bool(recognized)


def reference_rows(c, ids, migration_started):
    marks = ','.join('?' for _ in ids)
    result = {}
    for (table,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        quoted = '"' + table.replace('"', '""') + '"'
        if 'job_id' not in {r[1] for r in c.execute('PRAGMA table_info(' + quoted + ')')}:
            continue
        rows = [dict(r) for r in c.execute('SELECT * FROM ' + quoted + f' WHERE job_id IN ({marks})', ids)]
        if not rows:
            continue
        if table not in RETIRED | IMMUTABLE | EXPIRED | MOVE | KEYED | REVIEW | {'applications'}:
            fail('unreviewed reference table ' + table)
        if table in REVIEW:
            fail('stateful reference requires review: ' + table)
        if table in EXPIRED and any(not isinstance(r['expires'], (int, float))
                or isinstance(r['expires'], bool) or not math.isfinite(r['expires'])
                or not 0 < r['expires'] <= migration_started for r in rows):
            fail('live or invalid owner undo expiry')
        # Expired snapshots stay byte-for-byte historical; do not advance the
        # guard or use a later wall clock to expire an initially usable undo.
        if table == 'audit' and any(any(word in str(r['event']).lower() for word in ('undo', 'reset')) for r in rows):
            fail('owner undo/reset history')
        if table == 'application_events' and any(r['kind'] != 'migration_evidence' for r in rows):
            fail('preexisting application event requires review')
        result[table] = rows
    return result


def screening_resolutions(ids, owner, canonical, rows, migration_started):
    """Apply only the owner's exact, version-fenced temporary migration input.

    The committed manifest is trusted input, not a claim in the migrated DB.
    It must be backed up and retired with the private migration material.
    """
    raw = Path(__file__).with_name('migration-resolutions.json').read_bytes()
    manifest = json.loads(raw)
    if manifest.get('schema_version') != 1:
        fail('unsupported owner resolution manifest')
    resolved, decisions = {}, []
    for rule in manifest['screening']:
        members = {rule['owner_job_id'], *rule['source_job_ids']}
        if not members.intersection(ids):
            continue
        if (members != set(ids) or rule['owner_job_id'] != owner
                or rule['canonical_job_id'] != canonical or rule['decision'] != 'keep'):
            fail('owner screening resolution identity changed')
        selected = [r for r in rows if r['kind'] == rule['kind']]
        actual = sorted(({name:r[name] for name in ('job_id','state','version','manual_keep')}
                         for r in selected), key=lambda r:r['job_id'])
        if actual != sorted(rule['expected'], key=lambda r:r['job_id']):
            fail('owner screening resolution state changed')
        previous = next(r for r in selected if r['job_id'] == owner)
        if rule['kind'] in resolved:
            fail('multiple owner screening resolutions')
        resolved[rule['kind']] = {**previous, 'job_id':canonical, 'state':'keep', 'reason':'manual',
            'detail':'Owner explicitly kept this posting while reconciling duplicate history.',
            'evidence':'[]', 'reviewed_at':migration_started, 'expires_at':None,
            'version':previous['version'] + 1, 'manual_keep':1}
        decisions.append({'resolution_id':rule['id'], 'authorization':rule['authorization'],
            'manifest_sha256':hashlib.sha256(raw).hexdigest(), 'kind':rule['kind'], 'decision':'keep',
            'from_version':previous['version'], 'to_version':previous['version'] + 1,
            'applied_at':migration_started})
    return resolved, decisions


def merge_duplicate_records(c, retired, archive, *, migration_started):
    reports, redirects = [], {}
    keys = [r[0] for r in c.execute('SELECT job_key FROM applications WHERE job_key IS NOT NULL GROUP BY job_key HAVING count(*)>1')]
    for key in keys:
        apps = [dict(r) for r in c.execute('SELECT * FROM applications WHERE job_key=? ORDER BY job_id', (key,))]
        owners = [app for app in apps if app['record'] is not None]
        sources = [app for app in apps if app['record'] is None]
        # Only the concrete legacy defect is repaired here. Other identities
        # remain held by existing state; no broad deduplication guess is made.
        if not owners or not any(proof(app, key) for app in sources):
            continue
        if len(owners) != 1 or len({a['application_id'] for a in apps if a['application_id']}) != 1:
            fail('multiple owner records or application identities')
        owner = owners[0]
        if owner['deleted'] or owner['status'] not in {'submitted', 'submitted_unconfirmed', 'needs_input'}:
            fail('owner state is not compatible with a prior confirmation')
        if any(not proof(app, key) for app in sources):
            fail('additional source lacks a confirmed outcome')
        if any(app['progress'] or app['application_id'] for app in sources):
            fail('source has an independent timeline')
        ids = [app['job_id'] for app in apps]
        marks = ','.join('?' for _ in ids)
        real = {r[0] for r in c.execute(f'SELECT id FROM jobs WHERE id IN ({marks})', ids)}
        if owner['job_id'] in real:
            canonical = owner['job_id']
        elif len(real) == 1:
            canonical = next(iter(real))
        else:
            fail('historical owner has no unique real posting')
        if c.execute(f'SELECT 1 FROM job_aliases WHERE alias_id IN ({marks}) OR canonical_id IN ({marks})', [*ids, *ids]).fetchone():
            fail('preexisting alias relationship')
        for app in apps:
            urls = [r[0] for r in c.execute("SELECT json_extract(payload,'$.apply_url') FROM observations WHERE job_id=?", (app['job_id'],))]
            if app['job_id'] in real and (not urls or {job_key(url) for url in urls} != {key}):
                fail('source posting identity is not unique')
        origins = {}
        for app in apps:
            original = c.execute('SELECT original FROM _migration_application_origins WHERE jid=?', (app['job_id'],)).fetchone()
            origins[app['job_id']] = json.loads(original[0]) if original else None
            if original and origins[app['job_id']]['status'] == 'not_started' and origins[app['job_id']].get('version', 0) > 0:
                fail('owner reset state')
            if not original and not app['job_id'].startswith('historical:'):
                fail('unexplained generated application')
        original_owner = origins[owner['job_id']]
        if original_owner and original_owner.get('record') is not None:
            if original_owner.get('deleted') or original_owner.get('application_id') != owner['application_id']:
                fail('existing owner identity/deletion conflict')
            # An inventory document is only a legacy projection; it cannot
            # advance an already authoritative row's metadata version.
            for field in ('record', 'record_version', 'progress', 'version'):
                owner[field] = original_owner[field]
        refs = reference_rows(c, ids, migration_started)
        # A receipt can supply an initial progress state, but cannot supersede
        # a distinct owner timeline while duplicate identities are collapsed.
        owner_progress = json.loads(owner['progress']) if owner['progress'] else None
        for old in retired.get('application_progress', []):
            if old['id'] == owner['application_id']:
                old_progress = json.loads(old['payload'])
                if owner_progress and owner_progress.get('version', 0) > 0 and owner_progress != old_progress:
                    fail('conflicting owner progress representations')
                owner_progress = old_progress
        recruiting = refs.get('recruiting_progress', [])
        if len({json.dumps({k: v for k, v in r.items() if k != 'job_id'}, sort_keys=True) for r in recruiting}) > 1:
            fail('conflicting recruiting progress')
        if owner_progress and owner_progress.get('version', 0) > 0 and any(r['stage'] != 'received' for r in recruiting):
            fail('recruiting progress conflicts with owner timeline')
        resolved_screening, decisions = screening_resolutions(ids, owner['job_id'], canonical,
            refs.get('job_screening', []), migration_started)
        keyed_rows = {}
        for table in KEYED:
            groups = {}
            for row in refs.get(table, []):
                groups.setdefault(row['kind'], []).append(row)
            keyed_rows[table] = []
            for kind, entries in groups.items():
                if table == 'job_screening' and kind in resolved_screening:
                    selected = resolved_screening[kind]
                elif table == 'web_opened':
                    same = [{k:v for k,v in r.items() if k not in {'job_id','opened_at'}} for r in entries]
                    if any(value != same[0] for value in same):
                        fail('conflicting web_opened metadata')
                    candidates = [r for r in entries if r['job_id'] == canonical]
                    if not candidates and len(entries) != 1:
                        fail('multiple opened sources without canonical owner')
                    selected = candidates[0] if candidates else entries[0]
                else:
                    same = [{k:v for k,v in r.items() if k != 'job_id'} for r in entries]
                    if any(value != same[0] for value in same):
                        fail('conflicting ' + table)
                    selected = entries[0]
                keyed_rows[table].append({**selected, 'job_id':canonical})
        confirmed = [app for app in apps if proof(app, key)]
        # Historical placeholders without original applications cannot invent
        # an observed time; their archive remains provenance, not a timestamp.
        confirmed_at = min(submission_time(origins[a['job_id']], 'confirmed_at')
                           for a in confirmed if origins[a['job_id']] is not None)
        attempts = [submission_time(origins[a['job_id']], 'attempted_at') for a in apps
                    if origins[a['job_id']] is not None and a['status'] in {'submitted', 'submitted_unconfirmed'}]
        attempts += [timestamp(a['attempted_at']) for a in apps if a['attempted_at'] is not None]
        evidence = []
        for app in [owner, *sources]:
            for item in json.loads(app['evidence'] or '[]'):
                if item not in evidence:
                    evidence.append(item)
        for app in apps:
            original = origins[app['job_id']]
            archive(c, 'duplicate_applications_before' if original else 'duplicate_applications_generated', [original or app])
        policies = []
        for table, rows in refs.items():
            if table == 'applications':
                continue
            policy = ('retired_original_payload' if table in RETIRED else
                      'retain_original_reference' if table in IMMUTABLE else
                      'retain_expired_reference' if table in EXPIRED else
                      'preserve_canonical_opened' if table == 'web_opened' else
                      'owner_screening_resolution' if table == 'job_screening' and decisions else 'move_posting_reference')
            policies.append({'table': table, 'count': len(rows), 'policy': policy})
            if table in MOVE | KEYED:
                archive(c, 'duplicate_' + table + '_before', rows)
            if table in MOVE:
                c.execute(f'UPDATE {table} SET job_id=? WHERE job_id IN ({marks})', [canonical, *ids])
            elif table in KEYED:
                c.execute(f'DELETE FROM {table} WHERE job_id IN ({marks})', ids)
                for row in keyed_rows[table]:
                    c.execute(f"INSERT INTO {table}({','.join(row)}) VALUES({','.join('?' for _ in row)})", list(row.values()))
        # Preserve the owner's entire row first; only explicit submission facts
        # and its canonical job pointer differ. No metadata upsert is involved.
        c.execute(f'DELETE FROM applications WHERE job_id IN ({marks}) AND job_id!=?', [*ids, owner['job_id']])
        c.execute('UPDATE applications SET job_id=?,status=?,evidence=?,attempted_at=?,confirmed_at=?,record=?,record_version=?,progress=?,version=? WHERE job_id=?',
                  (canonical, 'submitted', json.dumps(evidence, ensure_ascii=False), min(attempts), confirmed_at,
                   owner['record'], owner['record_version'], owner['progress'], owner['version'], owner['job_id']))
        now = time.time()
        for jid in sorted(real - {canonical}):
            c.execute('INSERT INTO job_aliases VALUES(?,?,?)', (jid, canonical, now))
        mapping = {'job_key': key, 'source_job_ids': [a['job_id'] for a in sources],
                   'owner_job_id': owner['job_id'], 'canonical_job_id': canonical,
                   'application_id': owner['application_id'],
                   'generated_job_ids': [jid for jid, original in origins.items() if original is None],
                   'confirmed_source_job_ids': [a['job_id'] for a in confirmed if origins[a['job_id']] is not None],
                   'attempted_at': min(attempts), 'confirmed_at': confirmed_at, 'references': policies}
        if decisions:
            mapping['screening_resolutions'] = decisions
        event_key = 'migration:duplicate:' + hashlib.sha256(key.encode()).hexdigest()
        c.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,'migration_duplicate_merge',?,?)",
                  (event_key, owner['application_id'], canonical, json.dumps(mapping, ensure_ascii=False), now))
        reports.append(mapping)
        redirects.update({jid: canonical for jid in ids})
    return reports, redirects
