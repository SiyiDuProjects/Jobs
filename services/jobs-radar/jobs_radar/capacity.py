"""Read-only space checks for a database backup plus its restore rehearsal."""
import json
from pathlib import Path
import shutil

HEADROOM_BYTES = 1024 ** 3


def measure(source, destination, transfer_bytes=0):
    if type(transfer_bytes) is not int or transfer_bytes < 0:
        raise ValueError("Invalid transfer size")
    source, destination = Path(source), Path(destination)
    size = source.stat().st_size
    wal = source.with_name(source.name + '-wal')
    # Conservatively count uncheckpointed pages as possible database growth.
    wal_size = wal.stat().st_size if wal.exists() else 0
    parent = destination
    while not parent.exists():
        parent = parent.parent
    free = shutil.disk_usage(parent).free
    required = 2 * (size + wal_size) + HEADROOM_BYTES + transfer_bytes
    return {'databaseBytes': size, 'walBytes': wal_size, 'freeBytes': free,
            'requiredBytes': required, 'headroomBytes': HEADROOM_BYTES, 'transferBytes': transfer_bytes,
            'shortfallBytes': max(0, required - free), 'passed': free >= required}


def require_space(source, destination, transfer_bytes=0):
    result = measure(source, destination, transfer_bytes)
    if not result['passed']:
        raise ValueError('Insufficient free disk space for backup and restore rehearsal: ' + json.dumps(result, sort_keys=True))
    return result


if __name__ == '__main__':
    import sys
    print(json.dumps(require_space(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 0), sort_keys=True))
