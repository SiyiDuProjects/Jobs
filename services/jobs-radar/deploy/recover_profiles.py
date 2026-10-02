"""Committed release driver for explicit Profile/settings-only recovery.

No rollback occurs here. Any failure after quiescing leaves maintenance and
timers stopped, preserves every database, and requires inspection of the journal.
Helpers use full image IDs and the shared release container ownership ledger.
"""
import argparse
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import uuid

from release_helpers import Containers, bounded

TOTAL_SECONDS = 1800
STEP_SECONDS = 180
TIMERS = ('jobs-radar-collect.timer', 'jobs-radar-backup.timer')
SERVICES = ('jobs-radar-collect.service', 'jobs-radar-backup.service')
RECOVERY = 'restricted-profile-settings'
CODE = 'recovery_application_pause'
DATA_CHECK = '''
from pathlib import Path
import stat
path=Path('/data/jobs.sqlite')
assert not path.is_symlink() and stat.S_ISREG(path.stat().st_mode), 'Live database must be a local regular file'
'''


def require(condition, message):
    if not condition:
        raise ValueError(message)


def promote_latest(database, bundle, timeout=160):
    """Inside the stopped service's helper: preserve live, then atomic promotion."""
    from jobs_radar.restricted_recovery import (
        active_recovery, connection, copy_database, file_hash, fingerprint,
        manifest, service_lock, small_json, sync_directory, MIN_FREE_BYTES,
    )
    import shutil
    database, bundle = Path(database), Path(bundle)
    require(active_recovery(database) == bundle.resolve(), 'Recovery marker differs')
    require((database.parent / '.release-maintenance').is_file(), 'Keep maintenance active')
    require((bundle / '.pause-profile-writes').is_file(), 'Pause Profile writes first')
    deadline = time.monotonic() + timeout
    report, prepared = small_json(bundle / 'resume-report.json', 256 * 1024), manifest(bundle)
    require((report.get('release'), report.get('imageId')) ==
            (prepared['release'], prepared['imageId']), 'Resume identity differs')
    source = bundle / 'resume-v2.sqlite'
    require(not source.is_symlink() and file_hash(source, deadline=deadline) == report['sha256'],
            'Resume bytes changed')
    require(fingerprint(source, deadline=deadline) == report['data'], 'Resume tables changed')
    backup = bundle / 'before-resume-live.sqlite'
    pending = database.with_name(database.name + '.resume-pending')
    require(not pending.exists() and not pending.is_symlink(), 'Pending promotion needs review')
    require(shutil.disk_usage(database.parent).free > source.stat().st_size +
            database.stat().st_size + MIN_FREE_BYTES, 'Insufficient promotion disk budget')
    with service_lock(bundle):
        copy_database(database, backup, deadline)
        require(fingerprint(backup, deadline=deadline) == fingerprint(database, deadline=deadline),
                'Pre-resume live backup verification failed')
        # Writers are stopped by the host. Remove no sidecars until SQLite has
        # successfully checkpointed all original writes into the retained file.
        with connection(database, deadline=deadline) as db:
            require(tuple(db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()) in
                    {(0, 0, 0), (0, -1, -1)}, 'Live WAL checkpoint is busy')
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(database) + suffix)
            require(not sidecar.is_symlink(), 'Database sidecar is a symbolic link')
            if sidecar.exists():
                require(suffix != '-wal' or sidecar.stat().st_size == 0, 'Live WAL is not empty')
                sidecar.unlink()
        # Copy exact export bytes, rather than a backup transformation, so the
        # marker clearer can prove that the latest, verified export is live.
        with source.open('rb') as original, pending.open('xb') as output:
            os.chmod(pending, 0o600)
            while chunk := original.read(256 * 1024):
                require(time.monotonic() < deadline, 'Promotion deadline exceeded')
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        require(file_hash(pending, deadline=deadline) == report['sha256'], 'Promotion copy changed')
        os.replace(pending, database)
        sync_directory(database.parent)
        require(fingerprint(database, deadline=deadline) == report['data'], 'Promoted data differs')


