"""Streamed read-only accounting for the first applications-v2 migration.

Every old inventory row must map to a stored record and retain its exact raw
document as migration evidence. Every added application/record and changed
submission status needs an explicit migration origin. No row is corrected here.
"""
import argparse
import hashlib
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import uuid


RETIRED = ('claims', 'claim_purposes', 'historical', 'application_progress',
    'application_progress_events', 'application_progress_migrations', 'application_progress_pending',
    'recruiting_progress', 'recruiting_events', 'extension_receipts')


def connect(path):
    db = sqlite3.connect(Path(path).resolve(strict=True).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA cache_size=-2048')
    db.execute('PRAGMA temp_store=FILE')
    # Keep all checks on one read snapshot even if a caller accidentally passes
    # an active database. This does not permit a live release/accounting run.
    db.execute('BEGIN')
    return db


def exists(db, table):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone())


def rows(db, table):
    if exists(db, table):
        for row in db.execute('SELECT * FROM "' + table.replace('"', '""') + '"'):
            yield dict(row)


class Digests:
    """Disk counters retain only row hashes; private payloads are never spooled."""
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA cache_size=-2048')
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('CREATE TABLE counts(category TEXT,digest TEXT,expected INTEGER DEFAULT 0,actual INTEGER DEFAULT 0,PRIMARY KEY(category,digest))')

    def close(self):
        self.db.close()

    def add(self, category, row, side):
        digest = hashlib.sha256()
        for chunk in json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':')).iterencode(row):
            digest.update(chunk.encode('utf-8'))
        self.db.execute('INSERT INTO counts(category,digest,' + side + ') VALUES(?,?,1) ON CONFLICT(category,digest) DO UPDATE SET ' + side + '=' + side + '+1', (category, digest.hexdigest()))

    def compare(self, category):
        value = self.db.execute('SELECT COALESCE(SUM(expected),0),COALESCE(SUM(actual),0),COALESCE(SUM(MAX(expected-actual,0)),0),COALESCE(SUM(MAX(actual-expected,0)),0) FROM counts WHERE category=?', (category,)).fetchone()
        return dict(before=value[0], after=value[1], missing=value[2], added=value[3])


RECORD_FIELDS = ('jobTitle', 'jobLink', 'companyName', 'companyLink', 'date', 'status', 'profileName')
CONFIRMATIONS = {'official_success', 'matching_receipt', 'application_history', 'extension_confirmation', 'owner_confirmation'}


def decoded(value, default=None):
    return json.loads(value) if value is not None else default


