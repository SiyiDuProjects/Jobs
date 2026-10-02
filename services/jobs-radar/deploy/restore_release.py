"""Restore the matching database while release writes are still paused."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3

from verify_restore import fingerprint


def restore(backup, database):
    backup, database = Path(backup).resolve(strict=True), Path(database).resolve(strict=True)
    if backup == database or not (database.parent / '.release-maintenance').is_file():
        raise ValueError('Separate backup and active release maintenance required')
    expected = fingerprint(backup)
    with closing(sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(database)) as destination:
            source.backup(destination)
            destination.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    if fingerprint(database) != expected:
        raise ValueError('Restored database differs from the verified recovery point')
    return {'restored': True, 'integrity': 'ok', 'tables': len(expected['counts'])}


if __name__ == '__main__':
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    parser.add_argument('database', type=Path)
    args = parser.parse_args()
    print(json.dumps(restore(args.backup, args.database)))
