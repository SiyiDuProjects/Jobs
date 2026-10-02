import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

BASH = shutil.which('bash') if os.name != 'nt' else 'C:/Program Files/Git/bin/bash.exe'
pytestmark = pytest.mark.skipif(not BASH or not Path(BASH).exists(), reason='Bash is required for the release transaction')
SCRIPT = Path(__file__).parents[1] / 'deploy' / 'switch_release.sh'
STUB = Path(__file__).parent / 'fixtures' / 'release_commands.py'


def setup(tmp_path, failure=None):
    live, stage, archive = [tmp_path / name for name in ('live', 'stage', 'archive')]
    for path in [live / 'data', stage, archive, tmp_path / 'bin']:
        path.mkdir(parents=True)
    (live / 'RELEASE').write_text('aaaaaaaaaaaa')
    (live / 'website.js').write_text('old website')
    (live / 'data' / 'jobs.sqlite').write_text('old schema with data')
    (stage / 'RELEASE').write_text('bbbbbbbbbbbb')
    (stage / 'website.js').write_text('new website')
    state = {'images': {'jobs-radar:0.1.0': 'aaaaaaaaaaaa', 'jobs-radar:bbbbbbbbbbbb': 'bbbbbbbbbbbb'},
             'active': 'aaaaaaaaaaaa', 'running': True, 'calls': [], 'fail': failure}
    (tmp_path / 'state.json').write_text(json.dumps(state))
    for name in ['docker', 'systemctl', 'sudo', 'flock', 'sleep', 'curl', 'tar', 'rsync']:
        wrapper = tmp_path / 'bin' / name
        wrapper.write_text('#!/bin/bash\nexec "' + Path(sys.executable).as_posix() + '" "' + STUB.as_posix() + '" ' + name + ' "$@"\n')
        wrapper.chmod(0o755)
    python = tmp_path / 'bin' / 'python3'
    converter = 'script=$(cygpath -w "$1")' if os.name == 'nt' else 'script=$1'
    python.write_text('#!/bin/bash\nif [[ "$1" = */release_helpers.py ]]; then\n' + converter
        + '\nshift\nexec "' + Path(sys.executable).as_posix() + '" "' + STUB.with_name('release_helper_host.py').as_posix()
        + '" "$script" "$@"\nfi\nexec "' + Path(sys.executable).as_posix() + '" "$@"\n')
    python.chmod(0o755)
    return live, stage, archive


def run(tmp_path, target='bbbbbbbbbbbb', overrides=None, stage=None, image_id=None):
    env = dict(os.environ, RELEASE_TEST_ROOT=str(tmp_path), MSYS_NO_PATHCONV='1')
    env.update(overrides or {})
    bin_path = (tmp_path / 'bin').as_posix()
    if os.name == 'nt':
        bin_path = '/' + bin_path[0].lower() + bin_path[2:]
    # Bash expands its existing PATH after importing the Windows environment.
    command = 'export PATH="' + bin_path + ':$PATH"; exec bash "$@"'
    result = subprocess.run([BASH, '-c', command, 'release-test', str(SCRIPT), target,
                             str(tmp_path / 'live'), str(stage or tmp_path / 'stage'), str(tmp_path / 'archive'),
                             *([] if target == '--rollback' else [image_id or 'sha256:' + hashlib.sha256(target.encode()).hexdigest()])],
                            env=env, capture_output=True, text=True, timeout=45)
    state = json.loads((tmp_path / 'state.json').read_text())
    return result, state


@pytest.mark.parametrize('failure', ['backup', 'dry_run', 'apply', 'code_copy', 'probe'])
def test_release_failure_restores_matching_website_code_and_data(tmp_path, failure):
    live, _, _ = setup(tmp_path, failure)
    result, state = run(tmp_path)
    assert result.returncode != 0, result.stdout + result.stderr
    assert state['active'] == 'aaaaaaaaaaaa' and state['running']
    assert (live / 'RELEASE').read_text() == 'aaaaaaaaaaaa'
    assert (live / 'website.js').read_text() == 'old website'
    assert (live / 'data' / 'jobs.sqlite').read_text() == 'old schema with data'
    assert not (live / 'data' / '.release-maintenance').exists()
    for call in state['calls']:
        if call[0] == 'curl':
            assert '--connect-timeout' in call and '--max-time' in call
    assert 'probe' not in state


