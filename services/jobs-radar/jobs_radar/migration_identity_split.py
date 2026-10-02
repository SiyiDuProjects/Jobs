"""Split legacy multi-posting IDs only when existing evidence pins one outcome.

This runs inside the explicit applications-v2 migration transaction, never in
normal ingestion. Complete pre-split rows remain migration evidence. A review
without a unique posting URL becomes pending rather than spreading to new jobs.
"""
import json
import time

from .identity import stable_id
from .job_match import job_key


# These are historical/operational references to the old job, not independent
# posting records. They stay with the evidence anchor and never copy to children.
ANCHOR_REFERENCES = {
    'audit', 'claims', 'claim_purposes', 'recruiting_events', 'recruiting_progress',
    'extension_receipts', 'application_progress_pending', 'application_events',
    'screening_seen', 'screening_batch_items', 'screening_rechecks',
}
HANDLED_REFERENCES = {'applications', 'observations', 'search_index', 'job_screening',
                      'job_role_family', 'web_opened', 'owner_submission_undo'}


def references(value):
    if isinstance(value, dict):
        for name, item in value.items():
            if name in {'reference', 'job_url', 'url'} and isinstance(item, str):
                yield item
            elif isinstance(item, (dict, list)):
                yield from references(item)
    elif isinstance(value, list):
        for item in value:
            yield from references(item)


def matching_keys(value, candidates):
    result = set()
    for url in references(value):
        try:
            key = job_key(url)
        except ValueError:
            continue
        if key in candidates:
            result.add(key)
    return result


