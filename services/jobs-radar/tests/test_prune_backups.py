import gzip
import os
import sqlite3

from deploy_module import module

prune_backups = module('prune_backups')


def backup(directory, name, mtime, compressed=False):
    database = directory / name
    with sqlite3.connect(database) as connection:
        connection.execute('create table marker(value)')
    connection.close()
    for suffix in ('-wal', '-shm'):
        (directory / (name + suffix)).write_bytes(b'sidecar')
    path = database
    if compressed:
        path = directory / (name + '.gz')
        path.write_bytes(gzip.compress(database.read_bytes()))
        database.unlink()
    os.utime(path, (mtime, mtime))
    return path


def test_removing_compressed_backup_also_removes_its_database_sidecars(tmp_path, monkeypatch):
    monkeypatch.setattr(prune_backups, 'BACKUPS', tmp_path.resolve())
    old = backup(tmp_path, 'jobs-1.sqlite', 1, compressed=True)
    kept = [backup(tmp_path, f'jobs-{day}.sqlite', day, compressed=day == 2) for day in (2, 3, 4)]
    (tmp_path / 'pre-board-state.json').write_text('{}')
    prune_backups.prune(tmp_path)
    assert not old.exists()
    assert not (tmp_path / 'jobs-1.sqlite-wal').exists() and not (tmp_path / 'jobs-1.sqlite-shm').exists()
    assert all(path.exists() for path in kept)
    assert (tmp_path / 'jobs-2.sqlite-shm').exists() and (tmp_path / 'pre-board-state.json').exists()
