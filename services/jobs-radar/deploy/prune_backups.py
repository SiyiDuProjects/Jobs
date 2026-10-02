"""Bound database backup retention without touching live data or audit records."""
import gzip
from pathlib import Path
import sqlite3
import tempfile


def prune(directory: Path, keep: int = 3):
    expected = Path('/home/ubuntu/siyi/jobs-radar/data/backups')
    if directory.is_symlink() or directory.resolve() != expected or keep < 1:
        raise ValueError('Unexpected backup directory or retention count')
    candidates = sorted(
        (p for p in directory.iterdir() if p.is_file() and not p.is_symlink()
         and (p.name.endswith('.sqlite') or p.name.endswith('.sqlite.gz'))),
        key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True,
    )
    retained = candidates[:keep]
    if len(retained) < keep:
        print(f'Only {len(retained)} backups present; nothing removed')
        return
    # Verify every retained recovery point before deleting any older database.
    for path in retained:
        with tempfile.TemporaryDirectory(prefix='jobs-backup-check-') as temp:
            check = path
            if path.name.endswith('.gz'):
                check = Path(temp) / 'backup.sqlite'
                with gzip.open(path, 'rb') as source, check.open('wb') as target:
                    import shutil
                    shutil.copyfileobj(source, target)
            with sqlite3.connect(check.as_uri() + '?mode=ro', uri=True) as connection:
                if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError(f'Backup integrity failed: {path.name}')
    removed_bytes = 0
    for path in candidates[keep:]:
        if path.parent.resolve() != expected or path.is_symlink():
            raise ValueError('Backup path changed during cleanup')
        removed_bytes += path.stat().st_size
        path.unlink()
        for suffix in ('-journal', '-wal', '-shm'):
            sidecar = path.with_name(path.name + suffix)
            if sidecar.is_file() and not sidecar.is_symlink():
                removed_bytes += sidecar.stat().st_size
                sidecar.unlink()
    print({'retained': [p.name for p in retained],
           'removed_count': len(candidates) - len(retained),
           'removed_bytes': removed_bytes})


if __name__ == '__main__':
    prune(Path('/home/ubuntu/siyi/jobs-radar/data/backups'))
