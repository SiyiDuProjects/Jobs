"""Actual OS resource-limit behavior on synthetic inputs, never real SSH."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from test_workspace_backup import arguments, fixture_archive, implementation


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux RLIMIT receiver requires Linux')
@pytest.mark.parametrize('failure', ['memory', 'cpu'])
def test_limited_receiver_stops_resource_exhaustion_without_publish_or_original_change(tmp_path, failure):
    module = implementation()
    original = tmp_path / 'original.txt'
    original.write_bytes(b'Synthetic original stays unchanged')
    expected_hash = hashlib.sha256(original.read_bytes()).hexdigest()
    destination = tmp_path / 'private/archive.tar.gz'
    program = '''import importlib.util,io,json,resource,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('backup', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
def exhaust(*args, **kwargs):
    if sys.argv[3] == 'memory':
        bytearray(512 * 1024**2)
    else:
        while True:
            pass
    raise AssertionError('OS resource limit did not stop work')
m.verify_archive=exhaust
try:
    m.receive_limited(Path(sys.argv[2]), io.BytesIO(b'Synthetic incoming bytes'), cpu_seconds=1)
except (MemoryError,TimeoutError) as error:
    print(json.dumps(dict(error=type(error).__name__, memory=resource.getrlimit(resource.RLIMIT_AS), core=resource.getrlimit(resource.RLIMIT_CORE))))
    raise SystemExit(7)
raise SystemExit(99)
'''
    result = subprocess.run([sys.executable, '-c', program, str(Path(module.__file__).resolve()), str(destination), failure],
                            capture_output=True, text=True, timeout=8)
    assert result.returncode == 7, result.stderr
    observed = json.loads(result.stdout)
    assert observed['error'] == ('MemoryError' if failure == 'memory' else 'TimeoutError')
    assert observed['memory'] == [256 * 1024**2, 256 * 1024**2]
    assert observed['core'] == [0, 0]
    assert not destination.exists()
    assert list(destination.parent.iterdir()) == []
    assert hashlib.sha256(original.read_bytes()).hexdigest() == expected_hash


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux RLIMIT receiver requires Linux')
def test_limited_receiver_accepts_a_valid_synthetic_archive_under_actual_limits(tmp_path):
    module, _, raw = fixture_archive(tmp_path)
    incoming = tmp_path / 'incoming.tar.gz'
    incoming.write_bytes(raw)
    destination = tmp_path / 'private/accepted.tar.gz'
    program = '''import importlib.util,json,resource,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('backup', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
with open(sys.argv[2], 'rb') as source:
    result=m.receive_limited(Path(sys.argv[3]), source)
print(json.dumps(dict(result=result,memory=resource.getrlimit(resource.RLIMIT_AS),cpu=resource.getrlimit(resource.RLIMIT_CPU))))
'''
    result = subprocess.run([sys.executable, '-c', program, str(Path(module.__file__).resolve()), str(incoming), str(destination)],
                            capture_output=True, text=True, timeout=8)
    assert result.returncode == 0, result.stderr
    observed = json.loads(result.stdout)
    assert observed['result']['sha256'] == hashlib.sha256(raw).hexdigest()
    assert observed['memory'] == [256 * 1024**2, 256 * 1024**2]
    assert 30 <= observed['cpu'][0] <= 31 and observed['cpu'][1] == observed['cpu'][0] + 1
    assert destination.read_bytes() == incoming.read_bytes() == raw


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux RLIMIT receiver requires Linux')
def test_sender_embeds_and_executes_the_limited_receiver_before_publication(tmp_path, monkeypatch, capsys):
    import shlex
    module = implementation()
    root, argv = arguments(tmp_path)
    monkeypatch.setattr(module, 'require_sender_environment', lambda: None)
    actual_popen, children = subprocess.Popen, []
    def local_receiver(command, **kwargs):
        assert command[0] == 'ssh' and command[-2] == 'owner@example.test'
        remote = shlex.split(command[-1])
        assert remote[:2] == ['python3', '-c']
        # Execute the exact generated receiver source, replacing only SSH and
        # the synthetic destination. Check its real inherited resource state.
        program = remote[2] + '\nimport resource\nassert resource.getrlimit(resource.RLIMIT_AS)==(268435456,268435456)\nassert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)\n'
        child = actual_popen([sys.executable, '-c', program, str(tmp_path / 'received/verified.tar.gz')], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(module.subprocess, 'Popen', local_receiver)
    module.main(argv)
    assert json.loads(capsys.readouterr().out)['verified'] is True
    assert children and all(child.returncode == 0 for child in children)
    assert list((root / '.qa/recovery-transfer').iterdir()) == []
