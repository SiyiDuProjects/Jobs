"""The explicit SSH fallback follows current service contracts and release holds."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

from jobs_radar import maintenance


spec = importlib.util.spec_from_file_location('jobs_admin_bridge', Path(__file__).parents[3] / 'scripts/jobs_radar_admin.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


@pytest.mark.parametrize('method', ['claim', 'record', 'reconcile', 'lease_action'])
def test_retired_mutations_rejected_before_transport(method):
    with pytest.raises(ValueError, match='Unsupported'):
        bridge.remote_code({'method': method})


def execute(request, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('JOBS_DB', str(tmp_path / 'bridge.sqlite'))
    monkeypatch.setenv('JOBS_MAINTENANCE_FILE', str(tmp_path / 'maintenance'))
    exec(bridge.remote_code(request), {})
    return json.loads(capsys.readouterr().out)


def test_diagnostics_read_works_with_observation_disabled(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '0')
    monkeypatch.setenv('JOBS_BROWSER_OBSERVE_ENABLED', '0')
    result = execute({'method': 'browser_history'}, tmp_path, monkeypatch, capsys)
    assert result['applications'] == []


def test_profile_read_is_metadata_only_without_id(tmp_path, monkeypatch, capsys):
    result = execute({'method': 'profiles'}, tmp_path, monkeypatch, capsys)
    assert result['profiles'] == []
    assert result['schema_version']


@pytest.mark.parametrize('method', ['health', 'profiles', 'browser_pages', 'update_application_progress'])
def test_maintenance_blocks_bridge_before_opening_database(tmp_path, monkeypatch, capsys, method):
    (tmp_path / 'maintenance').write_text('release paused')
    with pytest.raises(RuntimeError, match='administrator calls are paused'):
        execute({'method': method}, tmp_path, monkeypatch, capsys)
    assert not (tmp_path / 'bridge.sqlite').exists()


def test_unreadable_maintenance_marker_does_not_allow_writes(monkeypatch):
    def denied(*args, **kwargs):
        raise PermissionError('unreadable marker')
    monkeypatch.setattr(maintenance.Path, 'stat', denied)
    assert maintenance.paused() is True


def test_observation_off_rejects_snapshot_request(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '0')
    monkeypatch.setenv('JOBS_BROWSER_OBSERVE_ENABLED', '0')
    with pytest.raises(RuntimeError, match='observation is disabled'):
        execute({'method': 'browser_pages'}, tmp_path, monkeypatch, capsys)


def test_observation_only_keeps_execution_disabled(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('JOBS_BROWSER_CONTROL_ENABLED', '0')
    monkeypatch.setenv('JOBS_BROWSER_OBSERVE_ENABLED', '1')
    result = execute({'method': 'browser_pages'}, tmp_path, monkeypatch, capsys)
    assert result['executionEnabled'] is False
    with pytest.raises(ValueError, match='execution is disabled'):
        execute({'method': 'browser_command', 'args': dict(device_id='device', session_id='session',
                page_target={}, action='submit', idempotency_key='not-enabled')}, tmp_path, monkeypatch, capsys)


def test_pagination_cannot_repeat_mutations():
    with pytest.raises(ValueError, match='read-only search'):
        bridge.remote_code({'method': 'browser_command'}, all_pages=True)


def test_release_lock_failure_does_not_produce_a_saved_result(tmp_path, monkeypatch):
    request = tmp_path / 'request.json'
    output = tmp_path / 'result.json'
    request.write_text(json.dumps({'method': 'health'}))
    monkeypatch.setattr(sys, 'argv', ['jobs_radar_admin.py', str(request), '--output', str(output)])

    def locked(command, **options):
        assert command[-1] == bridge.REMOTE_COMMAND
        assert 'flock -s -n .release.lock docker compose exec' in command[-1]
        assert options['timeout'] == 120
        raise subprocess.CalledProcessError(1, command, stderr=b'Release lock held')

    monkeypatch.setattr(bridge.subprocess, 'run', locked)
    with pytest.raises(subprocess.CalledProcessError):
        bridge.main()
    assert not output.exists()
