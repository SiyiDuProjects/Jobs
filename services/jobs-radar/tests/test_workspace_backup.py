import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest


def implementation():
    path = Path(__file__).parents[1] / 'deploy' / 'backup_workspace.py'
    spec = importlib.util.spec_from_file_location('workspace_backup', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backup_preserves_originals_and_retired_untracked_files_with_verified_hashes(tmp_path):
    root, retired = tmp_path / 'current', tmp_path / 'old'
    root.mkdir(); retired.mkdir()
    (root / 'original.pdf').write_bytes(b'synthetic attachment bytes')
    (retired / 'untracked.md').write_text('synthetic untracked note')
    for name in ['.env', '.env.production', 'private-connection.js', '.git', '.npmrc']:
        (root / name).write_text('synthetic credential must be omitted')
    (root / '.private').mkdir()
    (root / '.private' / 'connection.json').write_text('synthetic connection')
    stream = io.BytesIO()
    result = implementation().archive(root, stream, [('aa1f', retired)])
    assert result['files'] == 2 and result['excluded'] == 6 and result['complete']
    stream.seek(0)
    with tarfile.open(fileobj=stream, mode='r:gz') as archive:
        assert set(archive.getnames()) == {'original.pdf', 'retired-worktrees/aa1f/untracked.md', 'RECOVERY-MANIFEST.json'}
        manifest = json.load(archive.extractfile('RECOVERY-MANIFEST.json'))
        for row in manifest['files']:
            data = archive.extractfile(row['path']).read()
            assert len(data) == row['size'] and hashlib.sha256(data).hexdigest() == row['sha256']


def test_invalid_retired_archive_paths_are_rejected_before_writing(tmp_path):
    for label in ['../../outside', '/absolute', 'with spaces']:
        stream = io.BytesIO()
        with pytest.raises(ValueError):
            implementation().archive(tmp_path, stream, [(label, tmp_path)])
        assert stream.getvalue() == b''


def fixture_archive(tmp_path):
    root = tmp_path / 'source'
    root.mkdir()
    (root / 'facts.md').write_text('Synthetic facts only')
    output = io.BytesIO()
    module = implementation()
    module.archive(root, output)
    return module, root, output.getvalue()


def test_old_builds_captures_browser_storage_and_history_are_not_assumed_credential_free(tmp_path):
    for name in ['dist', '.qa', 'artifacts', 'Local Storage', 'Default']:
        path = tmp_path / name
        path.mkdir()
        (path / 'arbitrary.bin').write_bytes(b'Unmarked opaque historical credentials')
    for name in ['history.bundle', 'captured.zip', 'private.sqlite', 'source.docx']:
        (tmp_path / name).write_bytes(b'opaque compressed data')
    (tmp_path / 'source.md').write_text('Safe synthetic document')
    module = implementation()
    plan = module.prepare(tmp_path)
    assert [row['path'] for row in plan['files']] == ['source.md']
    incomplete = {row['path'] for row in module.summary(plan)['incomplete']}
    assert incomplete == {'.qa/', 'artifacts/', 'Local Storage/', 'Default/', 'history.bundle', 'captured.zip', 'private.sqlite', 'source.docx'}
    assert module.summary(plan)['complete'] is False
    assert 'opaque compressed data' not in json.dumps(module.summary(plan))


@pytest.mark.parametrize('value', [b'{"password":"synthetic-not-real"}', b'password = "synthetic-not-real"',
                                 b'Authorization: Bearer synthetic-not-real', b'-----BEGIN PRIVATE KEY-----',
                                 b'sk-proj-synthetic000000000000000000'])
def test_content_markers_in_unexpected_source_names_fail_closed_without_echoing_values(tmp_path, value):
    (tmp_path / 'ordinary.txt').write_bytes(value)
    module = implementation()
    plan = module.prepare(tmp_path)
    assert not plan['files']
    assert module.summary(plan)['incomplete'][0]['reason'] == 'possible-credential-content'
    assert value.decode() not in json.dumps(module.summary(plan))


def arguments(tmp_path):
    root = tmp_path / 'source'
    root.mkdir()
    (root / 'source.md').write_text('Synthetic document')
    key = tmp_path / 'identity.pem'
    key.write_text('Synthetic identity placeholder')
    return root, [str(root), '--host', 'owner@example.test', '--key', str(key), '--destination', '/private/recovery/archive.tar.gz']


@pytest.mark.parametrize('extra', [['--retired-worktree', 'missing-separator'], ['--retired-worktree', 'unsafe=missing-path'],
                                  ['--host', 'example.test;injected'], ['--destination', '/private/../archive.tar.gz'],
                                  ['--destination', '/archive.tar.gz'], ['--key', 'missing-identity']])
def test_invalid_arguments_and_roots_are_rejected_before_starting_ssh(tmp_path, monkeypatch, extra):
    module = implementation()
    _, argv = arguments(tmp_path)
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *a, **k: pytest.fail('SSH must not start'))
    with pytest.raises((ValueError, FileNotFoundError)):
        module.main(argv + extra)


def test_incomplete_inventory_stops_before_ssh_and_lists_only_paths_and_reasons(tmp_path, monkeypatch, capsys):
    module = implementation()
    root, argv = arguments(tmp_path)
    (root / '.qa').mkdir()
    (root / '.qa' / 'required.bundle').write_bytes(b'synthetic history')
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *a, **k: pytest.fail('SSH must not start'))
    with pytest.raises(ValueError, match='incomplete'):
        module.main(argv)
    report = json.loads(capsys.readouterr().out)
    assert report['complete'] is False and report['incomplete'][0]['path'] == '.qa/'