def references(value):
    """Only actual old evidence URL fields can anchor an identity split."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {'reference', 'job_url', 'url'} and isinstance(child, str):
                yield child
            elif isinstance(child, (dict, list)):
                yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)


def submission_references(proof):
    """Distinguish the legacy mail locator from a posting identity assertion.

    Recruiting's stored matching_receipt can put its exact Gmail message URL
    in the top-level reference field. It is not the posting URL, and is not an
    identity anchor or independent proof of submission. Status, recognized
    proof type, observations and timestamps are still verified from old rows.
    All url/job_url fields and nested references retain the strict check.
    """
    reference = proof.get('reference')
    if (proof.get('type') == 'matching_receipt' and isinstance(reference, str)
            and re.fullmatch(r'https://mail\.google\.com/mail/u/'
                r'(?:\?authuser=(?:[A-Za-z0-9_.~/-]|%[0-9A-Fa-f]{2})+)?'
                r'#all/[0-9A-Fa-f]{12,40}', reference)):
        yield from references({key: value for key, value in proof.items() if key != 'reference'})
    else:
        yield from references(proof)


def historical_key(identity):
    """Read the documented pre-v2 identity formats without migration helpers."""
    from jobs_radar.job_match import job_key
    if identity.startswith('greenhouse:') and len(identity.split(':')) == 3:
        _, company, posting = identity.split(':')
        return job_key('https://job-boards.greenhouse.io/' + company + '/jobs/' + posting)
    if identity.startswith(('jobs.lever.co:', 'jobs.eu.lever.co:', 'jobs.ashbyhq.com:')):
        host, company, posting = identity.split(':', 2)
        return job_key('https://' + host + '/' + company + '/' + posting)
    return job_key(identity) or identity


def duplicate_groups(old, inventory, postings, targets, historical, started, failures):
    """Derive the only permitted same-posting merges from the before database.

    Keep IDs/ranking facts in memory. Raw records and evidence are read only for
    the small candidate group. The after report never chooses an owner for us.
    """
    from jobs_radar.job_match import job_key
    def fail():
        if 'duplicate_sources' not in failures: failures.append('duplicate_sources')
    columns = {row[1] for row in old.execute('PRAGMA table_info(applications)')}
    projection = ['job_id', 'status', 'updated'] + [name if name in columns else 'NULL AS ' + name
        for name in ('application_id', 'job_key')]
    projection.append('record IS NOT NULL AS has_record' if 'record' in columns else '0 AS has_record')
    candidates = {row['job_id']: dict(row) for row in old.execute('SELECT ' + ','.join(projection) + ' FROM applications')}
    anchors = {jid: key for (jid, key), target in targets.items() if jid == target}
    for jid, candidate in candidates.items():
        candidate['job_key'] = anchors.get(jid, candidate['job_key'])
        if not candidate['job_key'] and candidate['has_record']:
            record = old.execute('SELECT record FROM applications WHERE job_id=?', (jid,)).fetchone()[0]
            candidate['job_key'] = job_key(decoded(record).get('jobLink'))
    for jid, rowid in historical.items():
        row = old.execute('SELECT identity,status FROM historical WHERE rowid=?', (rowid,)).fetchone()
        if jid not in candidates:
            candidates[jid] = dict(job_id=jid, status=row['status'], updated=None,
                application_id=None, job_key=historical_key(row['identity']), has_record=0, historical=True)
        elif candidates[jid]['status'] == 'not_started':
            candidates[jid]['status'] = row['status']
    grouped, inventory_by_key = {}, {}
    for candidate in candidates.values():
        if candidate['job_key']: grouped.setdefault(candidate['job_key'], []).append(candidate)
    for entry in inventory:
        key = job_key(entry.get('jobLink'))
        if key: inventory_by_key.setdefault(key, []).append(entry)
    for key, matches in grouped.items():
        if key in inventory_by_key: continue
        owners = [item for item in matches if item['has_record']]
        if len(owners) == 1:
            inventory_by_key[key] = [dict(id=owners[0]['application_id'], job_id=owners[0]['job_id'])]
    jobs = {row[0] for row in old.execute('SELECT id FROM jobs')}
    groups = {}
    for key, entries in inventory_by_key.items():
        matches = grouped.get(key, [])
        if len(matches) < 2: continue
        raw, official = {}, set()
        for item in matches:
            jid = item['job_id']
            row = dict(old.execute('SELECT * FROM applications WHERE job_id=?', (jid,)).fetchone() or {})
            proof = decoded(row.get('evidence'), [])
            if row.get('status') == 'submitted' and any(item.get('type') in CONFIRMATIONS for item in proof):
                official.add(jid)
            raw[jid] = {name: row.get(name) for name in ('status', 'version', 'deleted')}
            raw[jid]['has_progress'] = bool(row.get('progress'))
        if not official: continue
        if len(entries) != 1: fail(); continue
        entry = entries[0]
        exact = [item for item in matches if entry.get('id') and item['application_id'] == entry['id']]
        if not exact and entry.get('job_id'):
            exact = [item for item in matches if item['job_id'] == entry['job_id']]
        if not exact:
            preference = max(item['has_record'] for item in matches)
            ranked = [item for item in matches if item['has_record'] == preference]
            generated = [item for item in ranked if item.get('historical')]
            if generated:
                # A newly seeded historical row ranks after old rows only if
                # those timestamps precede the independently bounded migration.
                if len(generated) != 1 or any(item['updated'] >= started for item in ranked if not item.get('historical')):
                    fail(); continue
                exact = generated
            else:
                latest = max(item['updated'] for item in ranked)
                exact = [item for item in ranked if item['updated'] == latest]
        if len(exact) != 1: fail(); continue
        owner = exact[0]
        sources = sorted(item['job_id'] for item in matches if item['job_id'] != owner['job_id'])
        if len({item['application_id'] for item in matches if item['application_id']}) > 1:
            fail(); continue
        if any(jid not in official or candidates[jid]['has_record'] or candidates[jid]['application_id'] or raw[jid]['has_progress'] for jid in sources):
            fail(); continue
        if owner['status'] not in {'submitted', 'submitted_unconfirmed', 'needs_input', 'not_started'} or raw[owner['job_id']].get('deleted'):
            fail(); continue
        if any(row.get('status') == 'not_started' and (row.get('version') or 0) > 0 for row in raw.values()):
            fail(); continue
        if any(jid in jobs and set(postings.get(jid, {})) != {key} for jid in raw):
            fail(); continue
        members = sorted([owner['job_id'], *sources])
        if exists(old, 'job_aliases') and any(old.execute('SELECT 1 FROM job_aliases WHERE alias_id=? OR canonical_id=?', (jid, jid)).fetchone() for jid in members):
            fail(); continue
        if owner['job_id'] in jobs:
            canonical = owner['job_id']
        else:
            real_sources = [jid for jid in sources if jid in jobs]
            if len(real_sources) != 1: fail(); continue
            canonical = real_sources[0]
        groups[canonical] = dict(job_key=key, owner_job_id=owner['job_id'], canonical_job_id=canonical,
            application_id=owner['application_id'] or entry.get('id'), source_job_ids=sources,
            member_ids=members, generated_owner=bool(owner.get('historical')))
    return groups


def old_sources(old, new, migration, inventory, started, created, digests, failures):
    """Derive origins from the old DB, never from a prefix or migration claim.

    Maps contain IDs, posting keys and counts only. Source payloads are read and
    hashed one row at a time; the scratch database receives hashes only.
    """
    from jobs_radar.job_match import job_key

    def fail(name):
        if name not in failures:
            failures.append(name)

    postings = {}
    for row in old.execute("SELECT job_id,json_extract(payload,'$.apply_url') url FROM observations"):
        key = job_key(row['url']) if row['url'] else None
        if key:
            postings.setdefault(row['job_id'], {}).setdefault(key, 0)
            postings[row['job_id']][key] += 1
    anchors = {}
    for row in old.execute('SELECT job_id,evidence FROM applications'):
        if len(postings.get(row['job_id'], {})) > 1:
            anchors[row['job_id']] = {job_key(url) for url in references(decoded(row['evidence'], []))} & postings[row['job_id']].keys()
    for row in rows(old, 'extension_receipts'):
        if row['job_id'] in anchors:
            anchors[row['job_id']].update({job_key(url) for url in references(decoded(row['payload']))} & postings[row['job_id']].keys())
    targets, splits = {}, {}
    for jid, keys in postings.items():
        if len(keys) > 1 and len(anchors.get(jid, set())) != 1:
            fail('identity_split_sources')
            continue
        anchor = next(iter(anchors[jid])) if len(keys) > 1 else next(iter(keys))
        for key in keys:
            target = jid if key == anchor else hashlib.sha256(key.encode()).hexdigest()[:24]
            targets[jid, key] = target
            if target != jid:
                splits[target] = (jid, key)
    reported = {(part['job_id'], item['old_job_id'], part['job_key'])
                for item in migration.get('identity_splits', []) for part in item['postings']
                if part['job_id'] != item['old_job_id']}
    if reported != {(target, *source) for target, source in splits.items()}:
        fail('identity_split_sources')
    historical = {}
    split_identities = {key: target for target, (_, key) in splits.items()}
    for row in old.execute('SELECT rowid,identity FROM historical') if exists(old, 'historical') else ():
        known = old.execute('SELECT id FROM jobs WHERE identity=?', (row['identity'],)).fetchone()
        target = known[0] if known else split_identities.get(row['identity'])
        target = target or 'historical:' + hashlib.sha256(row['identity'].encode()).hexdigest()[:24]
        historical[target] = row['rowid']

    duplicates = duplicate_groups(old, inventory, postings, targets, historical, started, failures)
    redirects = {jid: canonical for canonical, group in duplicates.items() for jid in group['member_ids']}
    fields = ('job_key', 'source_job_ids', 'owner_job_id', 'canonical_job_id', 'application_id')
    reported = [{key: value.get(key) for key in fields} for value in migration.get('duplicate_records', [])]
    expected = [{key: group[key] for key in fields} for group in duplicates.values()]
    if sorted(reported, key=lambda item: str(item['job_key'])) != sorted(expected, key=lambda item: item['job_key']):
        fail('duplicate_mapping')
    for (source, key), target in targets.items():
        app = new.execute('SELECT job_key FROM applications WHERE job_id=?', (redirects.get(target, target),)).fetchone()
        if not app or app[0] != key:
            fail('source_posting_identity')

    for row in rows(old, 'jobs'):
        row['job_key'] = next((key for key in postings.get(row['id'], {}) if targets.get((row['id'], key)) == row['id']), row.get('job_key'))
        digests.add('source:jobs', row, 'expected')
    for target, (source, key) in splits.items():
        first, last = None, None
        for row in old.execute("SELECT first_seen,last_seen,json_extract(payload,'$.apply_url') url FROM observations WHERE job_id=?", (source,)):
            if row['url'] and job_key(row['url']) == key:
                first = row['first_seen'] if first is None else min(first, row['first_seen'])
                last = row['last_seen'] if last is None else max(last, row['last_seen'])
        digests.add('source:jobs', dict(id=target, identity=key, first_seen=first, last_seen=last, job_key=key), 'expected')
    for row in rows(new, 'jobs'):
        digests.add('source:jobs', row, 'actual')
    counts = digests.compare('source:jobs')
    if counts['missing'] or counts['added']:
        fail('source_rows:jobs')

    for table in ('observations', 'search_index'):
        for row in rows(old, table):
            source = row if table == 'observations' else old.execute(
                'SELECT payload FROM observations WHERE stream=? AND source_id=?', (row['stream'], row['source_id'])).fetchone()
            url = decoded(source['payload']).get('apply_url') if source else None
            key = job_key(url) if url else None
            target = targets.get((row['job_id'], key), row['job_id'])
            row['job_id'] = redirects.get(target, target)
            digests.add('source:' + table, row, 'expected')
        for row in rows(new, table):
            digests.add('source:' + table, row, 'actual')
        counts = digests.compare('source:' + table)
        if counts['missing'] or counts['added']:
            fail('source_rows:' + table)
    for row in rows(old, 'job_aliases'):
        digests.add('source:job_aliases', row, 'expected')
    for canonical, group in duplicates.items():
        for jid in group['member_ids']:
            if jid == canonical or not old.execute('SELECT 1 FROM jobs WHERE id=?', (jid,)).fetchone(): continue
            if exists(old, 'job_aliases') and old.execute('SELECT 1 FROM job_aliases WHERE alias_id=?', (jid,)).fetchone():
                fail('duplicate_aliases')
                continue
            row = new.execute('SELECT * FROM job_aliases WHERE alias_id=?', (jid,)).fetchone()
            if not row or not isinstance(row['created'], (int, float)) or not started <= row['created'] <= created:
                fail('duplicate_aliases')
                continue
            digests.add('source:job_aliases', dict(alias_id=jid, canonical_id=canonical, created=row['created']), 'expected')
    for row in rows(new, 'job_aliases'):
        digests.add('source:job_aliases', row, 'actual')
    counts = digests.compare('source:job_aliases')
    if counts['missing'] or counts['added']: fail('duplicate_aliases')
    return splits, historical, duplicates


def source_progress(aid, stage, source):
    # Audit specification, deliberately independent of runtime seed/put/upsert.
    return dict(application_id=aid, stage=stage, round=None, final=False, version=0,
                observed_at=None, updated_at=None, source=source, summary='', reference='',
                manual_updated_at=0, ended_from=None, receipt_confirmed=False)


def date_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        try:
            return datetime.strptime(value.split(' (')[0], '%a %b %d %Y %H:%M:%S GMT%z').timestamp()
        except (AttributeError, TypeError, ValueError):
            return None


def live_content(old, new, inventory, mappings, historical, splits, duplicates, started, created, digests, failures):
    """Check usable records, progress and receipts independently of archives.

    Complete old rows retained as evidence cannot compensate for losing the
    authoritative projection. Only the documented merge/remap is allowed here.
    No migration or application writer is imported or executed.
    """
    from jobs_radar.job_match import job_key

    def fail(name):
        if name not in failures:
            failures.append(name)

    def migration_time(value):
        return isinstance(value, (int, float)) and math.isfinite(value) and started <= value <= created

    redirects = {source: target for target, group in duplicates.items() for source in group['member_ids']}

    by_target, remap = {}, {}
    for index, entry in enumerate(inventory):
        mapping = mappings[index] if index < len(mappings) else {}
        if mapping.get('application_id'):
            by_target.setdefault(mapping['application_id'], []).append(index)
            if entry.get('id'):
                remap[entry['id']] = mapping['application_id']
    progress_rows = {}
    if exists(old, 'application_progress'):
        for row in old.execute("SELECT rowid,id,json_extract(payload,'$.version') version FROM application_progress"):
            aid = remap.get(row['id'], row['id'])
            previous = progress_rows.get(aid)
            if previous is None or (row['version'] or 0) >= previous[1]:
                progress_rows[aid] = (row['rowid'], row['version'] or 0)
    old_columns = {row[1] for row in old.execute('PRAGMA table_info(applications)')}
    existing_aids = {row[0] for row in old.execute('SELECT application_id FROM applications WHERE application_id IS NOT NULL')} if 'application_id' in old_columns else set()
    orphan_ids = {'retired:' + aid for aid in progress_rows.keys() - by_target.keys() - existing_aids}

    def recent_source(jid, key):
        source_id = splits.get(jid, (jid, None))[0]
        for row in old.execute('SELECT payload FROM observations WHERE job_id=? ORDER BY last_seen DESC', (source_id,)):
            value = decoded(row[0])
            if value.get('apply_url') and job_key(value['apply_url']) == key:
                return value
        return None

    for app in rows(new, 'applications'):
        jid, aid = app['job_id'], app['application_id']
        group = duplicates.get(jid)
        owner_jid = group['owner_job_id'] if group else jid
        if group and aid != group['application_id']: fail('duplicate_owner_identity')
        if jid in orphan_ids and aid != jid.removeprefix('retired:'):
            fail('live_progress_content')
        prior_row = old.execute('SELECT * FROM applications WHERE job_id=?', (owner_jid,)).fetchone()
        prior = dict(prior_row) if prior_row else {}
        history_row = old.execute('SELECT * FROM historical WHERE rowid=?', (historical[owner_jid],)).fetchone() if owner_jid in historical else None
        history = dict(history_row) if history_row else {}
        indices = by_target.get(aid, [])
        record = decoded(prior.get('record'))
        if record is not None and not isinstance(record, dict):
            fail('live_record_content')
            record = None
        for index in ([] if group and record is not None else indices):
            candidate = {key: inventory[index].get(key) for key in RECORD_FIELDS}
            if record is None:
                record = candidate
            else:
                # The first record keeps its facts; only these missing display
                # fields can be supplied by another row for the same posting.
                for key in ('companyName', 'companyLink', 'profileName'):
                    if not record.get(key):
                        record[key] = candidate[key]

        prior_status = prior.get('status', 'not_started')
        status = history.get('status', prior_status) if prior_status == 'not_started' else prior_status
        before_inventory_status = status
        if indices and status == 'not_started':
            status = 'submitted_unconfirmed'
        if not prior and not indices and jid in orphan_ids:
            status = 'submitted_unconfirmed'
        generated = record is None and status in {'submitted', 'submitted_unconfirmed'}
        if generated:
            source = recent_source(jid, app['job_key'])
            if source:
                expected_aid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'jobs-board:' + jid))
                if aid != expected_aid:
                    fail('live_record_content')
                observed = prior.get('updated', app['updated'])
                record = dict(jobTitle=source['title'], jobLink=source['apply_url'], companyName=source.get('company', ''),
                    companyLink='', date=datetime.fromtimestamp(observed, timezone.utc).isoformat(), status='applied',
                    profileName='Intern' if source.get('kind') in {'intern', 'internship'} else 'Newgrad')
        if decoded(app['record']) != record:
            fail('live_record_content')
        if record is not None and (app['deleted'] != (0 if indices or generated else prior.get('deleted', 0))
                or app['job_key'] != job_key(record['jobLink'])):
            fail('live_record_content')
        retained_record = group and prior.get('record') is not None
        if app['record_version'] != prior.get('record_version', 0) + (0 if retained_record else len(indices)) + int(generated and record is not None):
            fail('live_record_content')

        progress = decoded(prior.get('progress'))
        if progress is None and record is not None:
            progress = source_progress(aid, record['status'], 'migration' if indices else 'owner')
        before_merge_progress = progress
        if aid in progress_rows:
            row = old.execute('SELECT payload FROM application_progress WHERE rowid=?', (progress_rows[aid][0],)).fetchone()
            progress = {**decoded(row[0]), 'application_id': aid}
        mail = old.execute('SELECT * FROM recruiting_progress WHERE job_id=?', (owner_jid,)).fetchone() if exists(old, 'recruiting_progress') else None
        if group and exists(old, 'recruiting_progress'):
            options = [row for member in group['member_ids'] for row in old.execute('SELECT * FROM recruiting_progress WHERE job_id=?', (member,))]
            if len({tuple((name, row[name]) for name in row.keys() if name != 'job_id') for row in options}) > 1:
                fail('duplicate_references')
            mail = options[0] if options else None
            if mail and (progress or {}).get('version', 0) > 0 and mail['stage'] != 'received':
                fail('duplicate_references')
        if mail and (status == 'submitted' or group) and aid and (progress or {}).get('version', 0) <= 0:
            progress = source_progress(aid, 'applied' if mail['stage'] == 'received' else mail['stage'], 'email')
            progress.update(observed_at=mail['received_at'], reference=mail['message_id'], summary=mail['summary'],
                            version=mail['version'], receipt_confirmed=mail['stage'] == 'received')
        if decoded(app['progress']) != progress:
            fail('live_progress_content')

        evidence = decoded(prior.get('evidence'), [])
        confirmed = status == 'submitted' and any(item.get('type') in CONFIRMATIONS for item in evidence)
        expected_status = 'submitted_unconfirmed' if status == 'submitted' and not confirmed else status
        updated = prior.get('updated', app['updated'])
        attempted = prior.get('attempted_at')
        if not attempted and prior and before_inventory_status == 'not_started' and indices:
            attempted = date_timestamp(inventory[indices[0]].get('date'))
            if not attempted:
                # Legacy records allow an empty/unparseable display date. The
                # migration may timestamp the import, but cannot invent an
                # earlier historical attempt or a future one.
                attempted = app['attempted_at']
                if not migration_time(attempted):
                    fail('live_submission_content')
        if attempted is None and expected_status in {'submitted', 'submitted_unconfirmed'}:
            attempted = updated
        expected_confirmation = (prior.get('confirmed_at') if prior.get('confirmed_at') is not None else updated) if confirmed else prior.get('confirmed_at')
        expected_detail = history['reference'] if history and prior_status == 'not_started' else prior.get('detail', '')
        expected = dict(status=expected_status, version=prior.get('version', 0), updated=updated,
                        detail=expected_detail, owner_run_id=prior.get('owner_run_id'), attempted_at=attempted,
                        confirmed_at=expected_confirmation, submission_error=prior.get('submission_error'))
        if group:
            old_members, confirmed_ids = {}, []
            for member in group['member_ids']:
                original = old.execute('SELECT * FROM applications WHERE job_id=?', (member,)).fetchone()
                if original is None: continue
                row = dict(original)
                if row['status'] == 'submitted' and any(item.get('type') in CONFIRMATIONS for item in decoded(row.get('evidence'), [])):
                    confirmed_ids.append(member)
                old_members[member] = {name: row[name] for name in ('status', 'updated', 'attempted_at', 'confirmed_at') if name in row}
            times = [old_members[member]['updated'] if old_members[member].get('confirmed_at') is None else old_members[member]['confirmed_at'] for member in confirmed_ids]
            attempts = [row['updated'] if row.get('attempted_at') is None else row['attempted_at'] for row in old_members.values()
                if row['status'] in {'submitted', 'submitted_unconfirmed'}]
            attempts.extend(row['attempted_at'] for row in old_members.values() if row.get('attempted_at') is not None)
            if prior and before_inventory_status == 'not_started' and indices:
                attempts.append(attempted)
            if not times or not attempts or any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0 for value in [*times, *attempts]):
                fail('duplicate_submission_sources')
            else:
                expected.update(status='submitted', attempted_at=min(attempts), confirmed_at=min(times))
                group['facts'] = dict(confirmed_source_job_ids=confirmed_ids,
                    attempted_at=min(attempts), confirmed_at=min(times))
            for source in group['source_job_ids']:
                row = old.execute('SELECT evidence FROM applications WHERE job_id=?', (source,)).fetchone()
                for item in decoded(row[0] if row else None, []):
                    if item not in evidence: evidence.append(item)
            for item in evidence:
                if item.get('type') in CONFIRMATIONS and any(url.startswith(('http://', 'https://')) and
                    job_key(url) != group['job_key'] for url in submission_references(item)):
                    fail('duplicate_submission_sources')
            if group['generated_owner']:
                generated_row = {**expected, 'job_id': owner_jid, 'application_id': aid,
                    'job_key': group['job_key'], 'record_version': len(indices), 'deleted': 0,
                    'record': record, 'progress': before_merge_progress, 'evidence': []}
                # This is the pre-merge seeded historical row, not a copy of
                # the final confirmation or its source's historical timestamp.
                generated_row.update(status=status, attempted_at=None, confirmed_at=None)
                digests.add('duplicate_generated', generated_row, 'expected')
        if (any(app[key] != value for key, value in expected.items()) or decoded(app['evidence'], []) != evidence
                or not prior and not migration_time(updated)):
            fail('live_submission_content')
        if record is None and not prior and app['deleted'] != int(jid in orphan_ids):
            fail('live_progress_content')

    # Receipt keys and timestamps are replay guards. Compare the usable events,
    # not only their archived source copies. Hash each projection immediately.
    event_kinds = {'progress', 'mail', 'pending', 'extension'}
    columns = ('event_key', 'application_id', 'job_id', 'kind', 'payload', 'created', 'device_id', 'checksum', 'updated', 'state', 'result')

    def event(value, side):
        row = {key: value.get(key) for key in columns}
        row['payload'] = decoded(row['payload'])
        row['result'] = decoded(row['result'])
        # A source without an event time receives a migration time, not a new
        # historical fact. Validate that time separately, then compare a marker.
        if row['created'] is None:
            actual = new.execute('SELECT created FROM application_events WHERE event_key=?', (row['event_key'],)).fetchone()
            if not actual or not migration_time(actual[0]):
                fail('live_event_content')
            row['created'] = 'migration_time'
        for key in ('created', 'updated'):
            if isinstance(row[key], (int, float)):
                row[key] = float(row[key])
        digests.add('event:' + row['kind'], row, side)

    untimed = set()
    for row in rows(old, 'application_events'):
        if row['kind'] in event_kinds:
            event(row, 'expected')
    for row in rows(old, 'application_progress_events'):
        aid = remap.get(row['application_id'], row['application_id'])
        payload = {**decoded(row['payload']), 'application_id': aid}
        observed = payload.get('recorded_at') or None
        if observed is None:
            untimed.add(row['event_key'])
        event(dict(event_key=row['event_key'], application_id=aid, kind='progress', payload=json.dumps(payload), created=observed), 'expected')
    for row in rows(old, 'recruiting_events'):
        target = redirects.get(row['job_id'], row['job_id'])
        app = new.execute('SELECT application_id FROM applications WHERE job_id=?', (target,)).fetchone()
        event(dict(event_key='mail:' + row['mailbox'] + ':' + row['message_id'], application_id=app[0] if app else None,
                   job_id=target, kind='mail', payload=json.dumps(row), created=row['created']), 'expected')
    for row in rows(old, 'application_progress_pending'):
        key = 'pending:' + row['job_id']
        untimed.add(key)
        event(dict(event_key=key, kind='pending', payload=row['payload']), 'expected')
    for row in rows(old, 'extension_receipts'):
        event(dict(event_key=row['event_id'], kind='extension', created=row['received'],
                   job_id=redirects.get(row['job_id'], row['job_id']),
                   **{key: row[key] for key in ('payload', 'device_id', 'checksum', 'updated', 'state', 'result')}), 'expected')
    for row in new.execute("SELECT * FROM application_events WHERE kind IN ('progress','mail','pending','extension')"):
        value = dict(row)
        if value['event_key'] in untimed:
            value['created'] = None
        event(value, 'actual')
    for kind in sorted(event_kinds):
        counts = digests.compare('event:' + kind)
        if counts['missing'] or counts['added']:
            fail('live_event_content:' + kind)
    return orphan_ids


def resolution_manifest():
    """Read the committed, temporary owner input; never trust DB authorization."""
    import jobs_radar
    return Path(jobs_radar.__file__).with_name('migration-resolutions.json').read_bytes()


def approved_screening(old, group, cutoff, valid_cutoff, raw, fail):
    manifest = json.loads(raw)
    if manifest.get('schema_version') != 1:
        fail('duplicate_screening_resolution')
        return {}, []
    expected, decisions = {}, []
    members = set(group['member_ids'])
    for rule in manifest['screening']:
        authorized = {rule['owner_job_id'], *rule['source_job_ids']}
        if not authorized.intersection(members): continue
        if (authorized != members or rule['owner_job_id'] != group['owner_job_id']
                or rule['canonical_job_id'] != group['canonical_job_id'] or rule['decision'] != 'keep'
                or not valid_cutoff or rule['kind'] in expected):
            fail('duplicate_screening_resolution')
            continue
        marks = ','.join('?' for _ in members)
        original = [dict(row) for row in old.execute('SELECT * FROM job_screening WHERE kind=? AND job_id IN (' + marks + ')',
            [rule['kind'], *members])]
        fields = ('job_id', 'state', 'version', 'manual_keep')
        if sorted(({key: row[key] for key in fields} for row in original), key=lambda row: row['job_id']) != sorted(rule['expected'], key=lambda row: row['job_id']):
            fail('duplicate_screening_resolution')
            continue
        owner = next((row for row in original if row['job_id'] == group['owner_job_id']), None)
        if owner is None:
            fail('duplicate_screening_resolution')
            continue
        expected[rule['kind']] = {**owner, 'job_id': group['canonical_job_id'], 'state': 'keep', 'reason': 'manual',
            'detail': 'Owner explicitly kept this posting while reconciling duplicate history.', 'evidence': '[]',
            'reviewed_at': cutoff, 'expires_at': None, 'version': owner['version'] + 1, 'manual_keep': 1}
        decisions.append(dict(resolution_id=rule['id'], authorization=rule['authorization'],
            manifest_sha256=hashlib.sha256(raw).hexdigest(), kind=rule['kind'], decision='keep',
            from_version=owner['version'], to_version=owner['version'] + 1, applied_at=cutoff))
    return expected, decisions


def undo_content(old, new, splits, started, created, digests, fail):
    """Protect every undo, allowing only independently proven split reviews.

    A different posting's screening must not be replayed by an anchor undo.
    Derive that subset from old observations/evidence, not the after report;
    require the complete original undo as evidence as well as the live result.
    All unsplit undo rows retain their exact original bytes.
    """
    from jobs_radar.job_match import job_key
    split_sources = {source for source, _ in splits.values()}
    for original in rows(old, 'owner_submission_undo'):
        expected = dict(original)
        jid = original['job_id']
        if jid in split_sources:
            postings = {}
            for observation in old.execute("SELECT json_extract(payload,'$.apply_url') url,json_extract(payload,'$.kind') kind FROM observations WHERE job_id=?", (jid,)):
                key = job_key(observation['url']) if observation['url'] else None
                if key: postings.setdefault(key, set()).add(observation['kind'])
            app = old.execute('SELECT evidence FROM applications WHERE job_id=?', (jid,)).fetchone()
            anchors = {job_key(url) for url in references(decoded(app['evidence'], []))} & postings.keys() if app else set()
            if exists(old, 'extension_receipts'):
                for receipt in old.execute('SELECT payload FROM extension_receipts WHERE job_id=?', (jid,)):
                    anchors |= {job_key(url) for url in references(decoded(receipt['payload']))} & postings.keys()
            if len(postings) < 2 or len(anchors) != 1:
                fail('duplicate_undo_content')
            else:
                anchor = next(iter(anchors))
                kept = []
                for review in decoded(original['reviews']):
                    keys = {job_key(url) for url in references(decoded(review.get('evidence') or '[]'))} & postings.keys()
                    if keys == {anchor} and review['kind'] in postings[anchor]:
                        kept.append(review)
                expected['reviews'] = json.dumps(kept, ensure_ascii=False)
            digests.add('undo_split_archive', original, 'expected')
        digests.add('undo_content', expected, 'expected')
    for row in rows(new, 'owner_submission_undo'):
        digests.add('undo_content', row, 'actual')
    for event in new.execute("SELECT event_key,job_id,created,payload FROM application_events WHERE kind='migration_evidence' AND json_extract(payload,'$.table')='owner_submission_undo'"):
        value = decoded(event['payload'])
        if exists(old, 'application_events') and old.execute('SELECT 1 FROM application_events WHERE event_key=?', (event['event_key'],)).fetchone():
            # Existing evidence is checked unchanged by duplicate_evidence.
            continue
        if event['job_id'] != value['row'].get('job_id') or not started <= event['created'] <= created:
            fail('duplicate_undo_content')
        digests.add('undo_split_archive', value['row'], 'actual')
    for category in ('undo_content', 'undo_split_archive'):
        counts = digests.compare(category)
        if counts['missing'] or counts['added']: fail('duplicate_undo_content')


def duplicate_evidence(old, new, migration, groups, splits, started, created, digests, failures):
    """Account for every retired duplicate and reference using old-row hashes.

    The report and the new merge event are checked against this derivation,
    never against each other. A matching pair of forged claims cannot pass.
    """
    def fail(name):
        if name not in failures: failures.append(name)
    moved = {'observations', 'search_index'}
    keyed = {'job_screening', 'job_role_family', 'web_opened'}
    retired_refs = {'claims', 'claim_purposes', 'recruiting_progress', 'recruiting_events', 'extension_receipts'}
    screening_history = {'screening_seen', 'screening_batch_items', 'screening_rechecks'}
    retained = {'audit', 'application_events'} | screening_history
    expired = {'owner_submission_undo'}
    expiry_cutoff = migration.get('started_at')
    valid_cutoff = (isinstance(expiry_cutoff, (int, float)) and not isinstance(expiry_cutoff, bool)
        and math.isfinite(expiry_cutoff) and 0 < expiry_cutoff <= created)
    raw_authorizations = resolution_manifest() if groups else None
    resolved = {}
    references_with_job = []
    for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        quoted = '"' + table.replace('"', '""') + '"'
        if 'job_id' in {row[1] for row in old.execute('PRAGMA table_info(' + quoted + ')')}:
            references_with_job.append(table)
    reports = {item.get('job_key'): item for item in migration.get('duplicate_records', [])}
    redirects = {member: canonical for canonical, group in groups.items() for member in group['member_ids']}
    for canonical, group in groups.items():
        approved, decisions = approved_screening(old, group, expiry_cutoff, valid_cutoff, raw_authorizations, fail)
        resolved.update({(canonical, kind): row for kind, row in approved.items()})
        policies = []
        members = group['member_ids']
        marks = ','.join('?' for _ in members)
        for member in members:
            row = old.execute('SELECT * FROM applications WHERE job_id=?', (member,)).fetchone()
            if row: digests.add('archive:duplicate_applications_before', dict(row), 'expected')
        for table in references_with_job:
            if table == 'applications': continue
            quoted = '"' + table.replace('"', '""') + '"'
            count = 0
            for raw in old.execute('SELECT * FROM ' + quoted + ' WHERE job_id IN (' + marks + ')', members):
                row = dict(raw)
                count += 1
                if table not in moved | keyed | retained | expired | retired_refs:
                    fail('duplicate_references')
                if table in expired:
                    deadline = row.get('expires')
                    if (not valid_cutoff or not isinstance(deadline, (int, float)) or isinstance(deadline, bool)
                            or not math.isfinite(deadline) or not 0 < deadline <= expiry_cutoff):
                        fail('duplicate_undo_expiry')
                if table == 'audit' and any(word in str(row['event']).lower() for word in ('undo', 'reset')):
                    fail('duplicate_references')
                if table == 'application_events' and row['kind'] != 'migration_evidence':
                    fail('duplicate_references')
                if table in moved | keyed:
                    digests.add('archive:duplicate_' + table + '_before', row, 'expected')
            # Before merging, each retired original with a job_id has already
            # produced an immutable migration_evidence event with that ID.
            if table == 'application_events':
                count += sum(old.execute('SELECT count(*) FROM "' + name + '" WHERE job_id IN (' + marks + ')', members).fetchone()[0]
                    for name in RETIRED if name in references_with_job)
            if count:
                policy = ('retired_original_payload' if table in retired_refs else
                    'retain_original_reference' if table in retained else
                    'retain_expired_reference' if table in expired else
                    'owner_screening_resolution' if table == 'job_screening' and decisions else
                    'preserve_canonical_opened' if table == 'web_opened' else 'move_posting_reference')
                policies.append(dict(table=table, count=count, policy=policy))
        if 'application_events' not in references_with_job:
            count = sum(old.execute('SELECT count(*) FROM "' + name + '" WHERE job_id IN (' + marks + ')', members).fetchone()[0]
                for name in RETIRED if name in references_with_job)
            if count: policies.append(dict(table='application_events', count=count, policy='retain_original_reference'))
        expected = {name: group[name] for name in ('job_key', 'source_job_ids', 'owner_job_id', 'canonical_job_id', 'application_id')}
        expected.update(generated_job_ids=[group['owner_job_id']] if group['generated_owner'] else [],
            **group.get('facts', {}), references=sorted(policies, key=lambda item: item['table']))
        if decisions: expected['screening_resolutions'] = decisions
        def normalized(value):
            value = dict(value)
            value['references'] = sorted(value.get('references', []), key=lambda item: item.get('table', ''))
            return value
        if normalized(reports.get(group['job_key'], {})) != expected:
            fail('duplicate_mapping')
        key = 'migration:duplicate:' + hashlib.sha256(group['job_key'].encode()).hexdigest()
        event = new.execute('SELECT * FROM application_events WHERE event_key=?', (key,)).fetchone()
        if event and valid_cutoff and expiry_cutoff > event['created']:
            fail('duplicate_migration_start')
        if (not event or event['kind'] != 'migration_duplicate_merge' or event['application_id'] != group['application_id']
                or event['job_id'] != canonical or not started <= event['created'] <= created
                or normalized(decoded(event['payload'])) != expected
                or any(event[name] is not None for name in ('device_id', 'checksum', 'updated', 'state', 'result'))):
            fail('duplicate_event')
    if new.execute("SELECT count(*) FROM application_events WHERE kind='migration_duplicate_merge'").fetchone()[0] != len(groups):
        fail('duplicate_event')
    for event in new.execute("SELECT job_id,payload,created FROM application_events WHERE kind='migration_evidence' AND substr(json_extract(payload,'$.table'),1,10)='duplicate_'"):
        value = decoded(event['payload'])
        table = value.get('table', '')
        if event['job_id'] != value['row'].get('job_id') or not started <= event['created'] <= created:
            fail('duplicate_archive')
        if table == 'duplicate_applications_generated':
            row = dict(value['row'])
            for name in ('record', 'progress', 'evidence'): row[name] = decoded(row.get(name))
            digests.add('duplicate_generated', row, 'actual')
        elif table in {'duplicate_applications_before'} | {'duplicate_' + name + '_before' for name in moved | keyed}:
            digests.add('archive:' + table, value['row'], 'actual')
        else: fail('duplicate_archive')
    for category in ['duplicate_generated', 'archive:duplicate_applications_before', *('archive:duplicate_' + name + '_before' for name in moved | keyed)]:
        counts = digests.compare(category)
        if counts['missing'] or counts['added']: fail('duplicate_archive')
    if not groups: return
    # These are original observation/batch/recheck identities, not new posting
    # facts. Do not reinterpret differing fingerprints or review versions as a
    # canonical row. Verify the entire tables, including unrelated members and
    # their batch/checkpoint context, so preserving an archive cannot excuse a
    # lost queue entry or a silently advanced screening watermark.
    for table in screening_history | {'screening_batches', 'screening_checkpoint'}:
        for row in rows(old, table):
            digests.add('screening_history:' + table, row, 'expected')
        for row in rows(new, table):
            digests.add('screening_history:' + table, row, 'actual')
        counts = digests.compare('screening_history:' + table)
        if counts['missing'] or counts['added']: fail('duplicate_screening_history')
    # A separate identity split may already have restricted ambiguous review
    # replay. Every other byte, and the complete pre-split undo, stays protected.
    undo_content(old, new, splits, started, created, digests, fail)
    # Tables retaining one row per job/kind may collapse only identical rows.
    # All unaffected rows, and audit provenance, must remain byte-for-byte.
    for table in keyed | {'audit'}:
        seen = {}
        if table == 'job_screening':
            for row in resolved.values(): digests.add('reference:' + table, row, 'expected')
        for row in rows(old, table):
            member = row.get('job_id')
            if member not in redirects: continue
            if table == 'job_screening' and (redirects[member], row['kind']) in resolved:
                continue
            if table == 'web_opened' and member != redirects[member]:
                canonical_row = old.execute('SELECT * FROM web_opened WHERE job_id=? AND kind=?',
                    (redirects[member], row['kind'])).fetchone()
                if canonical_row:
                    # Only the old display timestamp may differ. The complete
                    # source row is still required in duplicate_*_before above.
                    if ({k: v for k, v in row.items() if k not in {'job_id', 'opened_at'}} !=
                            {k: canonical_row[k] for k in canonical_row.keys() if k not in {'job_id', 'opened_at'}}):
                        fail('duplicate_references')
                    continue
                members = groups[redirects[member]]['member_ids']
                marks = ','.join('?' for _ in members)
                source_count = old.execute('SELECT count(*) FROM web_opened WHERE kind=? AND job_id IN (' + marks + ')',
                    [row['kind'], *members]).fetchone()[0]
                if source_count != 1: fail('duplicate_references')
            if table in keyed and member in redirects:
                row['job_id'] = redirects[member]
                identity = (row['job_id'], row['kind'])
                fingerprint = hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).digest()
                if identity in seen:
                    if fingerprint != seen[identity]: fail('duplicate_references')
                    continue
                seen[identity] = fingerprint
            digests.add('reference:' + table, row, 'expected')
        for row in rows(new, table):
            if row.get('job_id') in redirects: digests.add('reference:' + table, row, 'actual')
        counts = digests.compare('reference:' + table)
        if counts['missing'] or counts['added']: fail('duplicate_references')
    for row in rows(old, 'application_events'):
        actual = new.execute('SELECT * FROM application_events WHERE event_key=?', (row['event_key'],)).fetchone()
        if not actual or dict(actual) != row: fail('duplicate_references')


def reconcile(before, after, scratch_parent=None):
    # The largest single row and small ID/status maps are held in memory; never
    # an entire table of Profile/revision payloads or all archived raw records.
    with tempfile.TemporaryDirectory(prefix='application-accounting-', dir=scratch_parent or Path(after).parent) as temporary:
        with closing(Digests(Path(temporary) / 'digests.sqlite')) as digests:
            return _reconcile(before, after, digests)


def _reconcile(before, after, digests):
    from jobs_radar.job_match import job_key

    if Path(before).resolve() == Path(after).resolve():
        raise ValueError('Separate before and after databases required')
    with closing(connect(before)) as old, closing(connect(after)) as new:
        for db in (old, new):
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Database integrity check failed')
        migration_row = new.execute("SELECT report,created FROM schema_migrations WHERE name='applications-v2'").fetchone()
        if not migration_row:
            raise ValueError('After database has no completed applications-v2 migration')
        migration = json.loads(migration_row['report'])
        archive_tables = set(RETIRED) | {'management_documents', 'management_revisions'}
        for event in new.execute("SELECT payload FROM application_events WHERE kind='migration_evidence'"):
            value = json.loads(event[0])
            if value['table'] in archive_tables:
                digests.add('archive:' + value['table'], value['row'], 'actual')
        evidence = {}
        failures = []
        for table in RETIRED:
            for row in rows(old, table):
                digests.add('archive:' + table, row, 'expected')
            counts = digests.compare('archive:' + table)
            evidence[table] = dict(before=counts['before'], archived=counts['after'], missing=counts['missing'], extra=counts['added'])
            if counts['missing'] or counts['added']:
                failures.append('retired_archive:' + table)
        inventory = []
        for table in ('management_documents', 'management_revisions'):
            # Push the filter into SQLite. Other documents may contain many
            # generations of large resumes and must never enter Python here.
            if exists(old, table):
                for row in old.execute('SELECT * FROM ' + table + " WHERE key='appliedList'"):
                    digests.add('archive:' + table, dict(row), 'expected')
                    if table == 'management_documents':
                        inventory = json.loads(row['value'])
            counts = digests.compare('archive:' + table)
            if counts['missing'] or counts['added']:
                failures.append('inventory_archive:' + table)
        old_apps = {row['job_id']: dict(row) for row in old.execute('SELECT job_id,status FROM applications')}
        new_apps = {row['job_id']: dict(row) for row in new.execute('SELECT job_id,application_id,status,deleted,job_key,record IS NOT NULL AS has_record FROM applications')}
        records = {row['application_id']: row for row in new_apps.values() if row['has_record']}
        mappings = [item for item in migration['mappings'] if 'old_record_id' in item]
        if len(mappings) != len(inventory):
            failures.append('inventory_mapping_count')
        redirects, lost_mappings, mismatched_postings = [], [], []
        mapped_targets = set()
        for index, entry in enumerate(inventory):
            mapping = mappings[index] if index < len(mappings) else {}
            target = records.get(mapping.get('application_id'))
            if (mapping.get('old_record_id') != entry.get('id') or not target
                    or target['job_id'] != mapping.get('job_id') or target['deleted']):
                lost_mappings.append(dict(position=index, old_record_id=entry.get('id'), application_id=mapping.get('application_id')))
                continue
            mapped_targets.add(mapping['application_id'])
            source_key = job_key(entry['jobLink'])
            # The old inventory permits an explicitly empty URL. Such a row
            # has no posting identity to merge on: retain its exact old ID as
            # an external record, and never infer equality with another blank.
            unlinked_preserved = (entry['jobLink'] == '' and source_key is None
                and target['job_key'] is None and bool(entry.get('id'))
                and mapping['application_id'] == entry['id']
                and target['job_id'] == 'external:' + entry['id'])
            if not unlinked_preserved and (not source_key or target['job_key'] != source_key):
                mismatched_postings.append(dict(old_record_id=entry.get('id'), application_id=mapping['application_id']))
            if entry.get('id') != mapping['application_id']:
                redirects.append(dict(old_record_id=entry.get('id'), application_id=mapping['application_id'], job_id=mapping['job_id'],
                                      same_posting=source_key == target['job_key']))
        if lost_mappings:
            failures.append('inventory_mapping_targets')
        if mismatched_postings:
            failures.append('inventory_posting_identity')
        started = new.execute("SELECT min(created) FROM application_events WHERE kind='migration_evidence'").fetchone()[0]
        started = started or migration_row['created']
        splits, historical, duplicates = old_sources(old, new, migration, inventory, started, migration_row['created'], digests, failures)
        orphan_ids = live_content(old, new, inventory, mappings, historical, splits, duplicates,
                                  started, migration_row['created'], digests, failures)
        duplicate_evidence(old, new, migration, duplicates, splits, started, migration_row['created'], digests, failures)
        duplicate_redirects = {jid: canonical for canonical, group in duplicates.items() for jid in group['member_ids']}
        old_columns = {row[1] for row in old.execute('PRAGMA table_info(applications)')}
        retained_record_ids = {row[0] for row in old.execute('SELECT application_id FROM applications WHERE record IS NOT NULL')} if 'record' in old_columns else set()
        old_record_ids = {row['id'] for row in inventory if row.get('id')} | retained_record_ids
        split_ids = set(splits)
        added_applications = Counter()
        added_application_details = []
        for jid in sorted(new_apps.keys() - old_apps.keys()):
            app = new_apps[jid]
            origin = ('identity_split' if jid in split_ids else 'historical_placeholder' if jid in historical
                else 'orphan_progress' if jid in orphan_ids else 'external_inventory' if jid == 'external:' + str(app['application_id']) and app['application_id'] in mapped_targets
                else 'unexplained')
            added_applications[origin] += 1
            added_application_details.append(dict(job_id=jid, application_id=app['application_id'], origin=origin))
        removed_jobs = sorted(old_apps.keys() - new_apps.keys())
        removed_details = [dict(job_id=jid, canonical_job_id=duplicate_redirects.get(jid),
            origin='confirmed_duplicate_merge' if jid in duplicate_redirects and duplicate_redirects[jid] in new_apps else 'unexplained') for jid in removed_jobs]
        missing_origins = {duplicate_redirects.get(jid, jid) for jid in (set(splits) | set(historical) | orphan_ids)} - new_apps.keys()
        if any(item['origin'] == 'unexplained' for item in removed_details) or added_applications['unexplained'] or missing_origins:
            failures.append('application_row_accounting')
        historical_targets = set(historical)
        generated_records = Counter()
        generated_record_details = []
        for aid in sorted(records.keys() - mapped_targets - retained_record_ids):
            app = records[aid]
            prior = old_apps.get(app['job_id'])
            origin = ('prior_board_outcome' if prior and prior['status'] in {'submitted', 'submitted_unconfirmed'}
                      else 'historical_outcome' if app['job_id'] in historical_targets else 'unexplained')
            generated_records[origin] += 1
            generated_record_details.append(dict(application_id=aid, job_id=app['job_id'], origin=origin))
        if generated_records['unexplained']:
            failures.append('generated_record_accounting')
        mapped_jobs = {records[aid]['job_id'] for aid in mapped_targets}
        downgrade_ids = {item['job_id'] for item in migration['mappings'] if item.get('reason') == 'confirmation_evidence_missing'}
        changed_statuses, changed_status_details = Counter(), []
        for jid in sorted(old_apps.keys() & new_apps.keys()):
            previous, current = old_apps[jid]['status'], new_apps[jid]['status']
            if previous == current:
                continue
            origin = ('confirmed_duplicate_merge' if jid in duplicates and current == 'submitted'
                else 'confirmation_evidence_missing' if previous == 'submitted' and current == 'submitted_unconfirmed' and jid in downgrade_ids
                else 'historical_outcome' if previous == 'not_started' and jid in historical_targets
                else 'inventory_outcome' if previous == 'not_started' and current == 'submitted_unconfirmed' and jid in mapped_jobs
                else 'unexplained')
            changed_statuses[origin] += 1
            changed_status_details.append(dict(job_id=jid, before=previous, after=current, origin=origin))
        if changed_statuses['unexplained']:
            failures.append('status_change_accounting')
        protected_tables = {}
        for table in ('owner_profiles', 'owner_profile_revisions', 'profile_grants', 'extension_devices',
                      'oauth_clients', 'oauth_requests', 'oauth_codes', 'oauth_tokens', 'web_sessions'):
            for row in rows(old, table):
                digests.add('protected:' + table, row, 'expected')
            for row in rows(new, table):
                digests.add('protected:' + table, row, 'actual')
            counts = digests.compare('protected:' + table)
            protected_tables[table] = counts
            if counts['missing'] or counts['added']:
                failures.append('protected_table:' + table)
        summary = dict(verified=not failures, inventoryBefore=len(inventory), inventoryUniqueMapped=len(mapped_targets),
            recordsAfter=len(records), oldRecordIdsUnchanged=len(old_record_ids & records.keys()),
            oldRecordIdsAbsent=len(old_record_ids - records.keys()), redirectedInventoryIds=len(redirects),
            redirectedIdsWithSamePosting=sum(item['same_posting'] for item in redirects),
            newRecordIds=len(records.keys() - old_record_ids), generatedRecords=dict(generated_records),
            applicationsBefore=len(old_apps), applicationsAfter=len(new_apps),
            addedApplications=dict(added_applications), removedApplications=len(removed_jobs),
            confirmedDuplicateGroups=len(duplicates),
            generatedDuplicatePlaceholders=sum(group['generated_owner'] for group in duplicates.values()),
            applicationStatusesBefore=dict(Counter(row['status'] for row in old_apps.values())),
            applicationStatusesAfter=dict(Counter(row['status'] for row in new_apps.values())),
            recordSubmissionStatuses=dict(Counter(row['status'] for row in records.values())),
            confirmationDowngradesReported=len(downgrade_ids),
            archivedRows=sum(value['archived'] for value in evidence.values()),
            protectedTablesUnchanged=all(value['missing'] == value['added'] == 0 for value in protected_tables.values()),
            statusChanges=dict(changed_statuses), failures=failures)
        return dict(summary=summary, inventoryRedirects=redirects, missingMappings=lost_mappings,
                    mismatchedPostingMappings=mismatched_postings,
                    generatedRecords=generated_record_details, addedApplications=added_application_details,
                    removedApplications=removed_jobs, removedApplicationDetails=removed_details, statusChanges=changed_status_details,
                    duplicateMerges=[{**{name: group[name] for name in ('source_job_ids', 'owner_job_id', 'canonical_job_id', 'application_id')},
                        'generated_job_ids': [group['owner_job_id']] if group['generated_owner'] else [],
                        'origin': 'confirmed_duplicate_merge'} for group in duplicates.values()],
                    archivedTables=evidence, protectedTables=protected_tables)


def main():
    # Direct source-tree invocation uses its adjacent service package; release
    # images without that directory continue to use the installed wheel.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = reconcile(args.before, args.after)
    with args.report.open('x', encoding='utf-8') as destination:
        json.dump(result, destination, ensure_ascii=False, indent=2)
    print(json.dumps(result['summary'], ensure_ascii=False, sort_keys=True))
    return 0 if result['summary']['verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
