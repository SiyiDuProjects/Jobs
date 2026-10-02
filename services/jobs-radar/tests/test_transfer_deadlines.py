"""Synthetic byte/time bounds; no SSH connection or personal material."""
import io
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from test_workspace_audit import implementation
from test_workspace_backup import arguments, fixture_archive


def test_receiver_byte_budget_leaves_no_partial_or_published_archive(tmp_path):
    backup, _, data = fixture_archive(tmp_path)
    destination = tmp_path / 'private/archive.tar.gz'
    with pytest.raises(ValueError, match='byte limit'):
        backup.receive(destination, io.BytesIO(data), max_bytes=8)
    assert not destination.exists()
    assert list(destination.parent.glob('*.partial')) == []


def test_receiver_elapsed_deadline_covers_read_and_verification(tmp_path):
    backup, _, data = fixture_archive(tmp_path)
    destination = tmp_path / 'private/archive.tar.gz'
    class Slow(io.BytesIO):
        def read(self, size=-1):
            time.sleep(0.02)
            return super().read(size)
    with pytest.raises(TimeoutError):
        backup.receive(destination, Slow(data), timeout=0.005)
    assert not destination.exists() and list(destination.parent.iterdir()) == []


def test_archive_writer_enforces_deadline_before_writing():
    backup = implementation('backup_workspace')
    target = io.BytesIO()
    writer = backup.DigestWriter(target, deadline=time.monotonic() - 1)
    with pytest.raises(TimeoutError):
        writer.write(b'synthetic data')
    assert target.getvalue() == b''


def test_archive_writer_enforces_size_before_writing():
    backup = implementation('backup_workspace')
    target = io.BytesIO()
    writer = backup.DigestWriter(target, max_bytes=2)
    with pytest.raises(ValueError, match='byte limit'):
        writer.write(b'oversized')
    assert target.getvalue() == b''


def test_whole_sender_deadline_includes_archive_generation_and_cleans_private_stage(tmp_path, monkeypatch):
    backup = implementation('backup_workspace')
    root, argv = arguments(tmp_path)
    monkeypatch.setattr(backup, 'require_sender_environment', lambda: None, raising=False)
    monkeypatch.setattr(backup, 'TRANSFER_SECONDS', 0.005, raising=False)
    original = backup.archive
    def slow(*args, **kwargs):
        time.sleep(0.02)
        return original(*args, **kwargs)
    monkeypatch.setattr(backup, 'archive', slow)
    monkeypatch.setattr(backup.subprocess, 'Popen', lambda *_a, **_k: pytest.fail('No SSH before bounded archive'))
    with pytest.raises(TimeoutError):
        backup.main(argv)
    stage = root / '.qa/recovery-transfer'
    assert stage.exists() and list(stage.iterdir()) == []


def test_stalled_real_child_does_not_block_sender_archive_write(tmp_path):
    backup = implementation('backup_workspace')
    source = tmp_path / 'synthetic-source'
    source.write_bytes(b'x' * 2 * 1024 * 1024)
    start = time.monotonic()
    with source.open('rb') as incoming, pytest.raises(TimeoutError):
        backup.transfer([sys.executable, '-c', 'import time;time.sleep(20)'], incoming, deadline=time.monotonic() + 0.1)
    assert time.monotonic() - start < 6


def test_large_real_child_output_is_bounded_and_never_echoed(tmp_path):
    backup = implementation('backup_workspace')
    with io.BytesIO() as source:
        # Actual Popen requires a file; all bytes are synthetic and private.
        path = tmp_path / 'empty'
        path.write_bytes(b'')
        with path.open('rb') as incoming, pytest.raises(ValueError, match='output limit') as error:
            backup.transfer([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"SYNTHETIC-SECRET"*100000)'], incoming,
                            deadline=time.monotonic() + 5, max_output=1024)
    assert 'SYNTHETIC-SECRET' not in str(error.value)


@pytest.mark.skipif(os.name != 'posix', reason='POSIX pipe/select deadline requires Linux')
def test_receiver_deadline_interrupts_an_open_pipe_without_data(tmp_path):
    backup = implementation('backup_workspace')
    read, write = os.pipe()
    try:
        with os.fdopen(read, 'rb') as stream, pytest.raises(TimeoutError):
            backup.receive(tmp_path / 'private/archive.tar.gz', stream, timeout=0.02)
    finally:
        os.close(write)
    assert list((tmp_path / 'private').iterdir()) == []


def test_single_gzip_member_cannot_hide_unmanifested_bytes_after_tar_end(tmp_path):
    backup, _, data = fixture_archive(tmp_path)
    target = tmp_path / 'hidden.tar.gz'
    target.write_bytes(gzip.compress(gzip.decompress(data) + b'SYNTHETIC-HIDDEN-PAYLOAD'))
    with pytest.raises(ValueError, match='Unmanifested data'):
        backup.verify_archive(target)


def test_private_staging_receipt_contains_only_paths_and_hashes_and_always_cleans(tmp_path):
    backup, root, _ = fixture_archive(tmp_path)
    plan = backup.prepare(root)
    with pytest.raises(RuntimeError, match='synthetic abort'):
        with backup.staged_archive(root, plan, deadline=time.monotonic() + 10):
            stage = root / '.qa/recovery-transfer'
            receipt = json.loads(next(stage.glob('*.json')).read_text())
            assert set(receipt) == {'archive', 'planSha256', 'archiveSha256'}
            assert 'Synthetic facts' not in json.dumps(receipt)
            if os.name == 'posix':
                assert stage.stat().st_mode & 0o077 == 0
                assert all(path.stat().st_mode & 0o077 == 0 for path in stage.iterdir())
            raise RuntimeError('synthetic abort')
    assert list(stage.iterdir()) == []
    assert (root / 'facts.md').read_text() == 'Synthetic facts only'


def test_unresolved_crash_receipt_blocks_new_staging_without_overwrite(tmp_path):
    backup, root, _ = fixture_archive(tmp_path)
    plan = backup.prepare(root)
    stage = root / '.qa/recovery-transfer'
    stage.mkdir(parents=True, mode=0o700)
    receipt = stage / 'old.json'
    receipt.write_text('{"archive":"old.partial","planSha256":"synthetic"}')
    with pytest.raises(ValueError, match='Previous recovery staging'):
        with backup.staged_archive(root, plan, deadline=time.monotonic() + 10):
            pytest.fail('Unresolved staging must block')
    assert list(stage.iterdir()) == [receipt]


@pytest.mark.skipif(os.name != 'posix', reason='POSIX process-group teardown requires Linux')
def test_transfer_timeout_kills_term_ignoring_grandchild(tmp_path):
    backup = implementation('backup_workspace')
    marker = tmp_path / 'late-descendant'
    child = ('import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);'
             'os.close(1);os.close(2);time.sleep(1);Path(' + repr(str(marker)) + ').write_text("late")')
    parent = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",' + repr(child) + ']);time.sleep(20)'
    source = tmp_path / 'empty'
    source.write_bytes(b'')
    with source.open('rb') as stream, pytest.raises(TimeoutError):
        backup.transfer([sys.executable, '-c', parent], stream, deadline=time.monotonic() + 0.2)
    time.sleep(1.1)
    assert not marker.exists()