def test_preflight_missing_changed_or_reserved_sources_are_never_silently_omitted(tmp_path):
    module, root, _ = fixture_archive(tmp_path)
    plan = module.prepare(root)
    (root / 'facts.md').write_text('Changed synthetic text')
    with pytest.raises(ValueError, match='changed'):
        module.archive(root, io.BytesIO(), plan=plan)
    (root / 'facts.md').unlink()
    with pytest.raises(FileNotFoundError):
        module.archive(root, io.BytesIO(), plan=plan)
    (root / 'RECOVERY-MANIFEST.json').write_text('{}')
    with pytest.raises(ValueError, match='reserved'):
        module.prepare(root)


def test_receiver_publishes_only_a_fully_verified_archive_and_never_replaces_existing_backup(tmp_path):
    module, _, data = fixture_archive(tmp_path)
    destination = tmp_path / 'private' / 'archive.tar.gz'
    result = module.receive(destination, io.BytesIO(data))
    assert destination.read_bytes() == data
    assert result['files'] == 1 and result['sha256'] == hashlib.sha256(data).hexdigest()
    assert list(destination.parent.glob('*.partial')) == []
    with pytest.raises(ValueError, match='exists'):
        module.receive(destination, io.BytesIO(b'bad replacement'))
    assert destination.read_bytes() == data


@pytest.mark.parametrize('kind', ['truncated', 'missing-manifest', 'checksum', 'incomplete'])
def test_receiver_removes_failed_temporary_archive_and_does_not_publish(tmp_path, kind):
    module, _, data = fixture_archive(tmp_path)
    if kind == 'truncated':
        broken = data[:-8]
    else:
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as tar:
            payload = b'Synthetic file'
            item = tarfile.TarInfo('file.txt'); item.size = len(payload)
            tar.addfile(item, io.BytesIO(payload))
            if kind != 'missing-manifest':
                manifest = json.dumps({'version': 2, 'complete': kind != 'incomplete',
                    'files': [{'path': 'file.txt', 'size': len(payload), 'sha256': 'wrong'}]}).encode()
                item = tarfile.TarInfo('RECOVERY-MANIFEST.json'); item.size = len(manifest)
                tar.addfile(item, io.BytesIO(manifest))
        broken = output.getvalue()
    destination = tmp_path / 'private' / 'archive.tar.gz'
    with pytest.raises((ValueError, EOFError, tarfile.TarError)):
        module.receive(destination, io.BytesIO(broken))
    assert not destination.exists()
    assert list(destination.parent.iterdir()) == []


def test_interrupted_receiver_and_concurrent_publish_leave_no_half_archive(tmp_path, monkeypatch):
    module, _, data = fixture_archive(tmp_path)
    destination = tmp_path / 'private' / 'archive.tar.gz'
    class Interrupted(io.BytesIO):
        def read(self, size=-1):
            raise OSError('Synthetic connection loss')
    with pytest.raises(OSError):
        module.receive(destination, Interrupted())
    assert list(destination.parent.iterdir()) == []
    def raced(source, target):
        Path(target).write_bytes(b'Existing backup wins')
        raise FileExistsError()
    monkeypatch.setattr(module.os, 'link', raced)
    with pytest.raises(FileExistsError):
        module.receive(destination, io.BytesIO(data))
    assert destination.read_bytes() == b'Existing backup wins'
    assert list(destination.parent.glob('*.partial')) == []


@pytest.mark.parametrize('outcome', ['success', 'bad-ack', 'remote-failure', 'changed-source'])
def test_sender_verifies_remote_acknowledgement_and_stops_failed_transfer(tmp_path, monkeypatch, capsys, outcome):
    import subprocess
    import sys
    module = implementation()
    root, argv = arguments(tmp_path)
    monkeypatch.setattr(module, 'require_sender_environment', lambda: None)
    actual_popen, children = subprocess.Popen, []
    if outcome == 'changed-source':
        original = module.archive
        def changed(*args, **kwargs):
            (root / 'source.md').write_text('Changed after preflight')
            return original(*args, **kwargs)
        monkeypatch.setattr(module, 'archive', changed)
    def start(command, **kwargs):
        assert command[0] == 'ssh' and command[-2] == 'owner@example.test'
        assert 'verify_archive' in command[-1] and 'receive(' in command[-1]
        assert 'print(json.dumps(receive_limited(sys.argv[1],sys.stdin.buffer)))' in command[-1]
        assert kwargs['stdin'].seekable(), 'SSH reads a prepared file, never a parent-written pipe'
        program = ('import importlib.util,io,json,sys;from pathlib import Path;'
            's=importlib.util.spec_from_file_location("receiver",' + repr(str(Path(module.__file__).resolve())) + ');'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
            'data=sys.stdin.buffer.read(5242880);'
            + ('sys.exit(2);' if outcome == 'remote-failure' else '')
            + 'r=m.receive(Path(' + repr(str(tmp_path / 'received/verified.tar.gz')) + '),io.BytesIO(data));'
            + ('r["sha256"]="wrong";' if outcome == 'bad-ack' else '')
            + 'print(json.dumps(r))')
        child = actual_popen([sys.executable, '-c', program], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(module.subprocess, 'Popen', start)
    if outcome == 'success':
        module.main(argv)
        report = json.loads(capsys.readouterr().out)
        assert report['verified'] and report['complete']
    else:
        with pytest.raises((ValueError, RuntimeError)):
            module.main(argv)
        assert capsys.readouterr().out == ''
    if outcome == 'changed-source':
        assert children == []
    else:
        assert children and all(child.poll() is not None for child in children)
    assert list((root / '.qa/recovery-transfer').iterdir()) == []
