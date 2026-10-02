"""Run the real shell entry; fixture commands never reach SSH or Docker."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from test_release_switch import BASH

SCRIPT = Path(__file__).parents[1] / 'deploy/release.sh'
pytestmark = pytest.mark.skipif(not BASH or not Path(BASH).exists(), reason='Bash is required')

STUB = r'''
import json,os,subprocess,sys
from pathlib import Path
root=Path(os.environ['RECOVERY_ENTRY_ROOT']); command,*args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps([command,*args])+'\n')
release='a'*12; image='sha256:'+'b'*64
if command=='git':
    if args==['rev-parse','--show-toplevel']: print(root.as_posix())
    elif args[:1]==['status']:
        if os.environ.get('RECOVERY_DIRTY'): print(' M services/jobs-radar/changed')
    elif args==['rev-parse','--short=12','HEAD']: print(release)
    elif args[:1]==['rev-parse']: print(release+'c'*28)
    elif args[:1]==['archive']:
        assert args[2]==release+'c'*28; print('synthetic committed archive')
    else: raise ValueError(args)
elif command=='docker':
    assert args[:2]==['image','inspect']
    print(release if 'Labels' in args[-1] else image)
elif command=='timeout':
    while args[0].startswith('--'): args.pop(0)
    seconds=float(args.pop(0).removesuffix('s'))
    sys.exit(subprocess.run(args,timeout=seconds).returncode)
elif command=='ssh':
    remote=args[args.index('fixture@local')+1:]; data=sys.stdin.read()
    if remote[:2]==['bash','-s']:
        sys.exit(subprocess.run([os.environ['RECOVERY_BASH'],*remote[1:]],input=data,text=True).returncode)
    elif remote[0].startswith('mkdir -p '): assert data.strip()=='synthetic committed archive'
    elif remote[0].startswith("printf '%s"): assert '/RELEASE' in remote[0]
    else:
        assert remote[:1]==['python3'] and remote[1].endswith('/deploy/recover_profiles.py')
        assert remote[2] in ['--recover-profiles','--resume-applications']
        assert remote[-1]==image and remote[-3]==release
        if os.environ.get('RECOVERY_REMOTE_FAIL'): sys.exit(17)
        print('{"status":"synthetic-success"}')
else: raise ValueError(command)
'''


def run(tmp_path, mode, *args, **settings):
    stub = tmp_path / 'fixture.py'; stub.write_text(STUB)
    (tmp_path / 'bin').mkdir()
    for name in ('git', 'ssh', 'docker', 'timeout'):
        path = tmp_path / 'bin' / name
        path.write_text('#!/bin/bash\nexec "' + Path(sys.executable).as_posix() + '" "' + stub.as_posix() + '" ' + name + ' "$@"\n')
        path.chmod(0o755)
    env = dict(os.environ, RECOVERY_ENTRY_ROOT=str(tmp_path), RECOVERY_BASH=BASH,
               JOBS_RADAR_HOST='fixture@local', MSYS_NO_PATHCONV='1', **settings)
    bin_path = (tmp_path / 'bin').as_posix()
    if os.name == 'nt': bin_path = '/' + bin_path[0].lower() + bin_path[2:]
    result = subprocess.run([BASH, '-c', 'export PATH="' + bin_path + ':$PATH"; exec bash "$@"',
        'recovery-test', str(SCRIPT), mode, *args], capture_output=True, text=True, env=env, timeout=30)
    calls = [json.loads(line) for line in (tmp_path / 'calls.jsonl').read_text().splitlines()] if (tmp_path / 'calls.jsonl').exists() else []
    return result, calls


@pytest.mark.parametrize('mode', ['--recover-profiles', '--resume-applications'])
def test_explicit_committed_same_image_recovery_entry(tmp_path, mode):
    result, calls = run(tmp_path, mode, '--image-id', 'sha256:'+'b'*64)
    assert result.returncode == 0, result.stderr
    remotes = [call for call in calls if call[0] == 'ssh']
    assert remotes[-1][-7:] == [mode, '--live', '/home/ubuntu/siyi/jobs-radar',
        '--release', 'a'*12, '--image-id', 'sha256:'+'b'*64]
    assert any(call[:2] == ['git', 'archive'] for call in calls)
    assert not any('switch_release.sh' in part for call in calls for part in call)


@pytest.mark.parametrize('args', [[], ['--artifact', 'some-artifact'], ['--image-id', 'latest']])
def test_missing_or_mutable_image_never_reaches_remote(tmp_path, args):
    result, calls = run(tmp_path, '--recover-profiles', *args)
    assert result.returncode != 0 and not any(call[0] == 'ssh' for call in calls)


def test_dirty_tree_cannot_upload_or_invoke_driver(tmp_path):
    result, calls = run(tmp_path, '--resume-applications', '--image-id', 'sha256:'+'b'*64, RECOVERY_DIRTY='1')
    assert result.returncode != 0 and not any(call[0] == 'ssh' for call in calls)


def test_remote_failure_is_not_reported_as_success(tmp_path):
    result, calls = run(tmp_path, '--recover-profiles', '--image-id', 'sha256:'+'b'*64, RECOVERY_REMOTE_FAIL='1')
    assert result.returncode == 17
    assert not any('Released' in part for call in calls for part in call)
