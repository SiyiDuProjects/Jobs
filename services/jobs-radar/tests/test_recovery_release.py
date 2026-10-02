"""Release sequencing and real SQLite promotion; synthetic data only."""
import json
import io
from pathlib import Path
import subprocess
import sys

import pytest

DEPLOY = Path(__file__).parents[1] / 'deploy'
sys.path.insert(0, str(DEPLOY))
import recover_profiles as driver
from test_legacy_recovery import databases
from test_restricted_recovery import recovered


class Host:
    release = 'a' * 12
    image_id = 'sha256:' + 'b' * 64

    def __init__(self, tmp_path, failure=None):
        self.journal_path = tmp_path / 'journal.json'
        self.events, self.failure = [], failure
        self.latest_data = {'profile': 'original', 'application': 'unknown-submit'}
        self.maintenance, self.stopped = False, False
        self.timers = {driver.TIMERS[0]: 'active', driver.TIMERS[1]: 'inactive'}

    def event(self, value):
        self.events.append(value)
        if value == self.failure:
            raise RuntimeError('synthetic failure: ' + value)

    def save(self, value):
        self.journal_path.write_text(json.dumps(value))

    def load(self):
        return json.loads(self.journal_path.read_text())

    def preflight(self): self.event('preflight')
    def timer_states(self): return dict(self.timers)
    def stop_timers(self): self.event('stop-timers')
    def wait_writers(self): self.event('wait-writers')
    def prepare(self, bundle): self.event('prepare')
    def write_marker(self, bundle): self.event('write-marker')
    def export(self, bundle): self.event('export')
    def clear_marker(self, bundle): self.event('clear-marker')

    def step(self, action, bundle):
        self.event(action)
        if action == 'maintenance': self.maintenance = True
        if action == 'release-maintenance': self.maintenance = False

    def compose(self, *args):
        self.event('compose-' + args[0])
        self.stopped = args[0] == 'stop'
        if args[0] == 'up': self.latest_data['profile'] = 'edited-after-activation'

    def probe(self, mode, public=False):
        self.event(('public-' if public else 'private-') + mode)
        return dict(mode=mode, verified=True)

    def restore_timers(self, states):
        self.event('restore-timers')
        assert states == self.timers

    def fail(self, journal):
        self.event('fail-stop-only')
        self.stopped, self.maintenance = True, True
        journal['status'] = 'failed-needs-review'
        self.save(journal)


def recovered_host(tmp_path, failure=None):
    host = Host(tmp_path)
    driver.transaction(host, '--recover-profiles')
    host.events, host.failure = [], failure
    return host


def test_recovery_never_starts_public_until_private_pause_probe_passes(tmp_path):
    host = Host(tmp_path)
    result = driver.transaction(host, '--recover-profiles')
    assert result['status'] == 'restricted-active'
    assert host.events == ['preflight', 'stop-timers', 'wait-writers', 'maintenance',
                           'compose-stop', 'prepare', 'write-marker',
                           'private-' + driver.RECOVERY, 'compose-up', 'public-' + driver.RECOVERY]
    assert host.maintenance and 'restore-timers' not in host.events


def test_resume_latest_data_before_marker_clear_and_only_then_restore_original_timers(tmp_path):
    host = recovered_host(tmp_path)
    result = driver.transaction(host, '--resume-applications')
    assert result['status'] == 'applications-active'
    assert host.events == ['preflight', 'stop-timers', 'wait-writers', 'pause-profiles',
                           'compose-stop', 'export', 'promote', 'clear-marker',
                           'private-applications-held', 'compose-up', 'public-applications-held',
                           'release-maintenance', 'public-applications', 'restore-timers']
    assert host.latest_data['profile'] == 'edited-after-activation'
    assert not host.maintenance


@pytest.mark.parametrize('failure', ['stop-timers', 'wait-writers', 'maintenance', 'compose-stop',
    'prepare', 'write-marker', 'private-' + driver.RECOVERY, 'compose-up', 'public-' + driver.RECOVERY])
def test_enter_faults_retain_data_stop_and_never_claim_rollback(tmp_path, failure):
    host = Host(tmp_path, failure)
    with pytest.raises(RuntimeError): driver.transaction(host, '--recover-profiles')
    assert host.stopped and host.maintenance
    assert host.load()['status'] == 'failed-needs-review'
    assert host.latest_data['application'] == 'unknown-submit'
    assert not any('restore' in event or 'rollback' in event for event in host.events)


@pytest.mark.parametrize('failure', ['pause-profiles', 'compose-stop', 'export', 'promote', 'clear-marker',
    'private-applications-held', 'compose-up', 'public-applications-held', 'release-maintenance',
    'public-applications', 'restore-timers'])