def split_legacy_identities(c, retired, archive):
    groups = {}
    for row in c.execute("SELECT job_id,stream,source_id,first_seen,last_seen,json_extract(payload,'$.kind') kind,json_extract(payload,'$.apply_url') url FROM observations"):
        key = job_key(row['url']) if row['url'] else None
        if key:
            groups.setdefault(row['job_id'], {}).setdefault(key, []).append(dict(row))
    reports = []
    for original_id, postings in sorted(groups.items()):
        if len(postings) <= 1:
            continue
        app = c.execute('SELECT * FROM applications WHERE job_id=?', (original_id,)).fetchone()
        if not app:
            raise ValueError('Identity split requires an existing application: ' + original_id)
        if c.execute('SELECT 1 FROM job_aliases WHERE alias_id=? OR canonical_id=?', (original_id, original_id)).fetchone():
            raise ValueError('Identity split requires explicit alias review: ' + original_id)
        retained_references = {}
        for (table,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
            quoted = '"' + table.replace('"', '""') + '"'
            if 'job_id' not in {row[1] for row in c.execute('PRAGMA table_info(' + quoted + ')')}:
                continue
            count = c.execute('SELECT count(*) FROM ' + quoted + ' WHERE job_id=?', (original_id,)).fetchone()[0]
            if not count:
                continue
            if table not in ANCHOR_REFERENCES | HANDLED_REFERENCES:
                raise ValueError('Identity split has an unreviewed reference table: ' + table)
            if table in ANCHOR_REFERENCES:
                retained_references[table] = count
        anchors = matching_keys(json.loads(app['evidence'] or '[]'), postings)
        for receipt in retired.get('extension_receipts', []):
            if receipt.get('job_id') == original_id:
                anchors |= matching_keys(json.loads(receipt['payload']), postings)
        if len(anchors) != 1:
            raise ValueError('Identity split requires exactly one evidence anchor: ' + original_id)
        anchor = next(iter(anchors))
        mapping = {key: original_id if key == anchor else stable_id(key) for key in postings}
        for key, target in mapping.items():
            if target != original_id and c.execute('SELECT 1 FROM jobs WHERE id=? OR identity=?', (target, key)).fetchone():
                raise ValueError('Identity split collides with an existing job: ' + target)
        # An unresolved observation cannot safely keep sharing the old anchor.
        unresolved = c.execute("SELECT count(*) FROM observations WHERE job_id=?", (original_id,)).fetchone()[0] - sum(map(len, postings.values()))
        if unresolved:
            raise ValueError('Identity split has observations without a posting key: ' + original_id)
        originals = {}
        for table, id_column in (('jobs', 'id'), ('applications', 'job_id'), ('observations', 'job_id'),
                                 ('search_index', 'job_id'), ('job_screening', 'job_id'), ('job_role_family', 'job_id'),
                                 ('web_opened', 'job_id'), ('owner_submission_undo', 'job_id')):
            originals[table] = [dict(row) for row in c.execute(f'SELECT * FROM {table} WHERE {id_column}=?', (original_id,))]
            archive(c, table, originals[table])
        for key, rows in postings.items():
            target = mapping[key]
            if target != original_id:
                c.execute('INSERT INTO jobs(id,identity,first_seen,last_seen,job_key) VALUES(?,?,?,?,?)',
                          (target, key, min(row['first_seen'] for row in rows), max(row['last_seen'] for row in rows), key))
                c.execute("INSERT INTO applications(job_id,status,version,updated,job_key) VALUES(?,'not_started',0,?,?)", (target, time.time(), key))
            else:
                c.execute('UPDATE jobs SET job_key=? WHERE id=?', (key, original_id))
                c.execute('UPDATE applications SET job_key=? WHERE job_id=?', (key, original_id))
            for row in rows:
                c.execute('UPDATE observations SET job_id=? WHERE stream=? AND source_id=?', (target, row['stream'], row['source_id']))
                c.execute('UPDATE search_index SET job_id=? WHERE stream=? AND source_id=?', (target, row['stream'], row['source_id']))
        pending, moved = [], []
        for table in ('job_screening', 'job_role_family'):
            c.execute(f'DELETE FROM {table} WHERE job_id=?', (original_id,))
            for review in originals[table]:
                keys = matching_keys(json.loads(review.get('evidence') or '[]'), postings)
                eligible = {key for key in keys if any(row['kind'] == review['kind'] for row in postings[key])}
                if len(keys) != 1 or len(eligible) != 1:
                    pending.append(dict(table=table, old_job_id=original_id, kind=review['kind'], reason='review_posting_not_unique'))
                    continue
                key = next(iter(eligible))
                from .board import fingerprint
                sources = [json.loads(row[0]) for row in c.execute("SELECT payload FROM observations WHERE job_id=? AND json_extract(payload,'$.kind')=?", (mapping[key], review['kind']))]
                review = {**review, 'job_id': mapping[key], 'fingerprint': fingerprint(sources)}
                names = list(review)
                c.execute(f"INSERT INTO {table}({','.join(names)}) VALUES({','.join('?' for _ in names)})", list(review.values()))
                moved.append(dict(table=table, old_job_id=original_id, job_id=mapping[key], kind=review['kind']))
        # An opened-kind hint belongs to the old merged posting and carries no
        # field identifying which one. Its audit stays archived, not authoritative.
        c.execute('DELETE FROM web_opened WHERE job_id=?', (original_id,))
        undo_reviews_archived = 0
        for undo in originals['owner_submission_undo']:
            kept_reviews = []
            for review in json.loads(undo['reviews']):
                if (matching_keys(json.loads(review.get('evidence') or '[]'), postings) == {anchor}
                        and any(row['kind'] == review['kind'] for row in postings[anchor])):
                    kept_reviews.append(review)
                else:
                    undo_reviews_archived += 1
            # Preserve the original application snapshot, fencing version and
            # expiry exactly. Only ambiguous review replay is disabled; all its
            # original rows remain in the archived complete undo object.
            c.execute('UPDATE owner_submission_undo SET reviews=? WHERE job_id=?',
                      (json.dumps(kept_reviews, ensure_ascii=False), original_id))
        needs_screening = []
        for key, rows in postings.items():
            for kind in sorted({row['kind'] for row in rows if row['kind'] in {'newgrad', 'internship'}}):
                target = mapping[key]
                if c.execute('SELECT 1 FROM job_screening WHERE job_id=? AND kind=?', (target, kind)).fetchone():
                    continue
                sources = [json.loads(row[0]) for row in c.execute("SELECT payload FROM observations WHERE job_id=? AND json_extract(payload,'$.kind')=?", (target, kind))]
                from .board import fingerprint
                c.execute("INSERT INTO job_screening VALUES(?,?,'pending','identity_split_review',?,'[]',?,?,NULL,1,0)",
                    (target, kind, '旧岗位标识曾合并多个职位；原筛选证据已保留，需要按独立职位重新筛选。', fingerprint(sources), time.time()))
                needs_screening.append(dict(job_id=target, kind=kind))
        reports.append(dict(old_job_id=original_id, anchor_job_key=anchor,
            postings=[dict(job_key=key, job_id=mapping[key], observations=len(postings[key])) for key in sorted(postings)],
            moved_reviews=moved, archived_reviews=pending, screening_required=needs_screening,
            undo_reviews_archived=undo_reviews_archived, retained_anchor_references=retained_references))
    return reports
