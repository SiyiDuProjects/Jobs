"""Run release checks against an isolated, exact committed checkout.

Receipts bind tests, cross-repository fixtures and the eventual image to one
source archive. They are build evidence, not browser or production acceptance.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

from release_helpers import bounded

CHECKS = ('website-tests', 'website-build', 'website-artifacts', 'service-lint', 'service-tests')
INPUTS = ('services/jobs-radar', 'extensions/speedyapply-local', 'scripts')


def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def receipt_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_receipt(value, commit, source_hash):
    if (not isinstance(value, dict) or value.get('format') != 1 or value.get('commit') != commit
            or value.get('sourceSha256') != source_hash
            or not re.fullmatch(r'[a-f0-9]{64}', value.get('testInputsSha256', ''))
            or value.get('checks') != {name: 'passed' for name in CHECKS}):
        raise ValueError('Release requires passing tests for the exact committed inputs')
    return receipt_hash(value)


def archive_test_inputs(root, commit, destination, run):
    timestamp = run(['git', '-C', str(root), 'show', '-s', '--format=%ct', commit])
    if not re.fullmatch(r'[0-9]+', timestamp):
        raise ValueError('Invalid release-test input timestamp')
    run(['git', '-C', str(root), 'archive', '--format=tar', '--mtime=@' + timestamp,
         '--output=' + str(destination), commit, *INPUTS])

def run_checks(root, commit, source_hash, folder, stage_vendor, invoke=None):
    root, folder = Path(root), Path(folder)
    workspace = folder / 'checks-workspace'
    archive = folder / 'test-inputs.tar'
    environment = {key: value for key, value in os.environ.items()
                   if key in {'PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'}}

    def run(args, cwd=None, name=None, timeout=900):
        result = (invoke or bounded)(args, cwd=cwd, env=environment, timeout=timeout)
        if name:
            (folder / (name + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('Release check failed: ' + (name or str(args[0])) + '\n' + result.stderr[-2000:])
        return result.stdout.strip()

    archive_test_inputs(root, commit, archive, run)
    workspace.mkdir(mode=0o700)
    with tarfile.open(archive) as source:
        for member in source:
            parts = Path(member.name).parts
            if (member.name.startswith(('/', '\\')) or '..' in parts
                    or not (member.isfile() or member.isdir())
                    or any(part.lower() in {'.env', '.git', '.qa', 'data', 'secrets', 'credentials', '.ssh', 'source-materials'} for part in parts)
                    or re.search(r'\.env\.|\.sqlite|\.(pem|p12|pfx)$', member.name, re.I)):
                raise ValueError('Unsafe release-test input: ' + member.name)
        source.extractall(workspace, filter='data')
    original = {path: checksum(path) for path in workspace.rglob('*') if path.is_file()}
    service = workspace / INPUTS[0]
    stage_vendor(root, service)
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    # Install only inside this generated checkout. No credentials are forwarded;
    # the licensed package is the existing integrity-checked local tarball.
    for relative in ('services/jobs-radar/web', 'extensions/speedyapply-local'):
        run([npm, 'ci', '--no-audit', '--no-fund'], workspace / relative,
            'dependencies-' + Path(relative).name)
    run([npm, 'test'], service / 'web', 'website-tests')
    run([npm, 'run', 'build'], service / 'web', 'website-build')
    run([npm, 'run', 'test:build'], service / 'web', 'website-artifacts')
    local_python = root / INPUTS[0] / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    python = os.environ.get('JOBS_BUILD_PYTHON') or (str(local_python) if local_python.is_file() else sys.executable)
    run([python, '-m', 'ruff', 'check', '.'], service, 'service-lint')
    run([python, '-m', 'pytest', '-q'], service, 'service-tests', timeout=1200)
    if any(not path.is_file() or path.is_symlink() or checksum(path) != expected
           for path, expected in original.items()):
        raise ValueError('Release-test source changed during validation')
    receipt = {'format': 1, 'commit': commit, 'sourceSha256': source_hash,
               'testInputsSha256': checksum(archive), 'checks': {name: 'passed' for name in CHECKS}}
    validate_receipt(receipt, commit, source_hash)
    (folder / 'tests.json').write_text(json.dumps(receipt, indent=2) + '\n')
    # Keep input archive and bounded logs; disposable installs have no recovery value.
    if workspace.resolve() != workspace.absolute() or workspace.parent != folder:
        raise ValueError('Unexpected release-test cleanup path')
    shutil.rmtree(workspace)
    return receipt
