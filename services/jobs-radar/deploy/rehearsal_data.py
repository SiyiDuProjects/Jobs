"""Synthetic data only, used by the isolated real-Docker release rehearsal."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid
from datetime import datetime, timezone

OWNER_COOKIE = 'synthetic-rehearsal-owner-not-a-real-secret'
REVOKED_COOKIE = 'synthetic-rehearsal-revoke-not-a-real-secret'


def fingerprint(path):
    with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        result = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            quoted = '"' + table.replace('"', '""') + '"'
            rows = sorted(json.dumps(row, sort_keys=True, default=lambda value: value.hex()) for row in db.execute('SELECT * FROM ' + quoted))
            result[table] = {'count': len(rows), 'hash': hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
        return result


def maintenance(path):
    try:
        (Path(path).parent / '.release-maintenance').stat()
    except FileNotFoundError:
        return {'active': False}
    return {'active': True}


def seed(path, schema):
    assert not Path(path).exists(), 'Synthetic seed must not overwrite an existing database'
    with sqlite3.connect(path) as db:
        db.executescript(Path(schema).read_text())
        db.execute("INSERT INTO management_documents VALUES('appliedList','[]',1)")
        db.execute("INSERT INTO management_documents VALUES('settings','{\"automatic\":false}',1)")
        db.execute("INSERT INTO oauth_tokens VALUES('rehearsal-revoke','access','{}',9999999999,'rehearsal')")
    return {'syntheticSeed': True}


def write(path):
    from jobs_radar.store import Store
    from jobs_radar.profiles import Profiles
    from jobs_radar.extension_sync import ExtensionSync, EXTENSION_ID
    store = Store(path)
    profiles = Profiles(store)
    profiles.save(dict(profileName='Rehearsal new Profile', nameData={'firstName': 'Synthetic', 'lastName': 'Fixture'},
        addressData={}, contactData={}, jobData=[], educationData=[], languageData=[], resumeData={}, websiteData={}, employmentData={}))
    urls = ['https://rehearsal.invalid/confirmed', 'https://rehearsal.invalid/unknown']
    store.ingest('simplify:newgrad', [dict(source='simplify', source_id=str(index), apply_url=url,
        title='Synthetic engineer', company='Synthetic fixture', locations=['CA'], kind='newgrad',
        posted_at=time.time()-10, active=True, visible=True) for index, url in enumerate(urls)], 'rehearsal')
    sync = ExtensionSync(store)
    device = str(uuid.uuid4())
    sync.pair(device, EXTENSION_ID)
    for url, proof in zip(urls, ('ats_confirmation', 'submit_attempt')):
        sync.receive(device, dict(event_id=str(uuid.uuid4()), job_url=url, job_title='Synthetic engineer',
            company='Synthetic fixture', observed_at=datetime.now(timezone.utc).isoformat(), proof=proof))
    # A plain attempt is an Applied record under the current contract. Produce
    # the actual post-submit error needed to rehearse preservation of an
    # uncertain submission, rather than changing the runtime status policy.
    sync.receive(device, dict(event_id=str(uuid.uuid4()), job_url=urls[1], job_title='Synthetic engineer',
        company='Synthetic fixture', observed_at=datetime.now(timezone.utc).isoformat(),
        proof='submit_validation_error', detail='Synthetic post-submit validation failure'))
    with store.connect(True) as db:
        db.execute("DELETE FROM oauth_tokens WHERE hash='rehearsal-revoke'")
        db.execute("INSERT INTO oauth_tokens VALUES('rehearsal-new','access','{}',9999999999,'rehearsal')")
        db.execute("UPDATE management_documents SET value='{\"automatic\":true}',revision=revision+1 WHERE key='settings'")
        for name, token in (('owner', OWNER_COOKIE), ('revoke', REVOKED_COOKIE)):
            db.execute('INSERT INTO web_sessions VALUES(?,?,?,?,1)',
                       (hashlib.sha256(token.encode()).hexdigest(), 'rehearsal-' + name, time.time(), time.time()+7200))
    return {'newProfile': True, 'newConfirmed': True, 'newUnknown': True, 'authRevocation': True, 'newGrant': True}


def active_database(path):
    from jobs_radar.restricted_recovery import active_recovery
    bundle = active_recovery(path)
    return bundle / 'recovery.sqlite' if bundle else path


def recovery_invariants(path):
    path = active_database(path)
    result = fingerprint(path)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM oauth_tokens WHERE hash='rehearsal-revoke'").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM oauth_tokens WHERE hash='rehearsal-new'").fetchone()[0] == 1
        states = dict(db.execute('SELECT status,count(*) FROM applications GROUP BY status'))
        assert states == {'submitted': 1, 'submitted_unconfirmed': 1}, states
    return {name: result[name] for name in ('applications', 'application_events', 'oauth_tokens')}


def content_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def recovery_state(path):
    with sqlite3.connect(active_database(path)) as db:
        profiles = db.execute('SELECT profile FROM owner_profiles WHERE deleted=0').fetchall()
        assert len(profiles) == 1
        settings = json.loads(db.execute("SELECT value FROM management_documents WHERE key='settings'").fetchone()[0])
        revoked = not db.execute('SELECT 1 FROM web_sessions WHERE hash=?', (hashlib.sha256(REVOKED_COOKIE.encode()).hexdigest(),)).fetchone()
    return dict(profile=content_hash(json.loads(profiles[0][0])), settings=content_hash(settings), revoked=revoked)


def http_recovery(mode, label='during-recovery', request=None):
    """Actual urllib transport in the Compose service; hashes only in output."""
    if request is None:
        import urllib.request
        import urllib.error
        def request(method, path, payload=None, token=OWNER_COOKIE):
            body = None if payload is None else json.dumps(payload).encode()
            query = urllib.request.Request('http://127.0.0.1:8796' + path, data=body, method=method,
                headers={'Cookie': 'radar_browser=' + token, 'Origin': 'https://jobs.siyidu.com',
                         'Content-Type': 'application/json', 'X-Jobs-Protocol': '2'})
            try:
                with urllib.request.urlopen(query, timeout=3) as response:
                    raw = response.read(2*1024**2+1); status = response.status
            except urllib.error.HTTPError as error:
                raw, status = error.read(65536), error.code
            assert len(raw) <= 2*1024**2
            return status, json.loads(raw)
    def ok(method, path, payload=None, token=OWNER_COOKIE):
        status, value = request(method, path, payload, token)
        assert status == 200, (method, path, status)
        return value
    profiles = ok('GET', '/api/manage/profiles')
    assert len(profiles) == 1
    path = '/api/manage/profiles/' + profiles[0]['id']
    profile = ok('GET', path)
    settings = ok('GET', '/api/manage/state')['settings']
    if mode == 'http-edit':
        profile['profile']['profileName'] = 'Synthetic recovery edit ' + label
        ok('PUT', path, dict(profile=profile['profile'], expected_sync=profile['last_sync']))
        value = dict(settings['value'], rehearsal=label, automatic=False)
        ok('POST', '/api/manage/state', dict(changes=[dict(key='settings', revision=settings['revision'], value=value)]))
        ok('DELETE', '/api/session', token=REVOKED_COOKIE)
        checked = ok('GET', path)
        assert checked['profile'] == profile['profile']
        checked_settings = ok('GET', '/api/manage/state')['settings']
        assert checked_settings['value'] == value
        profile, settings = checked, checked_settings
    assert request('GET', '/api/manage/profiles', None, REVOKED_COOKIE)[0] == 401
    health = ok('GET', '/healthz')
    if health.get('mode') == 'restricted-profile-settings':
        for route in ('/api/manage/applications', '/api/extension/events'):
            status, body = request('POST', route, {}, OWNER_COOKIE)
            assert status == 503 and body.get('code') == 'recovery_application_pause'
    return dict(profile=content_hash(profile['profile']), settings=content_hash(settings['value']), revoked=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['seed', 'write', 'fingerprint', 'maintenance', 'recovery-invariants', 'recovery-state', 'http-edit', 'http-verify'])
    parser.add_argument('database', type=Path)
    parser.add_argument('--schema', type=Path)
    parser.add_argument('--label', default='during-recovery')
    args = parser.parse_args()
    if args.mode == 'seed': result = seed(args.database, args.schema)
    elif args.mode.startswith('http-'): result = http_recovery(args.mode, args.label)
    else: result = {'write': write, 'maintenance': maintenance, 'fingerprint': fingerprint,
                   'recovery-invariants': recovery_invariants, 'recovery-state': recovery_state}[args.mode](args.database)
    print(json.dumps(result, sort_keys=True))
