import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import tracemalloc

import pytest

from test_docker_rehearsal import module


class Engine:
    def __init__(self, fault=None):
        self.calls, self.containers, self.fault = [], {}, fault

    def __call__(self, args, **options):
        self.calls.append((args, options))
        command = args[1:]
        output = ''
        if command[0] == 'create':
            name = command[command.index('--name') + 1]
            label = command[command.index('--label') + 1].split('=', 1)
            value = dict(Id='a' * 64, Name='/' + name, Config={'Labels': dict([label])})
            self.containers[value['Id']] = value
            if self.fault == 'create_timeout':
                raise subprocess.TimeoutExpired(args, options['timeout'])
            Path(command[command.index('--cidfile') + 1]).write_text(value['Id'])
            output = value['Id']
        elif command[0] == 'start':
            if self.fault == 'start_timeout':
                raise subprocess.TimeoutExpired(args, options['timeout'])
            output = '{"completed":true}'
        elif command[0] == 'ps':
            query = command[command.index('--filter') + 1]
            output = '\n'.join(value['Id'] for value in self.containers.values()
                               if query in ('id=' + value['Id'], 'name=^' + value['Name'] + '$'))
        elif command[0] == 'inspect':
            output = json.dumps([value for value in self.containers.values()
                                 if command[1] in (value['Id'], value['Name'][1:])])
        elif command[:2] == ['rm', '-f']:
            del self.containers[command[-1]]
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(args, 0, output, '')


@pytest.mark.parametrize('fault', [None, 'create_timeout', 'start_timeout'])
def test_completed_or_interrupted_helpers_are_removed_by_verified_full_id(tmp_path, fault):
    helper = module('release_helpers')
    engine = Engine(fault)
    containers = helper.Containers(tmp_path / 'ledger', 'jobs-radar', invoke=engine)
    if fault:
        with pytest.raises(subprocess.TimeoutExpired):
            containers.start('jobs-radar:candidate', ['-c', 'pass'])
    else:
        result = containers.start('jobs-radar:candidate', ['-c', 'pass'])
        assert json.loads(result.stdout)['completed']
    assert engine.containers == {}
    plan = json.loads(next((tmp_path / 'ledger').glob('*.json')).read_text())
    assert plan['removed'] and plan['id'] == 'a' * 64
    removals = [args for args, _ in engine.calls if args[1:3] == ['rm', '-f']]
    assert removals == [['docker', 'rm', '-f', 'a' * 64]]
    creation = engine.calls[0][0]
    for flag, expected in {'--memory': '512m', '--memory-swap': '512m', '--cpus': '0.5', '--pids-limit': '128', '--network': 'none'}.items():
        assert creation[creation.index(flag) + 1] == expected
    assert all(0 < options['timeout'] <= 300 for _, options in engine.calls)


