"""Recovery rehearsal contracts using actual ASGI/Profile/SQLite operations."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy'))
import rehearsal_data as data
import rehearsal_recovery as local
import recover_profiles as production
from jobs_radar.restricted_recovery import prepare, write_marker, export_resume, clear_marker
from jobs_radar.recovery_server import create_app
from test_release_migration import implementation


def synthetic(tmp_path):
    database = tmp_path / 'jobs.sqlite'
    data.seed(database, Path(__file__).parent / 'fixtures/legacy-release-schema.sql')
    implementation().migrate(database, dry_run=False)
    data.write(database)
    return database


def test_rehearsal_http_edits_and_revocation_survive_actual_export_promotion(tmp_path):
    database = synthetic(tmp_path)
    invariant = data.recovery_invariants(database)
    (tmp_path / '.release-maintenance').touch()
    bundle = tmp_path / 'migrations/restricted-123456abcdef'
    bundle.parent.mkdir()
    prepare(database, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    write_marker(database, bundle, release='a'*12, image_id='sha256:'+'b'*64)
    with TestClient(create_app(bundle, 'https://jobs.siyidu.com'), base_url='https://jobs.siyidu.com') as client:
        def request(method, path, payload=None, token=data.OWNER_COOKIE):
            response = client.request(method, path, json=payload, headers={'Cookie':'radar_browser='+token,
                'Origin':'https://jobs.siyidu.com', 'X-Jobs-Protocol':'2'})
            return response.status_code, response.json()
        edited = data.http_recovery('http-edit', request=request)
        assert data.http_recovery('http-verify', request=request) == edited
        assert data.recovery_state(database) == edited
        assert data.recovery_invariants(database) == invariant
    (bundle / '.pause-profile-writes').touch()
    export_resume(bundle)
    production.promote_latest(database, bundle)
    clear_marker(database)
    assert data.recovery_state(database) == edited
    assert data.recovery_invariants(database) == invariant
    with sqlite3.connect(bundle / 'before-resume-live.sqlite') as db:
        assert db.execute('SELECT 1 FROM web_sessions WHERE hash=?',
            (data.hashlib.sha256(data.REVOKED_COOKIE.encode()).hexdigest(),)).fetchone()
    # The post-resume revocation is demonstrably newer than retained before DB.
    assert (tmp_path / '.release-maintenance').exists()


def subject(tmp_path):
    root = tmp_path / 'jobs-radar-stage/rehearsal-123456789abcdef0'
    live = root / 'live'; live.mkdir(parents=True)
    return SimpleNamespace(root=root, live=live, namespace='jobs-radar-rehearsal-123456789abcdef0',
        candidate='a'*12, image_ids={'a'*12: 'sha256:'+'b'*64}, deadline=time.monotonic()+60,
        total_deadline=time.monotonic()+420, containers=object(), env={'JOBS_RELEASE_MANAGE_TIMERS':'0'})


def test_adapter_preserves_production_database_and_failure_methods(tmp_path):
    host = local.RehearsalRecoveryHost(subject(tmp_path))
    for name in ('step', 'prepare', 'write_marker', 'export', 'clear_marker', 'load', 'save'):
        assert getattr(type(host), name) is getattr(production.Host, name)
    assert host.timer_states() == {name:'inactive' for name in production.TIMERS}
    host.stop_timers(); host.restore_timers(host.timer_states())
    with pytest.raises(ValueError): host.restore_timers({name:'active' for name in production.TIMERS})


def test_local_adapter_refuses_a_production_or_mismatched_namespace(tmp_path):
    item = subject(tmp_path)
    item.namespace = 'jobs-radar'
    with pytest.raises(ValueError, match='isolated'): local.RehearsalRecoveryHost(item)


def test_recovery_helper_always_uses_pinned_candidate_and_private_mount(tmp_path):
    item = subject(tmp_path); calls=[]
    item.containers = SimpleNamespace(start=lambda *args, **kwargs: calls.append((args, kwargs)))
    host = local.RehearsalRecoveryHost(item)
    host.prepare('migrations/restricted-123456abcdef')
    args, options = calls[0]
    assert args[1][0] == '/app/deploy/prepare_restricted_recovery.py'
    assert options['image_id'] == item.image_ids[item.candidate]
    assert options['memory'] == 512 and options['mounts'] == [str(item.live / 'data')+':/data']


def test_unconfirmed_container_stop_aborts_instead_of_exporting(tmp_path):
    item=subject(tmp_path); host=local.RehearsalRecoveryHost(item); host.service_id='a'*64
    host.docker=lambda *args, **kwargs: json.dumps([{'Id':'a'*64,'State':{'Running':True}}]) if args[0]=='inspect' else ''
    with pytest.raises(ValueError, match='stop is not confirmed'): host.compose('stop','mcp')


def test_post_activation_fault_is_after_an_actual_http_write_callback(tmp_path):
    item=subject(tmp_path); calls=[]
    item.http=lambda *args: (calls.append(args), {'profile':'latest','settings':'latest','revoked':True})[1]
    host=local.RehearsalRecoveryHost(item, failure='after-resumed-write')
    host.running=lambda:'a'*64
    host.docker=lambda *args, **kwargs: json.dumps({'verified':True})
    with pytest.raises(RuntimeError, match='accepted HTTP write'): host.probe('applications', public=True)
    assert host.fired and calls == [('http-edit','after-activation')]
    assert host.activation_write['profile']=='latest'


@pytest.mark.parametrize('service_fault', [False, True])
def test_recovery_fail_cleans_both_owned_ledgers_and_records_uncertainty(tmp_path, service_fault):
    item=subject(tmp_path); events=[]
    item.containers=SimpleNamespace(cleanup=lambda:events.append('helper-cleanup'))
    item.capture_service_logs=lambda:events.append('service-logs')
    def cleanup():
        events.append('service-cleanup')
        if service_fault: raise RuntimeError('ownership changed')
    item.services=SimpleNamespace(cleanup=cleanup)
    host=local.RehearsalRecoveryHost(item)
    host.stop_timers=lambda:events.append('pause-timers')
    host.step=lambda action,bundle:events.append(action)
    host.compose=lambda *args:events.append('compose-'+args[0])
    host.save=lambda value:host.journal_path.write_text(json.dumps(value))
    host.fail({'bundle':'migrations/restricted-123456abcdef'})
    assert events==['pause-timers','hold-failure','compose-stop','helper-cleanup','service-logs','service-cleanup']
    report=json.loads(host.journal_path.read_text())
    assert report['status']=='failed-needs-review'
    assert report['stopUncertain']==(['isolated-service-cleanup'] if service_fault else [])


def test_recovery_failure_log_error_never_blocks_owned_service_cleanup(tmp_path):
    item=subject(tmp_path); events=[]
    item.containers=SimpleNamespace(cleanup=lambda:events.append('helper-cleanup'))
    def logs():
        events.append('logs'); raise RuntimeError('synthetic log capture failure')
    item.capture_service_logs=logs
    item.services=SimpleNamespace(cleanup=lambda:events.append('service-cleanup'))
    host=local.RehearsalRecoveryHost(item)
    host.stop_timers=lambda:None; host.step=lambda *args:None; host.compose=lambda *args:None
    host.save=lambda value:host.journal_path.write_text(json.dumps(value))
    host.fail({'bundle':'migrations/restricted-123456abcdef'})
    assert events==['helper-cleanup','logs','service-cleanup']
    report=json.loads(host.journal_path.read_text())
    assert report['status']=='failed-needs-review'
    assert report['stopUncertain']==['isolated-service-logs']


def test_failed_failure_journal_still_attempts_service_cleanup(tmp_path):
    item=subject(tmp_path); events=[]
    item.containers=SimpleNamespace(cleanup=lambda:events.append('helper'))
    item.capture_service_logs=lambda:events.append('logs')
    item.services=SimpleNamespace(cleanup=lambda:events.append('services'))
    host=local.RehearsalRecoveryHost(item)
    host.stop_timers=lambda:None; host.step=lambda *args:None; host.compose=lambda *args:None
    saves=[]
    def save(value):
        saves.append(dict(value))
        if len(saves)==1: raise OSError('synthetic journal IO failure')
        host.journal_path.write_text(json.dumps(value))
    host.save=save
    with pytest.raises(RuntimeError,match='remains unresolved'): host.fail({'bundle':'migrations/restricted-123456abcdef'})
    assert events==['helper','logs','services']
    assert json.loads(host.journal_path.read_text())['stopUncertain']==['recovery-failure-handler']