def inside_step(action, bundle, release, image_id):
    """Small fixed-scope file mutations run as data owner inside the image."""
    from jobs_radar.restricted_recovery import active_recovery, scoped_bundle, sync_directory
    data, database = Path('/data'), Path('/data/jobs.sqlite')
    maintenance = data / '.release-maintenance'
    if action not in {'maintenance', 'hold-failure'}:
        from jobs_radar.restricted_recovery import manifest
        report = manifest(scoped_bundle(database, bundle))
        require((report['release'], report['imageId']) == (release, image_id),
                'Recovery bundle does not belong to the verified live image')
    if action == 'hold-failure':
        require(not maintenance.is_symlink(), 'Maintenance is a symbolic link')
        if not maintenance.exists():
            with maintenance.open('x') as output:
                output.flush(); os.fsync(output.fileno())
        require(maintenance.is_file(), 'Maintenance must be a regular file')
        sync_directory(data)
    elif action == 'maintenance':
        require(active_recovery(database) is None, 'Recovery marker already exists')
        with maintenance.open('x', encoding='utf-8') as output:
            output.write('Restricted recovery transaction; application execution paused.\n')
            output.flush(); os.fsync(output.fileno())
        (data / 'migrations').mkdir(mode=0o700, exist_ok=True)
        require(not (data / 'migrations').is_symlink(), 'Migration directory must be local')
        sync_directory(data)
    elif action == 'pause-profiles':
        actual = active_recovery(database)
        require(actual == scoped_bundle(database, bundle), 'Recovery bundle differs')
        require(maintenance.is_file() and not maintenance.is_symlink(), 'Maintenance is absent')
        with (actual / '.pause-profile-writes').open('x') as output:
            output.flush(); os.fsync(output.fileno())
        sync_directory(actual)
    elif action == 'promote':
        promote_latest(database, scoped_bundle(database, bundle))
    elif action == 'verify-cleared':
        from jobs_radar.restricted_recovery import file_hash, fingerprint, small_json, manifest
        actual = scoped_bundle(database, bundle)
        report, prepared = small_json(actual / 'resume-report.json', 256 * 1024), manifest(actual)
        require(active_recovery(database) is None and maintenance.is_file() and
                (actual / '.pause-profile-writes').is_file(), 'Resume pause boundary differs')
        require((report.get('release'), report.get('imageId')) ==
                (prepared['release'], prepared['imageId']), 'Resume identity differs')
        deadline = time.monotonic() + 160
        require(file_hash(actual / 'resume-v2.sqlite', deadline=deadline) == report['sha256'] and
                file_hash(database, deadline=deadline) == report['sha256'] and
                fingerprint(database, deadline=deadline) == report['data'], 'Cleared marker lacks latest data proof')
    elif action == 'release-maintenance':
        require(active_recovery(database) is None, 'Recovery marker remains')
        require(maintenance.is_file() and not maintenance.is_symlink(), 'Maintenance is absent')
        maintenance.unlink(); sync_directory(data)
    else:
        raise ValueError('Unknown internal recovery step')


PROBE = r'''
import hashlib,json,re,time,urllib.request,urllib.error
from pathlib import Path
import jobs_radar
mode,release=__import__('sys').argv[1:]
base='http://127.0.0.1:8796'
def fetch(path):
    try:
        with urllib.request.urlopen(base+path,timeout=2) as response:
            return response.status,response.read(4*1024*1024+1)
    except urllib.error.HTTPError as error:
        return error.code,error.read(65536)
deadline=time.monotonic()+45
while True:
    try:
        status,raw=fetch('/healthz'); health=json.loads(raw)
        assert status==200
        break
    except Exception:
        if time.monotonic()>=deadline: raise
        time.sleep(.25)
if mode=='restricted-profile-settings':
    assert health.get('mode')==mode and health.get('applicationWrites')=='paused' and health.get('release')==release
else:
    assert health.get('mode')!='restricted-profile-settings'
status,page=fetch('/manage/')
assert status==200 and len(page)<=2*1024*1024
static=Path(jobs_radar.__file__).parent/'static'
html=page.decode('utf-8')
expected_html=(static/'manage/index.html').read_text(encoding='utf-8')
if mode=='restricted-profile-settings':
    from jobs_radar.restricted_recovery import MESSAGE
    banner='<aside role="status" style="position:sticky;top:0;z-index:9999;background:#fff4cc;color:#382b00;padding:12px;text-align:center">'+MESSAGE+'</aside>'
    expected_html=expected_html.replace('<body>','<body>'+banner,1)
assert html==expected_html
references=re.findall(r'(?:src|href)=["\']([^"\']+)["\']',html)
assets=[p.split('?')[0] for p in references if p.startswith('/assets/')]
assert set(assets)=={'/assets/board.js','/assets/board.css'} and len(assets)==2
hashes={}
for path in assets:
    assert re.fullmatch(r'/assets/[a-zA-Z0-9._-]+',path)
    status,body=fetch(path)
    assert status==200 and len(body)<=4*1024*1024
    expected=(static/Path(path).name).read_bytes()
    assert body==expected
    hashes[path]=hashlib.sha256(body).hexdigest()
status,body=fetch('/api/manage/profiles')
if mode=='applications-held':
    assert Path('/data/.release-maintenance').is_file()
    assert status==503 and json.loads(body).get('error')=='Service update in progress; retry after the update'
else:
    assert status==401
if mode=='restricted-profile-settings':
    for path in ('/.well-known/oauth-authorization-server','/mcp','/api/extension/profiles','/api/extension/control','/api/extension/events','/api/extension/answer-jobs','/api/extension/resolve'):
        status,body=fetch(path)
        assert status==503 and json.loads(body).get('code')=='recovery_application_pause'
else:
    assert fetch('/.well-known/oauth-authorization-server')[0]==200
print(json.dumps(dict(mode=mode,release=release,assets=hashes,pageSha256=hashlib.sha256(page).hexdigest(),verified=True),sort_keys=True))
'''