def test_compatible_rollback_keeps_post_release_writes_and_restores_code(tmp_path):
    live, _, _ = setup(tmp_path)
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert state['active'] == 'bbbbbbbbbbbb'
    assert (live / 'website.js').read_text() == 'new website'
    (live / 'data' / 'jobs.sqlite').write_text('new owner records after release')
    result, state = run(tmp_path, '--rollback')
    assert result.returncode == 0, result.stdout + result.stderr
    assert state['active'] == 'aaaaaaaaaaaa'
    assert (live / 'website.js').read_text() == 'old website'
    assert (live / 'RELEASE').read_text() == 'aaaaaaaaaaaa'
    assert (live / 'data' / 'jobs.sqlite').read_text() == 'new owner records after release'


def test_candidate_digest_mismatch_refuses_before_any_writer_is_paused(tmp_path):
    live, _, _ = setup(tmp_path)
    result, state = run(tmp_path, image_id='sha256:' + '0' * 64)
    assert result.returncode != 0 and 'tag changed' in result.stderr
    assert (live / 'data/jobs.sqlite').read_text() == 'old schema with data'
    assert not any(call[:2] in (['docker', 'create'], ['docker', 'tag']) or call[0] == 'sudo' for call in state['calls'])


def test_same_commit_with_a_different_image_is_refused_before_retagging_or_pause(tmp_path):
    live, stage, _ = setup(tmp_path)
    state_path = tmp_path / 'state.json'
    state = json.loads(state_path.read_text())
    state['images']['jobs-radar:aaaaaaaaaaaa'] = 'aaaaaaaaaaaa'
    replacement = 'sha256:' + 'd' * 64
    state['image_ids'] = {'jobs-radar:aaaaaaaaaaaa': replacement}
    state_path.write_text(json.dumps(state))
    (stage / 'RELEASE').write_text('aaaaaaaaaaaa')
    result, state = run(tmp_path, 'aaaaaaaaaaaa', image_id=replacement)
    assert result.returncode != 0 and 'same commit' in result.stderr
    assert not any(call[:2] in (['docker', 'create'], ['docker', 'tag']) or call[0] == 'sudo' for call in state['calls'])
    assert (live / 'data/jobs.sqlite').read_text() == 'old schema with data'


@pytest.mark.parametrize('failure', ['writer_inventory', 'writer_unit_error', 'writer_unit_unknown'])
def test_unknown_writer_state_never_reaches_maintenance_or_database_changes(tmp_path, failure):
    live, _, _ = setup(tmp_path, failure)
    result, state = run(tmp_path)
    assert result.returncode != 0 and 'Cannot confirm background writers' in result.stderr
    assert (live / 'data/jobs.sqlite').read_text() == 'old schema with data'
    assert not (live / 'data/.release-maintenance').exists()
    assert state['running'] and state['active'] == 'aaaaaaaaaaaa'
    assert not any(call[:2] == ['docker', 'create'] or call[:2] == ['systemctl', 'start'] for call in state['calls'])


def test_tag_replacement_after_preflight_cannot_change_migration_probe_or_activation_image(tmp_path):
    setup(tmp_path)
    state_path = tmp_path / 'state.json'
    state = json.loads(state_path.read_text())
    state['mutate_candidate_tag'] = True
    state_path.write_text(json.dumps(state))
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stderr
    expected = 'sha256:' + hashlib.sha256(b'bbbbbbbbbbbb').hexdigest()
    creates = [call for call in state['calls'] if call[:2] == ['docker', 'create']]
    assert creates and all(call[call.index('--entrypoint') + 2] == expected for call in creates)
    assert state['active'] == 'bbbbbbbbbbbb'
    assert state['images']['jobs-radar:bbbbbbbbbbbb'] == 'cccccccccccc'


@pytest.mark.parametrize('failure', ['public_start', 'public_verify', 'daemon_public_start'])
def test_failed_public_rollback_keeps_accepted_writes_even_when_cli_reports_failure(tmp_path, failure):
    live, _, _ = setup(tmp_path)
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stderr
    state.update(fail=failure, write_on_start='aaaaaaaaaaaa')
    (tmp_path / 'state.json').write_text(json.dumps(state))
    before = len(state['calls'])
    result, state = run(tmp_path, '--rollback')
    assert result.returncode != 0 and 'no database was rolled back' in result.stderr
    assert state['accepted_write'] and not state['running']
    assert (live / 'data/jobs.sqlite').read_text() == 'accepted owner write after public start'
    assert (live / 'data/.release-maintenance').exists()
    assert not (live / 'data/late-daemon-cli-write').exists()
    assert not any(any('restore_release.py' in arg for arg in call) for call in state['calls'][before:])
    assert not any(call[:2] == ['systemctl', 'start'] for call in state['calls'][before:])


