import hashlib
import json
import subprocess

import pytest

from deploy_module import module


@pytest.mark.parametrize('fault', [None, 'failed', 'lint-failed', 'mutated'])
def test_receipt_exists_only_after_all_checks_on_unchanged_committed_inputs(tmp_path, fault):
    checks = module('release_checks')
    root, output = tmp_path / 'source', tmp_path / 'artifact'
    root.mkdir(); output.mkdir()
    for relative in checks.INPUTS:
        directory = root / relative
        directory.mkdir(parents=True)
        (directory / 'synthetic.txt').write_text('synthetic committed input')
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True).stdout.strip()
    git('init'); git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic source')
    commit = git('rev-parse', 'HEAD')
    calls = []
    def invoke(args, **kwargs):
        if args[0] == 'git':
            return subprocess.run(args, capture_output=True, text=True, **kwargs)
        calls.append(args)
        service_test = args[1:3] == ['-m', 'pytest']
        lint = args[1:] == ['-m', 'ruff', 'check', '.']
        if service_test and fault == 'mutated':
            (kwargs['cwd'] / 'synthetic.txt').write_text('changed after checks')
        failed = (service_test and fault == 'failed') or (lint and fault == 'lint-failed')
        return subprocess.CompletedProcess(args, 1 if failed else 0, 'synthetic check output', '')
    if fault:
        with pytest.raises((ValueError, RuntimeError), match='changed|failed'):
            checks.run_checks(root, commit, 'c' * 64, output, lambda *_: None, invoke=invoke)
        assert not (output / 'tests.json').exists()
    else:
        receipt = checks.run_checks(root, commit, 'c' * 64, output, lambda *_: None, invoke=invoke)
        assert checks.validate_receipt(receipt, commit, 'c' * 64)
        assert receipt['testInputsSha256'] == hashlib.sha256((output / 'test-inputs.tar').read_bytes()).hexdigest()
        assert json.loads((output / 'tests.json').read_text()) == receipt
        assert not (output / 'checks-workspace').exists()
        assert len(calls) == 7
        assert any(args[1:] == ['-m', 'ruff', 'check', '.'] for args in calls)
    if fault == 'lint-failed':
        assert not any(args[1:3] == ['-m', 'pytest'] for args in calls)
    assert not any('docker' in str(arg) for command in calls for arg in command)


@pytest.mark.parametrize('fault', ['missing', 'commit', 'source', 'checks', 'fixtures', 'lint-missing'])
def test_receipt_cannot_be_reused_for_another_commit_or_failed_check(fault):
    checks = module('release_checks')
    receipt = dict(format=1, commit='b' * 40, sourceSha256='c' * 64,
                   testInputsSha256='d' * 64, checks={name: 'passed' for name in checks.CHECKS})
    if fault == 'missing': receipt = None
    elif fault == 'commit': receipt['commit'] = 'a' * 40
    elif fault == 'source': receipt['sourceSha256'] = 'a' * 64
    elif fault == 'checks': receipt['checks']['service-tests'] = 'failed'
    elif fault == 'lint-missing': del receipt['checks']['service-lint']
    else: receipt['testInputsSha256'] = ''
    with pytest.raises(ValueError, match='exact committed inputs'):
        checks.validate_receipt(receipt, 'b' * 40, 'c' * 64)


def test_local_inventory_never_follows_links_or_marks_recovery_archives_disposable(tmp_path):
    retention = module('local_retention')
    archives = tmp_path / '.qa/worktree-archives/recovery'
    archives.mkdir(parents=True)
    (archives / 'patch').write_bytes(b'needed recovery')
    outside = tmp_path / 'outside'; outside.write_bytes(b'private' * 100)
    (archives / 'linked').symlink_to(outside)
    report = retention.inventory(tmp_path, 'c' * 40)
    assert report['dryRun'] and report['totalBytes'] == len(b'needed recovery')
    assert report['items'][0]['protected'] and report['items'][0]['linksSkipped'] == 1
    assert outside.read_bytes() == b'private' * 100