PUBLIC_PROBE = r'''
import hashlib,json,sys,urllib.request,urllib.error
expected=json.loads(sys.argv[1]); base='http://127.0.0.1:8796'
def fetch(path):
    try:
        with urllib.request.urlopen(base+path,timeout=3) as reply: return reply.status,reply.read(4*1024*1024+1)
    except urllib.error.HTTPError as error: return error.code,error.read(65536)
status,body=fetch('/healthz'); health=json.loads(body); assert status==200
if expected['mode']=='restricted-profile-settings':
    assert health.get('mode')==expected['mode'] and health.get('release')==expected['release'] and health.get('applicationWrites')=='paused'
    status,body=fetch('/api/extension/events'); assert status==503 and json.loads(body).get('code')=='recovery_application_pause'
else: assert health.get('mode')!='restricted-profile-settings'
status,body=fetch('/api/manage/profiles')
if expected['mode']=='applications-held':
    assert status==503 and json.loads(body).get('error')=='Service update in progress; retry after the update'
else: assert status==401
status,body=fetch('/manage/'); assert status==200 and hashlib.sha256(body).hexdigest()==expected['pageSha256']
for path,digest in expected['assets'].items():
    status,body=fetch(path); assert status==200 and hashlib.sha256(body).hexdigest()==digest
print('verified host publication')
'''