def test_resume_faults_do_not_restore_prior_database_even_after_public_activation(tmp_path, failure):
    host = recovered_host(tmp_path, failure)
    with pytest.raises(RuntimeError): driver.transaction(host, '--resume-applications')
    assert host.stopped and host.maintenance
    assert host.load()['status'] == 'failed-needs-review'
    assert host.latest_data == {'profile': 'edited-after-activation', 'application': 'unknown-submit'}
    assert 'rollback' not in host.events


def test_preflight_failure_has_no_writes_or_pause(tmp_path):
    host = Host(tmp_path, 'preflight')
    with pytest.raises(RuntimeError): driver.transaction(host, '--recover-profiles')
    assert host.events == ['preflight'] and not host.journal_path.exists()


def test_failed_transaction_cannot_be_mistaken_for_active_recovery(tmp_path):
    host = recovered_host(tmp_path)
    journal = host.load(); journal['status'] = 'failed-needs-review'; host.save(journal)
    with pytest.raises(ValueError, match='No matching'): driver.transaction(host, '--resume-applications')
    assert host.events == ['preflight']


def test_promote_uses_latest_complete_export_and_preserves_original_database(databases, tmp_path, monkeypatch):
    from jobs_radar.restricted_recovery import prepare, export_resume, fingerprint, write_marker, clear_marker, RecoveryStore
    from jobs_radar.profiles import Profiles
    from jobs_radar.recovery_server import existing
    current = databases['current']
    bundle = current.parent / 'migrations/restricted-123456abcdef'
    bundle.parent.mkdir()
    (current.parent / '.release-maintenance').touch()
    before = fingerprint(current)
    prepare(current, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    write_marker(current, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    profiles = existing(Profiles, RecoveryStore(bundle))
    profile = profiles.get(databases['profile']['id'])
    profile['profile']['profileName'] = 'Synthetic recovery-period edit'
    profiles.save(profile['profile'], profile_id=profile['id'], expected_sync=profile['last_sync'])
    (bundle / '.pause-profile-writes').touch()
    report = export_resume(bundle)
    driver.promote_latest(current, bundle)
    assert fingerprint(current) == report['data']
    assert fingerprint(bundle / 'before-resume-live.sqlite') == before
    assert fingerprint(bundle / 'current-v2.sqlite') == before
    clear_marker(current)
    assert (current.parent / '.release-maintenance').exists()
    assert not (current.parent / '.restricted-recovery.json').exists()
    real_path = Path
    def scoped_path(value):
        if value == '/data': return current.parent
        if value == '/data/jobs.sqlite': return current
        return real_path(value)
    monkeypatch.setattr(driver, 'Path', scoped_path)
    driver.inside_step('verify-cleared', 'migrations/restricted-123456abcdef', 'a'*12, 'sha256:'+'b'*64)
    with pytest.raises(ValueError, match='verified live image'):
        driver.inside_step('verify-cleared', 'migrations/restricted-123456abcdef', 'c'*12, 'sha256:'+'b'*64)
    # A missing marker alone must not permit stale original rows as a resume.
    with current.open('wb') as output:
        output.write((bundle / 'before-resume-live.sqlite').read_bytes())
    with pytest.raises(ValueError, match='latest data proof'):
        driver.inside_step('verify-cleared', 'migrations/restricted-123456abcdef', 'a'*12, 'sha256:'+'b'*64)


def test_failed_promotion_keeps_existing_live_and_latest_export(databases, tmp_path, monkeypatch):
    from jobs_radar.restricted_recovery import prepare, export_resume, fingerprint, write_marker
    current = databases['current']
    bundle = current.parent / 'migrations/restricted-123456abcdef'
    bundle.parent.mkdir(); (current.parent / '.release-maintenance').touch()
    before = fingerprint(current)
    prepare(current, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    write_marker(current, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    (bundle / '.pause-profile-writes').touch()
    report = export_resume(bundle)
    real_replace = driver.os.replace
    def replace(source, target):
        if Path(target) == current: raise OSError('synthetic interruption before promotion')
        return real_replace(source, target)
    monkeypatch.setattr(driver.os, 'replace', replace)
    with pytest.raises(OSError): driver.promote_latest(current, bundle)
    assert fingerprint(current) == before
    assert fingerprint(bundle / 'resume-v2.sqlite') == report['data']
    assert (current.parent / '.restricted-recovery.json').exists()


def test_clear_marker_lost_reply_requires_fresh_complete_proof():
    host = driver.Host.__new__(driver.Host)
    calls = []
    def helper(args):
        calls.append(args)
        raise RuntimeError('lost reply')
    host.helper = helper
    host.step = lambda *args: calls.append(args)
    host.clear_marker('migrations/restricted-123456abcdef')
    assert calls[-1] == ('verify-cleared', 'migrations/restricted-123456abcdef')
    host.step = lambda *args: (_ for _ in ()).throw(ValueError('wrong data'))
    with pytest.raises(ValueError): host.clear_marker('migrations/restricted-123456abcdef')


def test_helper_uses_full_image_and_reviewed_resource_bounds(tmp_path):
    host = driver.Host.__new__(driver.Host)
    host.live, host.release, host.image_id = tmp_path, 'a'*12, 'sha256:'+'b'*64
    class Containers:
        def start(self, image, args, **options): return image, args, options
    host.containers = Containers()
    image, args, options = host.helper(['-c', 'pass'])
    assert image == 'jobs-radar:' + 'a'*12
    assert options['image_id'] == host.image_id and options['memory'] == 512
    assert options['timeout'] <= 180 and options['mounts'] == [str(tmp_path / 'data') + ':/data']
    assert not any('KEY' in value for value in options['environment'])
    assert 'JOBS_DB=/data/jobs.sqlite' in options['environment']


def test_driver_argument_parser_accepts_only_explicit_recovery_mode():
    result = subprocess.run([sys.executable, str(DEPLOY / 'recover_profiles.py'), '--recover-profiles',
        '--live', '/nonexistent-synthetic', '--release', 'a'*12, '--image-id', 'sha256:'+'b'*64],
        capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and 'FileNotFoundError' in result.stderr
    assert 'unrecognized arguments' not in result.stderr


def test_probe_executes_against_actual_restricted_routes_without_owner_cookie(recovered, monkeypatch, capsys):
    import urllib.request
    import urllib.error
    client = recovered['client']
    client.cookies.clear()
    calls = []
    def urlopen(url, timeout):
        path = url.removeprefix('http://127.0.0.1:8796')
        calls.append(path)
        response = client.get(path)
        if response.status_code >= 400:
            raise urllib.error.HTTPError(url, response.status_code, 'synthetic HTTP adapter', {}, io.BytesIO(response.content))
        stream = io.BytesIO(response.content)
        stream.status = response.status_code
        return stream
    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
    monkeypatch.setattr(sys, 'argv', ['probe', driver.RECOVERY, 'a'*12])
    exec(driver.PROBE, {})
    result = json.loads(capsys.readouterr().out)
    assert result['verified'] and set(result['assets']) == {'/assets/board.js', '/assets/board.css'}
    assert '/mcp' in calls and '/api/extension/events' in calls
    monkeypatch.setattr(sys, 'argv', ['public-probe', json.dumps(result)])
    exec(driver.PUBLIC_PROBE, {})
    assert 'verified host publication' in capsys.readouterr().out


def test_probe_executes_against_actual_normal_service_without_owner_cookie(databases, monkeypatch, capsys):
    import urllib.request
    import urllib.error
    from starlette.testclient import TestClient
    from jobs_radar.server import create_server
    from jobs_radar.store import Store
    marker = databases['current'].parent / '.release-maintenance'
    marker.touch(exist_ok=True)
    monkeypatch.setenv('JOBS_MAINTENANCE_FILE', str(marker))
    with TestClient(create_server(Store(databases['current']), 'https://jobs.siyidu.com').streamable_http_app(),
                    base_url='https://jobs.siyidu.com') as client:
        def urlopen(url, timeout):
            response = client.get(url.removeprefix('http://127.0.0.1:8796'))
            if response.status_code >= 400:
                raise urllib.error.HTTPError(url, response.status_code, 'synthetic HTTP adapter', {}, io.BytesIO(response.content))
            stream = io.BytesIO(response.content); stream.status = response.status_code
            return stream
        monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
        # Container production path is fixed /data; only this filesystem probe
        # maps to the synthetic temporary directory. HTTP uses the real middleware.
        original_is_file = Path.is_file
        monkeypatch.setattr(Path, 'is_file', lambda path: marker.is_file() if str(path).replace('\\','/') == '/data/.release-maintenance' else original_is_file(path))
        monkeypatch.setattr(sys, 'argv', ['probe', 'applications-held', 'a'*12])
        exec(driver.PROBE, {})
        result = json.loads(capsys.readouterr().out)
        assert result['verified'] and result['mode'] == 'applications-held'
        monkeypatch.setattr(sys, 'argv', ['public-probe', json.dumps(result)])
        exec(driver.PUBLIC_PROBE, {})
        assert 'verified host publication' in capsys.readouterr().out
        marker.unlink()
        monkeypatch.setattr(sys, 'argv', ['probe', 'applications', 'a'*12])
        exec(driver.PROBE, {})
        result = json.loads(capsys.readouterr().out)
        assert result['verified'] and result['mode'] == 'applications'
        monkeypatch.setattr(sys, 'argv', ['public-probe', json.dumps(result)])
        exec(driver.PUBLIC_PROBE, {})
        assert 'verified host publication' in capsys.readouterr().out


@pytest.mark.parametrize('which', ['id', 'label', 'live', 'stage', 'container'])
def test_mismatched_release_identity_fails_before_any_service_mutation(tmp_path, monkeypatch, which):
    host = driver.Host.__new__(driver.Host)
    host.live, host.release, host.image_id = tmp_path, 'a'*12, 'sha256:'+'b'*64
    (tmp_path / 'RELEASE').write_text('c'*12 if which == 'live' else host.release)
    stage = tmp_path / 'stage'; (stage / 'deploy').mkdir(parents=True)
    (stage / 'RELEASE').write_text('c'*12 if which == 'stage' else host.release)
    monkeypatch.setattr(driver, '__file__', str(stage / 'deploy/recover_profiles.py'))
    class Containers:
        def cleanup(self): pass
    host.containers = Containers()
    def docker(*args):
        assert args[:2] == ('image', 'inspect')
        return json.dumps([{'Id': 'sha256:'+'c'*64 if which == 'id' else host.image_id,
            'Config': {'Labels': {'release': 'c'*12 if which == 'label' else host.release}}}])
    host.docker = docker
    host.helper = lambda args: None
    host.running = lambda: (_ for _ in ()).throw(ValueError('Running service identity differs'))
    with pytest.raises(ValueError): host.preflight()


def test_failure_cleanup_has_own_finite_budget_and_records_uncertain_stop(tmp_path):
    host = driver.Host.__new__(driver.Host)
    host.deadline = 0
    calls = []
    host.stop_timers = lambda: calls.append('timers')
    host.step = lambda *args: calls.append(args)
    host.compose = lambda *args: (_ for _ in ()).throw(RuntimeError('daemon unavailable'))
    class Containers:
        def cleanup(self): calls.append('cleanup')
    host.containers = Containers()
    host.save = lambda value: calls.append(dict(value))
    journal = {'bundle': 'migrations/restricted-123456abcdef'}
    host.fail(journal)
    assert 0 < host.deadline - driver.time.monotonic() <= 90
    assert journal['stopUncertain'] == ['service'] and journal['status'] == 'failed-needs-review'
    assert ('hold-failure', journal['bundle']) in calls


def test_successful_compose_stop_without_actual_stop_is_rejected():
    host = driver.Host.__new__(driver.Host)
    host.live, host.service_id = Path('/synthetic/live'), 'a'*64
    host.docker = lambda *args, **kwargs: json.dumps([{'Id': host.service_id, 'State': {'Running': True}}]) if args[0] == 'inspect' else ''
    with pytest.raises(ValueError, match='stop is not confirmed'): host.compose('stop', 'mcp')


def test_transaction_timeout_is_applied_to_every_daemon_call(monkeypatch):
    host = driver.Host.__new__(driver.Host)
    host.deadline = driver.time.monotonic() + .05
    calls = []
    monkeypatch.setattr(driver, 'bounded', lambda *args, **kwargs: calls.append(kwargs))
    host.invoke(['docker', 'inspect', 'synthetic'], timeout=180)
    assert 0 < calls[0]['timeout'] <= .05 and calls[0]['max_output_bytes'] == 1024*1024
    host.deadline = 0
    with pytest.raises(ValueError, match='deadline'): host.invoke(['docker', 'inspect', 'synthetic'])
    assert len(calls) == 1


def test_data_owner_helper_rejects_nonregular_database_without_reading_values(tmp_path, monkeypatch):
    database = tmp_path / 'jobs.sqlite'; database.write_bytes(b'synthetic-do-not-read')
    def checked_path(value):
        assert value == '/data/jobs.sqlite'
        return database
    # Execute the same metadata-only check against a synthetic path, then a
    # directory. Permissions/user/caps are provided by reviewed Containers.
    source = driver.DATA_CHECK.replace('from pathlib import Path', '')
    exec(source, {'Path': checked_path})
    database.unlink(); database.mkdir()
    with pytest.raises(AssertionError): exec(source, {'Path': checked_path})


def test_host_constructor_never_traverses_owner_only_database(tmp_path, monkeypatch):
    live = tmp_path / 'live'; (live / 'data').mkdir(parents=True)
    original = Path
    def mapped(value):
        return live if str(value) == '/home/ubuntu/siyi/jobs-radar' else original(value)
    monkeypatch.setattr(driver, 'Path', mapped)
    class Containers:
        def __init__(self, *args, **kwargs): pass
    monkeypatch.setattr(driver, 'Containers', Containers)
    def forbidden(path, *args, **kwargs):
        if path.name == 'jobs.sqlite': raise PermissionError('host cannot traverse 10001:0700 data')
        return original_stat(path, *args, **kwargs)
    original_stat = Path.stat
    monkeypatch.setattr(Path, 'stat', forbidden)
    host = driver.Host('/home/ubuntu/siyi/jobs-radar', 'a'*12, 'sha256:'+'b'*64)
    assert host.live == live