def test_failed_public_release_preserves_migration_and_holds_service_for_review(tmp_path):
    live, _, _ = setup(tmp_path, 'health')
    result, state = run(tmp_path)
    assert result.returncode != 0 and not state['running']
    assert state['active'] == 'bbbbbbbbbbbb'
    assert (live / 'data/jobs.sqlite').read_text() == 'new schema with preserved data'
    assert (live / 'data/.release-maintenance').exists()
    assert not any(any('restore_release.py' in arg for arg in call) for call in state['calls'])


@pytest.mark.parametrize('locked', ['8', '9'])
def test_host_and_existing_live_lock_both_refuse_before_image_or_data_operations(tmp_path, locked):
    setup(tmp_path)
    state_path = tmp_path / 'state.json'
    state = json.loads(state_path.read_text())
    state['busy_lock'] = locked
    state_path.write_text(json.dumps(state))
    result, state = run(tmp_path)
    assert result.returncode != 0
    assert state['calls'] == [['flock', '-n', '8']] + ([['flock', '-n', '9']] if locked == '9' else [])


@pytest.mark.parametrize('tamper', ['archive', 'image', 'metadata'])
def test_rollback_refuses_unpaired_recorded_image_and_archive(tmp_path, tamper):
    live, _, _ = setup(tmp_path)
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stderr
    metadata = (live / '.rollback-target').read_text().splitlines()
    assert len(metadata) == 4 and metadata[2].startswith('sha256:')
    if tamper == 'archive':
        Path(metadata[1]).write_text('tampered backup')
    elif tamper == 'image':
        state['images']['jobs-radar:previous'] = 'cccccccccccc'
        (tmp_path / 'state.json').write_text(json.dumps(state))
    else:
        (live / '.rollback-target').write_text('\n'.join(metadata[:2]) + '\n')
    before = len(state['calls'])
    result, state = run(tmp_path, '--rollback')
    assert result.returncode != 0
    assert not any(call[:2] == ['docker', 'create'] or call[0] == 'sudo' for call in state['calls'][before:])
    assert state['active'] == 'bbbbbbbbbbbb'


def test_incompatible_rollback_refuses_before_touching_live_state(tmp_path):
    live, _, _ = setup(tmp_path)
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    state['schemas'] = {'aaaaaaaaaaaa': 'pre-v2', 'bbbbbbbbbbbb': 'v2'}
    (tmp_path / 'state.json').write_text(json.dumps(state))
    before = (live / 'data' / 'jobs.sqlite').read_bytes()
    result, state = run(tmp_path, '--rollback')
    assert result.returncode != 0
    assert state['active'] == 'bbbbbbbbbbbb' and state['running']
    assert (live / 'data' / 'jobs.sqlite').read_bytes() == before
    assert not (live / 'data' / '.release-maintenance').exists()


def test_failed_release_preserves_the_existing_previous_version_and_rollback_record(tmp_path):
    live, _, archive = setup(tmp_path, 'probe')
    state_path = tmp_path / 'state.json'
    state = json.loads(state_path.read_text())
    state['images']['jobs-radar:previous'] = 'cccccccccccc'
    state_path.write_text(json.dumps(state))
    prior = 'cccccccccccc\n' + str(archive / 'code-cccccccccccc-original.tgz') + '\n'
    (live / '.rollback-target').write_text(prior)
    result, state = run(tmp_path)
    assert result.returncode != 0
    assert state['images']['jobs-radar:previous'] == 'cccccccccccc'
    assert (live / '.rollback-target').read_text() == prior
    assert state['active'] == 'aaaaaaaaaaaa'


def test_candidate_and_recovered_image_are_checked_before_opening_a_port(tmp_path):
    setup(tmp_path, 'probe')
    result, state = run(tmp_path)
    assert result.returncode != 0
    calls = state['calls']
    starts = [i for i, call in enumerate(calls) if call[:3] == ['docker', 'compose', 'up']]
    assert len(starts) == 1
    for start in starts:
        checks = calls[:start]
        probes = [call for call in checks if call[:2] == ['docker', 'create'] and '-m' in call]
        assert len(probes) == 2
        assert all(probe[probe.index('--network') + 1] == 'none' for probe in probes)
        assert not any(arg in probe for probe in probes for arg in ('-p', '--publish', '--network=host'))
        assert any(call[:2] == ['docker', 'exec'] for call in checks)
        assert any(call[:3] == ['docker', 'rm', '-f'] for call in checks)


