"""Employment type belongs to an application, independently of its Profile."""
import json
import re

KINDS = {'newgrad', 'internship', 'unknown'}


def resolve(c, job_id, value, *, legacy=False):
    if value.get('kind') in KINDS:
        return value['kind']
    kinds = {r[0] for r in c.execute("SELECT DISTINCT json_extract(payload,'$.kind') FROM observations WHERE job_id=?", (job_id,))}
    kinds = {'internship' if k == 'intern' else k for k in kinds} & {'newgrad', 'internship'}
    if len(kinds) == 1:
        return next(iter(kinds))
    if len(kinds) > 1:
        return 'unknown'
    title = value.get('jobTitle', '')
    if re.search(r'\b(?:intern(?:ship)?|co[ -]?op)\b|实习', title, re.I):
        return 'internship'
    if re.search(r'\b(?:new[ -]?(?:grad(?:uate)?|college)|recent[ -]?grad|graduate|full[ -]?time)\b|全职', title, re.I):
        return 'newgrad'
    # One-time import of the historical record snapshot, never a live Profile lookup.
    if legacy:
        return {'Newgrad': 'newgrad', 'Intern': 'internship'}.get(value.get('profileName'), 'unknown')
    return 'unknown'


def backfill(c):
    marker = 'application-employment-kind-v1'
    if c.execute('SELECT 1 FROM schema_migrations WHERE name=?', (marker,)).fetchone():
        return
    import time
    counts = dict.fromkeys(KINDS, 0)
    for app in c.execute('SELECT job_id,record FROM applications WHERE record IS NOT NULL').fetchall():
        value = json.loads(app['record'])
        value['kind'] = resolve(c, app['job_id'], value, legacy=True)
        counts[value['kind']] += 1
        c.execute('UPDATE applications SET record=?,record_version=record_version+1 WHERE job_id=?',
                  (json.dumps(value, ensure_ascii=False), app['job_id']))
    c.execute('INSERT INTO schema_migrations VALUES(?,?,?)', (marker, time.time(), json.dumps(counts)))
