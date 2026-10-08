"""Read-only recovery file inventory. This program never removes/compresses files.

References are reported conservatively, including historical rollback manifests.
An unreferenced file is not an assertion that deleting it is safe.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path


def inventory(live, archive):
    live, archive = Path(live).resolve(strict=True), Path(archive).resolve(strict=True)
    roots = [live / 'data/backups', live / 'data/migrations', archive]
    paths = []
    for root in roots:
        if root.exists():
            paths.extend(p for p in root.rglob('*') if p.is_file() and not p.is_symlink())
    manifests = [live / '.rollback-target', *archive.glob('rollback-target-*')]
    references = {}
    for manifest in manifests:
        if not manifest.is_file() or manifest.is_symlink():
            continue
        for line in manifest.read_text().splitlines():
            if line.startswith('/'):
                references.setdefault(line, []).append(str(manifest))
    rows = []
    for path in sorted(set(paths)):
        if not (path.name.endswith(('.sqlite', '.sqlite.gz', '.tgz')) or path.name.startswith('rollback-target-')):
            continue
        stat = path.stat()
        # Migration directories contain the before/after release reports and
        # backup together; keep those associations visible in the inventory.
        companions = sorted(str(p) for p in path.parent.glob('*.json') if p.is_file() and not p.is_symlink()) if path.name == 'pre-change.sqlite' else []
        rows.append({'path': str(path), 'bytes': stat.st_size,
                     'modifiedUtc': datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                     'references': references.get(str(path), []), 'releaseReports': companions,
                     'group': 'migration' if live / 'data/migrations' in path.parents else 'scheduled' if live / 'data/backups' in path.parents else 'archive'})
    return {'currentRelease': (live / 'RELEASE').read_text().strip(),
            'maintenancePresent': (live / 'data/.release-maintenance').exists(),
            'files': rows, 'totalBytes': sum(row['bytes'] for row in rows),
            'missingReferences': [path for path in references if not Path(path).is_file()],
            'note': 'Metadata only; integrity not verified. No recovery point modified.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('live', type=Path)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(inventory(args.live, args.archive), indent=2, sort_keys=True))