@contextmanager
def lock(path):
    import fcntl
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class Host:
    def __init__(self, live, release, image_id):
        self.live = Path(live).resolve(strict=True)
        require(self.live == Path('/home/ubuntu/siyi/jobs-radar'), 'Unexpected live release path')
        require(not (self.live / 'data').is_symlink() and (self.live / 'data').is_dir(),
                'Live data must be the local release directory')
        require(re.fullmatch(r'[a-f0-9]{12,40}', release), 'Invalid committed release')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id), 'Full immutable image ID required')
        require(not any(os.environ.get(key) for key in
                ('COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'JOBS_RELEASE_REHEARSAL_ROOT',
                 'JOBS_RELEASE_IMAGE_PREFIX', 'JOBS_RELEASE_COMPOSE_PROJECT')), 'Compose overrides refused')
        self.release, self.image_id = release, image_id
        self.deadline = time.monotonic() + TOTAL_SECONDS
        self.state = self.live / '.release'
        require(not self.state.is_symlink(), 'Release state must be local')
        self.state.mkdir(mode=0o700, exist_ok=True)
        self.journal_path = self.state / 'restricted-active.json'
        self.containers = Containers(self.state / 'containers', 'jobs-radar', invoke=self.invoke)

    def invoke(self, args, *, timeout=30):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'Recovery transaction deadline exceeded')
        return bounded(args, timeout=min(timeout, remaining), max_output_bytes=1024 * 1024)

    def command(self, args, timeout=30, check=True):
        result = self.invoke(args, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError('Recovery command failed: ' + str(args[0]))
        return result

    def docker(self, *args, timeout=30):
        return self.command(['docker', *args], timeout).stdout.strip()

    def compose(self, *args):
        result = self.docker('compose', '--project-directory', str(self.live), *args, timeout=180)
        if args == ('stop', 'mcp'):
            value = json.loads(self.docker('inspect', self.service_id))[0]
            require(value['Id'] == self.service_id and not value['State']['Running'],
                    'Service stop is not confirmed')
        return result

    def running(self):
        ids = self.compose('ps', '-q', 'mcp').splitlines()
        require(len(ids) == 1 and re.fullmatch('[a-f0-9]{64}', ids[0]), 'One full service container ID required')
        value = json.loads(self.docker('inspect', ids[0]))[0]
        require(value['Id'] == ids[0] and value['Image'] == self.image_id and
                value['Config']['Labels'].get('release') == self.release and
                value['Config']['Labels'].get('com.docker.compose.project') == 'jobs-radar' and
                value['Config']['Labels'].get('com.docker.compose.service') == 'mcp' and
                value['State']['Running'], 'Running service identity differs')
        return ids[0]

    def preflight(self):
        self.containers.cleanup()
        require((self.live / 'RELEASE').read_text().strip() == self.release, 'LIVE release differs')
        require((Path(__file__).parent.parent / 'RELEASE').read_text().strip() == self.release,
                'Committed driver stage differs')
        for image in ('jobs-radar:0.1.0', 'jobs-radar:' + self.release, self.image_id):
            value = json.loads(self.docker('image', 'inspect', image))[0]
            require(value['Id'] == self.image_id and value['Config']['Labels'].get('release') == self.release,
                    'Published image differs from committed driver')
        # data is intentionally 10001:0700; the host release account must not
        # traverse it or change permissions. The verified image checks metadata
        # as that same data owner, without reading database rows.
        self.helper(['-c', DATA_CHECK])
        self.service_id = self.running()

    def unit_state(self, unit):
        result = self.command(['systemctl', 'is-active', unit], check=False)
        state = result.stdout.strip()
        require((result.returncode, state) in {(0, 'active'), (0, 'activating'), (0, 'reloading'),
                (0, 'deactivating'), (3, 'inactive'), (3, 'failed'), (3, 'deactivating')},
                'Cannot establish timer/writer state')
        return state

    def timer_states(self):
        return {timer: self.unit_state(timer) for timer in TIMERS}

    def stop_timers(self):
        self.command(['sudo', 'systemctl', 'stop', *TIMERS])

    def wait_writers(self):
        deadline = min(self.deadline, time.monotonic() + 180)
        while True:
            names = self.docker('ps', '--format', '{{.Names}}').splitlines()
            idle = all(self.unit_state(service) in {'inactive', 'failed'} for service in SERVICES)
            if idle and not any('jobs-radar-collector-run' in name for name in names):
                return
            require(time.monotonic() < deadline, 'Application/backup writer did not stop')
            time.sleep(1)

    def helper(self, args, timeout=STEP_SECONDS, detached=False, name=None):
        return self.containers.start('jobs-radar:' + self.release, args,
            image_id=self.image_id, memory=512, timeout=timeout, detached=detached, name=name,
            mounts=[str(self.live / 'data') + ':/data'],
            environment=['JOBS_DB=/data/jobs.sqlite', 'JOBS_HOST=127.0.0.1',
                         'JOBS_PORT=8796', 'JOBS_ORIGIN=https://jobs.siyidu.com'])

    def step(self, action, bundle):
        self.helper(['/app/deploy/recover_profiles.py', 'inside', action, bundle, self.release, self.image_id])

    def prepare(self, bundle):
        args = ['--current', '/data/jobs.sqlite', '--bundle', '/data/' + bundle,
                '--release', self.release, '--image-id', self.image_id]
        self.helper(['/app/deploy/prepare_restricted_recovery.py', 'prepare', *args, '--timeout', '160'])

    def write_marker(self, bundle):
        args = ['--current', '/data/jobs.sqlite', '--bundle', '/data/' + bundle,
                '--release', self.release, '--image-id', self.image_id]
        self.helper(['/app/deploy/prepare_restricted_recovery.py', 'write-marker', *args])

    def export(self, bundle):
        self.helper(['/app/deploy/prepare_restricted_recovery.py', 'export-resume',
                     '--bundle', '/data/' + bundle, '--timeout', '160'])

    def clear_marker(self, bundle):
        try:
            self.helper(['/app/deploy/prepare_restricted_recovery.py', 'clear-marker',
                         '--current', '/data/jobs.sqlite', '--timeout', '160'])
        except Exception:
            # A dropped response is not evidence of failure or success. Only a
            # fresh complete data comparison to this journal's export permits it.
            self.step('verify-cleared', bundle)

    def probe(self, mode, public=False):
        if public:
            container = self.running()
            result = json.loads(self.docker('exec', container, 'python', '-c', PROBE,
                                           mode, self.release, timeout=60))
            self.command([sys.executable, '-c', PUBLIC_PROBE, json.dumps(result)], timeout=60)
            return result
        name = 'jobs-radar-recovery-probe-' + uuid.uuid4().hex
        try:
            self.helper(['-m', 'jobs_radar.cli', 'serve'], detached=True, name=name)
            value = json.loads(self.docker('inspect', name))[0]
            require(value['Image'] == self.image_id, 'Private probe image changed')
            return json.loads(self.docker('exec', value['Id'], 'python', '-c', PROBE,
                                          mode, self.release, timeout=60))
        finally:
            self.containers.cleanup(name)

    def save(self, value):
        self.containers.save(self.journal_path, value)

    def load(self):
        require(not self.journal_path.is_symlink() and self.journal_path.stat().st_size <= 16384,
                'Invalid recovery journal')
        return json.loads(self.journal_path.read_text())

    def restore_timers(self, states):
        for timer in TIMERS:
            if states[timer] in {'active', 'activating', 'reloading'}:
                self.command(['sudo', 'systemctl', 'start', timer])

    def fail(self, journal):
        # Reserve a separate, fixed cleanup window after the transaction budget.
        self.deadline = time.monotonic() + 90
        errors = []
        for name, action in [('timers', self.stop_timers),
                             ('maintenance', lambda: self.step('hold-failure', journal['bundle'])),
                             ('service', lambda: self.compose('stop', 'mcp')),
                             ('helpers', self.containers.cleanup)]:
            try:
                action()
            except BaseException:
                errors.append(name)
        journal.update(status='failed-needs-review', stopUncertain=errors)
        self.save(journal)


def transaction(host, mode):
    """Sequencing is separate from the host, so failures can be injected locally."""
    host.preflight()
    if mode == '--recover-profiles':
        require(not host.journal_path.exists(), 'An existing recovery transaction needs review')
        journal = dict(version=1, release=host.release, imageId=host.image_id,
                       bundle='migrations/restricted-' + uuid.uuid4().hex,
                       timers=host.timer_states(), status='intent', phase='intent')
    else:
        journal = host.load()
        require(journal.get('version') == 1 and journal.get('status') == 'restricted-active' and
                journal.get('release') == host.release and journal.get('imageId') == host.image_id and
                re.fullmatch(r'migrations/restricted-[a-f0-9]{12,64}', journal.get('bundle', '')) and
                set(journal.get('timers', {})) == set(TIMERS), 'No matching active recovery transaction')
    host.save(journal)
    def phase(name):
        journal['phase'] = name
        host.save(journal)
    try:
        phase('quiescing')
        host.stop_timers()
        host.wait_writers()
        if mode == '--recover-profiles':
            host.step('maintenance', journal['bundle'])
        else:
            host.step('pause-profiles', journal['bundle'])
        host.compose('stop', 'mcp')
        phase('service-stopped')
        if mode == '--recover-profiles':
            host.prepare(journal['bundle'])
            phase('marker-write-started')
            host.write_marker(journal['bundle'])
            probe_mode = RECOVERY
        else:
            host.export(journal['bundle'])
            phase('resume-export-verified')
            host.step('promote', journal['bundle'])
            phase('latest-data-promoted')
            phase('marker-clear-started')
            host.clear_marker(journal['bundle'])
            probe_mode = 'applications-held'
        phase('private-verification')
        journal['privateProbe'] = host.probe(probe_mode)
        # This boundary precedes Compose, which may expose a service even when
        # the client times out. No failure handler restores an earlier database.
        phase('public-activation-started')
        host.compose('up', '-d', '--no-build', 'mcp')
        journal['publicProbe'] = host.probe(probe_mode, public=True)
        if mode == '--resume-applications':
            phase('public-verified')
            host.step('release-maintenance', journal['bundle'])
            journal['resumedProbe'] = host.probe('applications', public=True)
            host.restore_timers(journal['timers'])
        journal['status'] = 'restricted-active' if mode == '--recover-profiles' else 'applications-active'
        phase('complete')
        return journal
    except BaseException:
        host.fail(journal)
        raise


def main():
    os.umask(0o077)
    if sys.argv[1:2] == ['inside']:
        require(len(sys.argv) == 6, 'Invalid internal step')
        inside_step(*sys.argv[2:])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['--recover-profiles', '--resume-applications'])
    parser.add_argument('--live', required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--image-id', required=True)
    # Modes begin with --, so parse as a required mutually exclusive switch.
    argv = sys.argv[1:]
    require(argv and argv[0] in {'--recover-profiles', '--resume-applications'}, 'Explicit recovery mode required')
    args = parser.parse_args([*argv[1:], '--', argv[0]])
    host = Host(args.live, args.release, args.image_id)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError('Recovery interrupted')))
    with ExitStack() as stack:
        stack.enter_context(lock(host.live.parent / '.jobs-radar-release-host.lock'))
        stack.enter_context(lock(host.live / '.release.lock'))
        result = transaction(host, args.mode)
    print(json.dumps({key: result[key] for key in ('status', 'phase', 'release', 'imageId', 'bundle')}, sort_keys=True))


if __name__ == '__main__':
    main()
