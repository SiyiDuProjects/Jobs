import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from test_release_switch import BASH


SCRIPT = Path(__file__).parents[1] / 'deploy/release.sh'
STUB = Path(__file__).parent / 'fixtures/release_entry_commands.py'
pytestmark = pytest.mark.skipif(not BASH or not Path(BASH).exists(), reason='Bash is required')


def run(tmp_path, args=(), **changes):
    config = dict(commit='b' * 12, full_commit='b' * 12 + 'c' * 28, image_id='sha256:' + '1' * 64, **changes)
    (tmp_path / 'config.json').write_text(json.dumps(config))
    (tmp_path / 'bin').mkdir(exist_ok=True)
    for name in ('git', 'ssh', 'docker', 'python3', 'node'):
        path = tmp_path / 'bin' / name
        path.write_text('#!/bin/bash\nexec "' + Path(sys.executable).as_posix() + '" "' + STUB.as_posix() + '" ' + name + ' "$@"\n')
        path.chmod(0o755)
    env = dict(os.environ, RELEASE_ENTRY_ROOT=str(tmp_path), RELEASE_ENTRY_BASH=BASH, JOBS_RADAR_HOST='fixture@local', MSYS_NO_PATHCONV='1')
    bin_path = (tmp_path / 'bin').as_posix()
    if os.name == 'nt':
        bin_path = '/' + bin_path[0].lower() + bin_path[2:]
    result = subprocess.run([BASH, '-c', 'export PATH="' + bin_path + ':$PATH"; exec bash "$@"',
                             'entry-test', str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=30)
    calls = [json.loads(line) for line in (tmp_path / 'calls.jsonl').read_text().splitlines()] if (tmp_path / 'calls.jsonl').exists() else []
    return result, calls


@pytest.mark.parametrize('args', [(), ('release',), ('release', '--image-id', 'latest')])
def test_default_and_rehearsal_paths_fail_before_any_remote_command(tmp_path, args):
    result, calls = run(tmp_path, args)
    assert result.returncode != 0
    assert calls == []
    assert 'not integrated' in result.stderr or '--image-id' in result.stderr


def test_build_dispatches_only_to_local_builder_without_ssh(tmp_path):
    result, calls = run(tmp_path, ('--build',))
    assert result.returncode == 0, result.stderr
    assert len(calls) == 1 and calls[0][0] == 'python3' and calls[0][-1] == 'build'
    assert calls[0][-2].endswith('/local_build.py')


@pytest.mark.parametrize('mode', ['--build-web', '--release-web', '--web-status', '--rollback-web'])
def test_website_modes_dispatch_to_native_client_without_full_release(tmp_path, mode):
    result, calls = run(tmp_path, (mode,))
    assert result.returncode == 0, result.stderr
    assert len(calls) == 1 and calls[0][0] == 'node'
    assert calls[0][1].endswith('/web_release.mjs') and calls[0][2:] == [mode]


def test_rehearsal_dispatches_only_to_local_environment_guard_without_ssh(tmp_path):
    result, calls = run(tmp_path, ('--rehearse', '--artifact', 'private-artifact', '--old-image', 'sha256:' + 'a' * 64))
    assert result.returncode == 0, result.stderr
    assert len(calls) == 1 and calls[0][0] == 'python3' and calls[0][1].endswith('/local_rehearsal.py')


def test_artifact_verification_precedes_transfer_import_and_final_identity_checks(tmp_path):
    artifact = tmp_path / 'local-build'
    artifact.mkdir()
    for name in ['source.tar', 'image.tar', 'manifest.json']:
        (artifact / name).write_text('private artifact fixture')
    result, calls = run(tmp_path, ('release', '--artifact', str(artifact)))
    assert result.returncode == 0, result.stderr
    assert calls[0][0] == 'python3' and 'verify' in calls[0]
    remotes = [call for call in calls if call[0] == 'ssh']
    importer = next(index for index, call in enumerate(remotes) if any(value.endswith('/import_image.py') for value in call))
    activation = next(index for index, call in enumerate(remotes) if any(value.endswith('/switch_release.sh') for value in call))
    assert importer < activation
    assert not any('build' in call or 'run' in call for call in calls if call[0] == 'docker')


def test_changed_artifact_never_reaches_ssh(tmp_path):
    artifact = tmp_path / 'artifact'
    artifact.mkdir()
    result, calls = run(tmp_path, ('release', '--artifact', str(artifact)), artifact_invalid=True)
    assert result.returncode != 0 and not any(call[0] == 'ssh' for call in calls)


def test_prebuilt_exact_commit_and_digest_are_verified_before_upload_and_switch(tmp_path):
    result, calls = run(tmp_path, ('release', '--image-id', 'sha256:' + '1' * 64))
    assert result.returncode == 0, result.stdout + result.stderr
    remote_calls = [call for call in calls if call[0] == 'ssh']
    docker_calls = [call for call in calls if call[0] == 'docker']
    assert len(docker_calls) == 3 and all(call[1:3] == ['image', 'inspect'] for call in docker_calls)
    assert 'bash' in remote_calls[0] and '-s' in remote_calls[0]
    assert remote_calls[-1][-1] == 'sha256:' + '1' * 64
    assert any('mkdir -p ' in value for value in remote_calls[1])
    assert not any('build' in call or 'run' in call for call in docker_calls)


@pytest.mark.parametrize('changes', [dict(dirty=True), dict(missing_image=True), dict(image_commit='a' * 12), dict(tag_id='sha256:' + '2' * 64), dict(resolved='0' * 40)])
def test_uncommitted_missing_or_mismatched_artifact_never_uploads_or_switches(tmp_path, changes):
    result, calls = run(tmp_path, ('release', '--image-id', 'sha256:' + '1' * 64), **changes)
    assert result.returncode != 0
    assert not any(any('mkdir -p ' in value or '/switch_release.sh' in value for value in call) for call in calls)
    if changes.get('dirty') or 'resolved' in changes:
        assert not any(call[0] == 'ssh' for call in calls)


def test_rollback_uses_recorded_server_artifacts_without_a_new_candidate(tmp_path):
    result, calls = run(tmp_path, ('--rollback',), dirty=True)
    assert result.returncode == 0, result.stderr
    assert len(calls) == 1 and calls[0][0] == 'ssh'
    assert '--rollback' in calls[0] and '--image-id' not in calls[0]


def test_direct_rehearsal_cli_is_blocked_until_an_independent_environment_is_configured(tmp_path):
    script = SCRIPT.with_name('rehearse_docker.py')
    result = subprocess.run([sys.executable, str(script), '--stage-root', str(tmp_path / 'jobs-radar-stage'),
        '--old-image', 'jobs-radar:old', '--candidate-image', 'jobs-radar:new'], capture_output=True, text=True)
    assert result.returncode != 0 and 'No independent rehearsal environment' in result.stderr
    assert list(tmp_path.iterdir()) == []