@pytest.mark.parametrize('existing_pause', [True, False])
def test_timers_stay_paused_when_container_marker_exists_or_cannot_be_read(tmp_path, existing_pause):
    live, _, _ = setup(tmp_path, None if existing_pause else 'maintenance_check')
    if existing_pause:
        (live / 'data/.release-maintenance').write_text('interrupted release')
    result, state = run(tmp_path)
    assert 'background writers stay paused' in result.stderr
    assert not any(call[:2] == ['systemctl', 'start'] for call in state['calls'])
    checks = [call for call in state['calls'] if call[:2] == ['docker', 'create'] and '.stat()' in call[-1]]
    assert checks and all(call[call.index('--user') + 1] == '10001:10001' for call in checks)
    if existing_pause:
        assert result.returncode != 0
        assert (live / 'data/.release-maintenance').read_text() == 'interrupted release'
        assert not any(call[:3] == ['docker', 'compose', 'stop'] for call in state['calls'])
    else:
        assert state['active'] == 'bbbbbbbbbbbb'


def test_timers_resume_only_after_the_container_confirms_marker_absence(tmp_path):
    setup(tmp_path)
    result, state = run(tmp_path)
    assert result.returncode == 0, result.stderr
    calls = state['calls']
    checked = next(index for index, call in enumerate(calls) if call[:2] == ['docker', 'create'] and '.stat()' in call[-1])
    starts = [index for index, call in enumerate(calls) if call[:2] == ['systemctl', 'start']]
    assert len(starts) == 2 and all(index > checked for index in starts)


def rehearsal(tmp_path):
    root = tmp_path / 'jobs-radar-stage' / 'rehearsal-abc123456789abcd'
    setup(root)
    (root / 'stages').mkdir()
    stage = root / 'stages' / 'bbbbbbbbbbbb'
    (root / 'stage').rename(stage)
    namespace = 'jobs-radar-rehearsal-abc123456789abcd'
    config = dict(name=namespace, services={'mcp': dict(image=namespace + ':0.1.0', network_mode='none',
        volumes=[dict(type='bind', source=str(root / 'live' / 'data'), target='/data')])})
    (root / 'compose.yaml').write_text(json.dumps(config))
    state = json.loads((root / 'state.json').read_text())
    state['images'] = {key.replace('jobs-radar:', namespace + ':'): value for key, value in state['images'].items()}
    (root / 'state.json').write_text(json.dumps(state))
    env = dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root), JOBS_RELEASE_IMAGE_PREFIX=namespace,
        JOBS_RELEASE_COMPOSE_PROJECT=namespace, JOBS_RELEASE_VERIFY_MODE='container', JOBS_RELEASE_MANAGE_TIMERS='0',
        COMPOSE_FILE=str(root / 'compose.yaml'))
    return root, stage, env


def test_isolated_release_uses_only_private_namespace_and_never_host_timers(tmp_path):
    root, stage, env = rehearsal(tmp_path)
    result, state = run(root, overrides=env, stage=stage)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(call[0] in {'sudo', 'systemctl', 'curl'} for call in state['calls'])
    tags = [call[-1] for call in state['calls'] if call[:2] == ['docker', 'tag']]
    assert tags and all(tag.startswith(env['JOBS_RELEASE_IMAGE_PREFIX'] + ':') for tag in tags)
    assert not any('jobs-radar:0.1.0' in call or 'jobs-radar:previous' in call for call in state['calls'])


@pytest.mark.parametrize('escape', ['timers_only', 'project', 'root', 'live_mount', 'public_port', 'network', 'compose_file'])
def test_rehearsal_overrides_cannot_disable_production_guards(tmp_path, escape):
    root, stage, env = rehearsal(tmp_path)
    if escape == 'timers_only':
        env = {'JOBS_RELEASE_MANAGE_TIMERS': '0'}
    elif escape == 'project':
        env['JOBS_RELEASE_COMPOSE_PROJECT'] = 'jobs-radar'
    elif escape == 'root':
        env['JOBS_RELEASE_REHEARSAL_ROOT'] = str(root / 'live')
    elif escape == 'compose_file':
        env['COMPOSE_FILE'] = str(root / 'outside.yaml')
    else:
        path = root / 'compose.yaml'
        config = json.loads(path.read_text())
        service = config['services']['mcp']
        if escape == 'live_mount': service['volumes'][0]['source'] = str(tmp_path / 'production')
        if escape == 'public_port': service['ports'] = [{'published': '8796', 'target': 8796}]
        if escape == 'network': service['network_mode'] = 'host'
        path.write_text(json.dumps(config))
    before = (root / 'live/data/jobs.sqlite').read_bytes()
    result, state = run(root, overrides=env, stage=stage)
    assert result.returncode != 0
    assert (root / 'live/data/jobs.sqlite').read_bytes() == before
    assert not any(call[0] in {'sudo', 'systemctl', 'rsync', 'tar'} or call[:2] in [['docker', 'run'], ['docker', 'tag']] for call in state['calls'])
