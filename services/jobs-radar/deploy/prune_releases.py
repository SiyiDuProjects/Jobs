"""Bound per-release copies; keep the live release, its rollback pair and recent snapshots.

Only names written by release.sh/switch_release.sh are managed. Migration reports,
scheduled backups, website bundles and every unrecognized entry stay in place and
are listed for review. Without --apply nothing is changed.
"""
import argparse
from contextlib import closing
import gzip
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time

KEEP_SNAPSHOTS = 2
# A concurrent release stages/imports before taking the switch locks.
IN_FLIGHT_SECONDS = 3600
RUN = r'(?P<commit>[a-f0-9]{12,40})-(?P<stamp>\d{8}T\d{6}Z)-\d+'
RUN_DIR = re.compile(RUN)
DATABASE = ('pre-change.sqlite', 'pre-change.sqlite.gz')
SNAPSHOT_FILE = re.compile(r'pre-change\.sqlite(\.gz)?(-wal|-shm|-journal)?')
CODE = re.compile(r'code-[a-f0-9]{12,40}-' + RUN + r'\.tgz')
# Per-transaction scratch: the rollback record copy and code-restore folder.
SCRATCH = re.compile(r'(rollback-target|recovery)-' + RUN)
STAGE = re.compile(r'[a-f0-9]{12}')
IMPORT = re.compile(r'import-(?P<commit>[a-f0-9]{40})-[a-f0-9]{12}')


def docker_command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120).stdout


def size(path):
    if path.is_symlink() or not path.is_dir():
        return path.lstat().st_size
    return sum(p.lstat().st_size for p in path.rglob('*') if p.is_symlink() or not p.is_dir())


def listing(root):
    if not root.exists() and not root.is_symlink():
        return []
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Unexpected release layout: ' + str(root))
    return sorted(root.iterdir())


def plain_dir(path):
    return path.is_dir() and not path.is_symlink()


def plain_file(path):
    return path.is_file() and not path.is_symlink()


def plan(live, stage_root, archive, *, keep=KEEP_SNAPSHOTS, now=None, docker=docker_command, prefix='jobs-radar'):
    live, stage_root, archive = Path(live).resolve(), Path(stage_root).resolve(), Path(archive).resolve()
    if keep < 1:
        raise ValueError('At least one release snapshot must be retained')
    now = time.time() if now is None else now
    current = (live / 'RELEASE').read_text().strip()
    if not re.fullmatch('[a-f0-9]{12,40}', current):
        raise ValueError('Live release has no verified identity')
    record = live / '.rollback-target'
    rollback = record.read_text().splitlines() if plain_file(record) else []
    protected = {current[:12]} | ({rollback[0][:12]} if rollback else set())
    rollback_code = Path(rollback[1]).resolve() if len(rollback) > 1 else None
    remove, retained, unmanaged = [], [], []

    stages = listing(stage_root)
    for path in stages:
        match = IMPORT.fullmatch(path.name)
        if plain_dir(path) and (STAGE.fullmatch(path.name) or match) and now - path.lstat().st_mtime < IN_FLIGHT_SECONDS:
            protected.add(match['commit'][:12] if match else path.name)
    for path in stages:
        if not plain_dir(path) or not (STAGE.fullmatch(path.name) or IMPORT.fullmatch(path.name)):
            unmanaged.append(path)
        elif now - path.lstat().st_mtime >= IN_FLIGHT_SECONDS and path.name not in protected:
            remove.append(path)

    runs = []
    for path in listing(live / 'data/migrations'):
        match = RUN_DIR.fullmatch(path.name)
        if not match or not plain_dir(path):
            unmanaged.append(path)
            continue
        payload = [p for p in sorted(path.iterdir()) if SNAPSHOT_FILE.fullmatch(p.name) and plain_file(p)]
        if any(p.name in DATABASE for p in payload):
            runs.append((match['stamp'], path.name, payload))
    runs.sort(reverse=True)
    for _, _, payload in runs[:keep]:
        retained.extend(p for p in payload if p.name in DATABASE)
    for _, _, payload in runs[keep:]:
        remove.extend(payload)

    codes, scratch = [], []
    for path in listing(archive):
        if (match := CODE.fullmatch(path.name)) and plain_file(path):
            codes.append((match['stamp'], path.name, path))
        elif (match := SCRATCH.fullmatch(path.name)) and (plain_file(path) or plain_dir(path)):
            scratch.append((match['stamp'], path.name, path))
        else:
            unmanaged.append(path)
    for group in (codes, scratch):
        group.sort(reverse=True)
        remove.extend(path for _, _, path in group[keep:] if path.resolve() != rollback_code)

    tags = docker(['docker', 'image', 'ls', prefix, '--format', '{{.Tag}}']).split()
    images = sorted(prefix + ':' + tag for tag in set(tags) if STAGE.fullmatch(tag) and tag not in protected)
    remove = [{'path': str(p), 'bytes': size(p)} for p in remove]
    return {'current': current, 'rollback': rollback[0] if rollback else None, 'keep': keep,
            'live': str(live), 'stageRoot': str(stage_root), 'archive': str(archive),
            'retainedSnapshots': [str(p) for p in retained],
            'remove': remove, 'removeBytes': sum(entry['bytes'] for entry in remove), 'removeImages': images,
            'unmanaged': [{'path': str(p), 'bytes': size(p)} for p in unmanaged]}


def verify_snapshot(path):
    if path.name.endswith('.gz'):
        # Reading to EOF makes gzip check the stored CRC and length.
        with gzip.open(path, 'rb') as source:
            if source.read(16) != b'SQLite format 3\x00':
                raise ValueError('Retained snapshot is not a database: ' + str(path))
            while source.read(1 << 20):
                pass
        return
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
        if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('Retained snapshot failed integrity check: ' + str(path))


def apply(result, *, docker=docker_command):
    migrations = Path(result['live']) / 'data/migrations'
    roots = [Path(result['stageRoot']), migrations, Path(result['archive'])]
    # Every recovery point that stays must be readable before any older one goes.
    for path in result['retainedSnapshots']:
        verify_snapshot(Path(path))
    paths = [Path(entry['path']) for entry in result['remove']]
    for path in paths:
        # Planned roots were resolved; any symlink swapped in since then changes this.
        if (path.is_symlink() or path.parent.resolve() != path.parent
                or not (path.parent in roots or path.parent.parent == migrations)):
            raise ValueError('Release path changed during cleanup: ' + str(path))
    for path in paths:
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    result['retainedImages'] = []
    for image in result['removeImages']:
        try:
            docker(['docker', 'image', 'rm', image])
        except subprocess.CalledProcessError as error:
            # Never forced: an image used by any container stays.
            result['retainedImages'].append({'image': image, 'reason': (error.stderr or '').strip()[:300]})
    result['applied'] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', type=Path, required=True)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--keep', type=int, default=KEEP_SNAPSHOTS)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    result = plan(args.live, args.stage, args.archive, keep=args.keep)
    result['applied'] = False
    if args.apply:
        apply(result)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
