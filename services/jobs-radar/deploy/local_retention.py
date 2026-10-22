"""Inventory local build/recovery artifacts without deleting or opening private evidence.

Current and previous builds, interrupted builders and recovery archives stay
protected. Other items require an explicit human retention decision; this tool
has no apply/delete mode. Server retention continues through release.sh --prune.
"""
import argparse
import json
from pathlib import Path
import subprocess


def measure(folder):
    size, files, links, unreadable = 0, 0, 0, 0
    pending = [Path(folder)]
    while pending:
        path = pending.pop()
        try:
            if path.is_symlink():
                links += 1
            elif path.is_dir():
                pending.extend(path.iterdir())
            else:
                size += path.stat().st_size
                files += 1
        except OSError:
            unreadable += 1
    return dict(bytes=size, files=files, linksSkipped=links, unreadable=unreadable)


def inventory(root, commit):
    root = Path(root).resolve()
    qa = root / '.qa'
    if not qa.exists():
        return {'dryRun': True, 'totalBytes': 0, 'items': []}
    if qa.is_symlink():
        raise ValueError('Local artifact inventory must not follow a .qa symlink')
    items = []
    for group in sorted(qa.iterdir()):
        if group.is_symlink():
            items.append({'path': group.relative_to(root).as_posix(), 'protected': True,
                          'reason': 'symlink; target was not read', **measure(group)})
            continue
        members = list(group.iterdir()) if group.is_dir() and group.name in {'releases', 'web-releases', 'worktree-archives'} else [group]
        members.sort(key=lambda p: p.lstat().st_mtime_ns, reverse=True)
        for index, path in enumerate(members):
            reason = 'evidence or recovery material; retain until its owner resolves the case'
            protected = True
            if group.name in {'releases', 'web-releases'} and path.is_dir() and not path.is_symlink():
                if commit and path.name.startswith(commit[:12]):
                    reason = 'current committed source'
                elif index < 2:
                    reason = 'newest or previous local artifact; retain rollback coverage'
                elif (path / 'builder.json').exists():
                    builder = path / 'builder.json'
                    try:
                        if builder.is_symlink() or builder.stat().st_size > 16384:
                            raise ValueError('unsafe builder receipt')
                        pending = json.loads(builder.read_text()).get('removed') is not True
                    except (OSError, ValueError):
                        pending = True
                    if pending:
                        reason = 'builder pending or ownership not verified'
                    else:
                        protected = False
                        reason = 'review candidate; confirm rollback and unresolved evidence references before any removal'
                else:
                    protected = False
                    reason = 'review candidate; absence of recovery references has not been established'
            if path.is_symlink():
                protected, reason = True, 'symlink; target was not read'
            items.append({'path': path.relative_to(root).as_posix(), 'protected': protected,
                          'reason': reason, **measure(path)})
    return {'dryRun': True, 'totalBytes': sum(item['bytes'] for item in items), 'items': items}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path)
    args = parser.parse_args()
    root = args.root or Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    print(json.dumps(inventory(root, commit), indent=2))
