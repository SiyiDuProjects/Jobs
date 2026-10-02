"""Restore native extension Applied records hidden by the confirmation gate.

Called only by the transactional release migration, including its isolated
dry-run. Original receipt payloads, confirmation facts and progress are retained.
"""
import json
import time

from .application_records import write_state
from .submission_events import blocked_by_owner_undo

VERSION = 'native-extension-submission-reporting-v1'
NATIVE_PROOFS = {'submit_attempt', 'tracker_record', 'extension_tracker'}


def migrate(connection):
    done = connection.execute('SELECT report FROM schema_migrations WHERE name=?', (VERSION,)).fetchone()
    if done:
        return {**json.loads(done[0]), 'already_applied': True}
    changed = []
    for app in connection.execute("SELECT * FROM applications WHERE status='submitted_unconfirmed' AND deleted=0 AND coalesce(submission_error,'')=''").fetchall():
        evidence = json.loads(app['evidence'] or '[]')
        native = [e for e in evidence if e.get('type') in NATIVE_PROOFS
                  and e.get('reported_by') == 'jobs-extension'
                  and not blocked_by_owner_undo(connection, app['job_id'], e.get('observed_at', ''))]
        if not native:
            continue
        write_state(connection, app['job_id'], {
            'status': 'submitted', 'detail': '插件已记录投递', 'updated': time.time(),
        }, version_step=1, reason=VERSION)
        connection.execute('UPDATE owner_submission_undo SET version=? WHERE job_id=? AND version=?',
                           (app['version'] + 1, app['job_id'], app['version']))
        changed.append(app['job_id'])
    report = {'version': VERSION, 'changed': len(changed), 'job_ids': changed}
    connection.execute('INSERT INTO schema_migrations VALUES(?,?,?)', (VERSION, time.time(), json.dumps(report)))
    return report
