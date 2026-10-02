"""Run inside the OLD image, without networking, against a disposable DB copy.

Pass the bundle from recover_legacy.py. The candidate and its verified complete
v2 backup remain untouched. This checks real old startup/reads/Profile/settings
writes, plus SQL rejection of old application writes. No server is started.
"""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile


def verify(bundle):
    from jobs_radar.store import Store
    from jobs_radar.server import create_server
    from jobs_radar.profiles import Profiles
    from jobs_radar.management import Management
    from jobs_radar.application_progress import ApplicationProgress

    bundle = Path(bundle).resolve(strict=True)
    report = json.loads((bundle / 'report.json').read_text(encoding='utf-8'))
    if report.get('mode') != 'offline-only' or report.get('onlineRollbackReady') is not False:
        raise ValueError('An offline recovery bundle is required')
    with tempfile.TemporaryDirectory(prefix='old-runtime-check-', dir=bundle) as directory:
        candidate = Path(directory) / 'disposable.sqlite'
        with closing(sqlite3.connect((bundle / 'candidate.sqlite').as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(candidate)) as destination:
                source.backup(destination)
        store = Store(candidate)
        # Imports and construction exercise old MCP, web, management and auth
        # initialization, but do not bind a port or dispatch queued commands.
        create_server(store, 'https://offline-recovery.invalid')
        rows, cursor = [], None
        while True:
            page = ApplicationProgress(store).list(limit=100, cursor=cursor)
            rows.extend(page['applications'])
            cursor = page['next_cursor']
            if cursor is None:
                break
        if len(rows) != report['applicationProjection']['confirmedRecords']:
            raise ValueError('Old application reader lost a projected confirmed record')
        management = Management(store)
        snapshot = management.snapshot()
        if len(snapshot['appliedList']['value']) != len(rows):
            raise ValueError('Old management reader disagrees with the projected inventory')
        settings = snapshot.get('settings', {'value': {}, 'revision': 0})
        changed = dict(settings['value'], recoveryRehearsal=True)
        management.write([dict(key='settings', value=changed, revision=settings['revision'])])
        if management.snapshot()['settings']['value'] != changed:
            raise ValueError('Old settings writer failed to preserve its update')
        profiles = Profiles(store)
        listed = profiles.request('/api/ext/sync/profile/list', 'GET')
        if listed:
            current = profiles.request('/api/ext/sync/profile?id=' + listed[0]['id'], 'GET')
            value = current['profile']
            original_resume = value.get('resumeData')
            value['profileName'] = 'Offline recovery verification'
            profiles.request('/api/ext/sync/profile', 'POST', dict(profile=value, id=current['id'], expected_sync=current['last_sync']))
            checked = profiles.request('/api/ext/sync/profile?id=' + current['id'], 'GET')
            if checked['profile']['profileName'] != value['profileName'] or checked['profile'].get('resumeData') != original_resume:
                raise ValueError('Old Profile writer failed to retain profile and attachment')
        try:
            management.write([dict(key='appliedList', value=[], revision=snapshot['appliedList']['revision'])])
        except sqlite3.IntegrityError as error:
            if 'Offline recovery' not in str(error):
                raise
        else:
            # An already-empty list can be idempotent, so exercise the SQL
            # barrier directly as well instead of assuming it always mutates.
            with store.connect(True) as connection:
                try:
                    connection.execute("UPDATE management_documents SET value='[]' WHERE key='appliedList'")
                except sqlite3.IntegrityError as error:
                    if 'Offline recovery' not in str(error):
                        raise
                else:
                    raise ValueError('Old application writes were not blocked')
        return dict(oldRuntime='passed', confirmedRecords=len(rows), profilesRead=len(listed),
                    nonApplicationWrites='passed', applicationWriteGuard='passed', network='not started',
                    onlineRollbackReady=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    print(json.dumps(verify(parser.parse_args().bundle), sort_keys=True))