def test_detached_probe_is_persisted_and_later_cleanup_cannot_delete_changed_owner(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    containers.start('jobs-radar:candidate', ['-m', 'jobs_radar.cli', 'serve'], detached=True, name='jobs-radar-probe')
    assert len(engine.containers) == 1
    engine.containers['a' * 64]['Config']['Labels'][helper.LABEL] = 'other-owner'
    with pytest.raises(RuntimeError, match='ownership changed'):
        containers.cleanup()
    assert not any(args[1:3] == ['rm', '-f'] for args, _ in engine.calls)
    assert len(engine.containers) == 1


def test_recorded_old_id_does_not_remove_a_new_container_reusing_its_name(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    containers.start('jobs-radar:candidate', ['-c', 'pass'], detached=True)
    replacement = engine.containers.pop('a' * 64)
    replacement['Id'] = 'b' * 64
    engine.containers['b' * 64] = replacement
    containers.cleanup()
    assert list(engine.containers) == ['b' * 64]
    assert not any(args[1:3] == ['rm', '-f'] for args, _ in engine.calls)


@pytest.mark.parametrize('mode', ['helper', 'clone'])
def test_late_daemon_create_stays_pending_until_future_verified_cleanup(tmp_path, mode):
    helper = module('release_helpers')
    class LateEngine(Engine):
        def __call__(self, args, **options):
            if args[1] == 'create':
                super().__call__(args, **options)
                self.pending = self.containers.pop('a' * 64)
                raise subprocess.TimeoutExpired(args, options['timeout'])
            return super().__call__(args, **options)
    engine = LateEngine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    with pytest.raises(helper.CreationPending):
        if mode == 'clone':
            containers.clone_stopped('jobs-radar:candidate')
        else:
            containers.start('jobs-radar:candidate', ['-c', 'pass'])
    receipt = next(tmp_path.glob('*.json'))
    plan = json.loads(receipt.read_text())
    assert plan['creation'] == 'pending' and not plan['removed'] and not plan.get('id')
    with pytest.raises(RuntimeError, match='creation remains unresolved'):
        containers.cleanup()
    assert not json.loads(receipt.read_text())['removed']
    # A fresh process must retry the unresolved receipt after Docker completes.
    engine.containers['a' * 64] = engine.pending
    helper.Containers(tmp_path, 'jobs-radar', invoke=engine).cleanup()
    assert engine.containers == {}
    final = json.loads(receipt.read_text())
    assert final['creation'] == 'known' and final['removed'] and final['id'] == 'a' * 64


def test_old_receipt_marked_removed_without_id_is_not_trusted(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar-rehearsal-123456789abc', invoke=engine)
    path = containers.track_name('jobs-radar-rehearsal-123456789abc-mcp-1', containers.namespace)
    plan = json.loads(path.read_text())
    plan['removed'] = True
    containers.save(path, plan)
    with pytest.raises(RuntimeError, match='unresolved'):
        containers.cleanup()
    assert not json.loads(path.read_text())['removed']


def test_daemon_command_cli_uses_outer_deadline_and_preserves_nonzero_status(monkeypatch, capsys):
    helper = module('release_helpers')
    calls = []
    def invoke(args, **options):
        calls.append((args, options))
        return subprocess.CompletedProcess(args, 17, 'bounded output', 'bounded error')
    monkeypatch.setattr(helper, 'bounded', invoke)
    monkeypatch.setattr(sys, 'argv', ['release_helpers.py', 'docker-command', '--timeout', '90', '--', 'exec', 'owned', 'python', '-c', 'pass'])
    with pytest.raises(SystemExit) as error:
        helper.main()
    assert error.value.code == 17
    assert calls == [(['docker', 'exec', 'owned', 'python', '-c', 'pass'], {'timeout': 90})]
    captured = capsys.readouterr()
    assert captured.out == 'bounded output' and captured.err == 'bounded error'


def test_real_timed_out_child_cannot_write_after_timeout(tmp_path):
    helper = module('release_helpers')
    marker = tmp_path / 'late-write'
    code = 'import time; from pathlib import Path; time.sleep(0.7); Path(' + repr(str(marker)) + ').write_text("late")'
    with pytest.raises(subprocess.TimeoutExpired):
        helper.bounded([sys.executable, '-c', code], timeout=0.1)
    time.sleep(0.8)
    assert not marker.exists()


@pytest.mark.skipif(os.name != 'posix', reason='Linux process-group semantics require a POSIX host')
def test_timeout_kills_a_term_ignoring_grandchild_even_after_it_closes_pipes(tmp_path):
    helper = module('release_helpers')
    marker = tmp_path / 'descendant-write'
    grandchild = 'import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);os.close(1);os.close(2);time.sleep(1);Path(' + repr(str(marker)) + ').write_text("survived")'
    parent = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",' + repr(grandchild) + ']);time.sleep(5)'
    with pytest.raises(subprocess.TimeoutExpired):
        helper.bounded([sys.executable, '-c', parent], timeout=0.3)
    time.sleep(1.2)
    assert not marker.exists()


def test_stopped_variant_clone_never_starts_a_build_worker(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    plan, container_id = containers.clone_stopped('jobs-radar:candidate')
    assert container_id == 'a' * 64
    assert not any(args[1] in {'start', 'build'} for args, _ in engine.calls)
    containers.remove(plan)
    assert engine.containers == {}


def test_corrupt_ledger_entry_does_not_prevent_other_verified_cleanup(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    containers.start('jobs-radar:candidate', ['-c', 'pass'], detached=True)
    (tmp_path / '000-corrupt.json').write_text('{')
    with pytest.raises(RuntimeError, match='JSONDecodeError'):
        containers.cleanup()
    assert engine.containers == {}
    assert (tmp_path / '000-corrupt.json').read_text() == '{'


def test_ledger_is_synced_before_create_and_does_not_store_arguments_or_environment(tmp_path, monkeypatch):
    helper = module('release_helpers')
    engine = Engine()
    synced = []
    original = os.fsync
    def sync(descriptor):
        synced.append(descriptor)
        return original(descriptor)
    monkeypatch.setattr(os, 'fsync', sync)
    def invoke(args, **kwargs):
        assert synced, 'The intent must reach durable storage before Docker runs'
        return engine(args, **kwargs)
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=invoke)
    containers.start('jobs-radar:candidate', ['-c', 'secret-command-marker'], environment=['KEY=secret-environment-marker'])
    raw = next(tmp_path.glob('*.json')).read_text()
    assert 'secret-command-marker' not in raw and 'secret-environment-marker' not in raw
    assert len(synced) >= 3


def test_failure_to_persist_creation_intent_never_starts_docker(tmp_path, monkeypatch):
    helper = module('release_helpers')
    engine = Engine()
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=engine)
    def fail(_):
        raise OSError('fsync failed')
    monkeypatch.setattr(os, 'fsync', fail)
    with pytest.raises(OSError, match='fsync failed'):
        containers.start('jobs-radar:candidate', ['-c', 'pass'])
    assert engine.calls == []


@pytest.mark.parametrize('stream', ['stdout', 'stderr'])
def test_large_real_output_is_stopped_with_bounded_host_memory_and_no_logged_payload(tmp_path, stream):
    helper = module('release_helpers')
    marker = tmp_path / 'late-output-finished'
    code = ('import sys;from pathlib import Path;'
            'data=b"sensitive-marker"*1024;'
            '[sys.' + stream + '.buffer.write(data) for _ in range(1200)];'
            'sys.' + stream + '.flush();Path(' + repr(str(marker)) + ').write_text("finished")')
    tracemalloc.start()
    try:
        with pytest.raises(helper.OutputLimitExceeded) as error:
            helper.bounded([sys.executable, '-c', code], timeout=10, max_output_bytes=65536)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert 'sensitive-marker' not in str(error.value)
    assert not marker.exists()
    assert peak < 2 * 1024 * 1024, f'Host memory exceeded bounded capture: {peak}'


def test_output_budget_is_combined_across_both_streams_and_cleanup_still_runs(tmp_path):
    helper = module('release_helpers')
    engine = Engine()
    def invoke(args, **options):
        if args[1] == 'start':
            return helper.bounded([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"a"*40000);sys.stderr.buffer.write(b"b"*40000)'], max_output_bytes=65536)
        return engine(args, **options)
    containers = helper.Containers(tmp_path, 'jobs-radar', invoke=invoke)
    with pytest.raises(helper.OutputLimitExceeded):
        containers.start('jobs-radar:candidate', ['-c', 'pass'])
    assert engine.containers == {}
    assert json.loads(next(tmp_path.glob('*.json')).read_text())['removed']


def test_small_json_and_both_streams_are_preserved_without_truncation():
    result = module('release_helpers').bounded([sys.executable, '-c',
        'import sys;print("{\\\"verified\\\":true}");sys.stderr.write("diagnostic\\n")'])
    assert json.loads(result.stdout) == {'verified': True}
    assert result.stderr == 'diagnostic\n'
