"""Run the release fault rehearsal only against local WSL Docker Desktop.

Use release.sh --rehearse with a committed candidate artifact and two full local
image IDs. Native /tmp data retains real owner-only permissions. Each exact run
path is journaled in .qa/local-rehearsals before creating containers. Unresolved
cleanup/exports block another run; inspect those receipts, never delete them to
bypass the gate. Native evidence is retained even after a verified workspace
copy. No production paths, timers, remote connection or public port is used.
"""
import argparse
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import time
import uuid

from local_build import DesktopBuild, build_lock, committed_source, desktop_target, verify_artifact
from rehearse_docker import Rehearsal
from release_helpers import Containers, bounded


def filesystem_type(path):
    result = bounded(['findmnt', '-T', str(path), '-n', '-o', 'FSTYPE'], timeout=10)
    if result.returncode:
        raise ValueError('Cannot establish native staging filesystem')
    return result.stdout.strip()


def native_stage(parent=None):
    """The optional parent is a test seam, never a CLI/environment override."""
    parent = Path(parent) if parent is not None else Path('/tmp')
    if filesystem_type(parent) not in {'ext4', 'xfs', 'btrfs', 'tmpfs'}:
        raise ValueError('Rehearsal requires a native Linux filesystem, not DrvFS')
    folder = parent / ('jobs-radar-local-' + str(os.getuid()))
    for path in (folder, folder / 'jobs-radar-stage'):
        path.mkdir(mode=0o700, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Native staging ownership or permissions differ')
    if shutil.disk_usage(folder).free < 2 * 1024**3:
        raise ValueError('Insufficient native rehearsal disk space')
    return folder / 'jobs-radar-stage'


def check_runs(index):
    if any(index.glob('*.pending')): raise RuntimeError('Previous native rehearsal receipt remains unresolved')
    for path in index.glob('*.json'):
        if path.is_symlink() or path.stat().st_size > 16384:
            raise ValueError('Invalid local rehearsal receipt')
        value = json.loads(path.read_text())
        if value.get('status') != 'exported-clean':
            raise RuntimeError('Previous native rehearsal remains unresolved: ' + str(path))


def copy_evidence(source, destination, *, seconds=240):
    """Copy a quiescent, synthetic tree. Never follow/omit links or special files.

    This self-contained function also runs inside the budgeted export helper.
    All original native evidence is retained, including on a partial export.
    """
    import hashlib
    import json
    import os
    from pathlib import Path
    import stat
    import time
    source, destination = Path(source), Path(destination)
    deadline = time.monotonic() + seconds
    # Older Windows CRT fstat reports a different ctime from pathname stat.
    # Actual export runs on Linux, where ctime is also checked.
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns,
                            info.st_ctime_ns if os.name == 'posix' else None, info.st_nlink)
    def check():
        if time.monotonic() >= deadline: raise TimeoutError('Evidence export deadline exceeded')
    def inventory(root):
        entries, total, portable = [], 0, set()
        def walk(folder):
            nonlocal total
            check()
            info = folder.lstat()
            if not stat.S_ISDIR(info.st_mode): raise ValueError('Evidence directory is a link or special file')
            for path in sorted(folder.iterdir()):
                check()
                item = path.lstat()
                relative = path.relative_to(root).as_posix()
                if '\\' in relative or ':' in relative or any(part in {'.', '..', ''} or part.rstrip(' .') != part for part in relative.split('/')):
                    raise ValueError('Unsafe evidence path')
                if relative.casefold() in portable: raise ValueError('Evidence paths collide on the workspace filesystem')
                portable.add(relative.casefold())
                entry = dict(path=relative, mode=stat.S_IMODE(item.st_mode), uid=item.st_uid, gid=item.st_gid)
                if stat.S_ISDIR(item.st_mode):
                    entry['type'] = 'directory'; entries.append(entry); walk(path)
                elif stat.S_ISREG(item.st_mode) and item.st_nlink == 1:
                    total += item.st_size
                    if total > 2 * 1024**3: raise ValueError('Evidence byte budget exceeded')
                    digest = hashlib.sha256()
                    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                    with os.fdopen(descriptor, 'rb') as stream:
                        if identity(os.fstat(stream.fileno())) != identity(item): raise ValueError('Evidence changed before reading')
                        while chunk := stream.read(256 * 1024): check(); digest.update(chunk)
                        if identity(os.fstat(stream.fileno())) != identity(item): raise ValueError('Evidence changed while reading')
                    entry.update(type='file', size=item.st_size, sha256=digest.hexdigest()); entries.append(entry)
                else: raise ValueError('Evidence link or special file refused')
                if len(entries) > 50000: raise ValueError('Evidence entry budget exceeded')
        walk(root)
        return dict(files=sum(item['type'] == 'file' for item in entries), bytes=total, entries=entries)
    original = inventory(source)
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        raise ValueError('Evidence destination must be a new empty directory')
    for entry in original['entries']:
        check()
        path, target = source / entry['path'], destination / entry['path']
        if entry['type'] == 'directory': target.mkdir(mode=0o700); continue
        digest = hashlib.sha256()
        with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream, target.open('xb') as output:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError('Evidence changed')
            while chunk := stream.read(256 * 1024): check(); digest.update(chunk); output.write(chunk)
            output.flush(); os.fsync(output.fileno())
        if target.stat().st_size != entry['size'] or digest.hexdigest() != entry['sha256']:
            raise ValueError('Evidence changed during copy')
    if inventory(source) != original: raise ValueError('Source evidence changed during export')
    copied = inventory(destination)
    content = lambda items: [{k: v for k, v in item.items() if k not in {'uid', 'gid', 'mode'}} for item in items]
    if content(copied['entries']) != content(original['entries']): raise ValueError('Copied evidence differs')
    return original


def verify_export(destination, manifest, *, deadline=None):
    """Independently read every exported file; reject missing/extra entries."""
    root = Path(destination)
    deadline = deadline or time.monotonic() + 120
    def check():
        if time.monotonic() >= deadline: raise TimeoutError('Evidence verification deadline exceeded')
    if len(manifest['entries']) > 50000: raise ValueError('Evidence entry budget exceeded')
    expected = {}
    for item in manifest['entries']:
        check()
        name = item['path']
        if not isinstance(name, str) or '\\' in name or name.startswith('/') or any(part in {'', '.', '..'} or part.rstrip(' .') != part for part in name.split('/')) or ':' in name:
            raise ValueError('Unsafe export manifest path')
        if name in expected or item['type'] not in {'file', 'directory'}: raise ValueError('Invalid export manifest')
        expected[name] = item
    actual, total, files = set(), 0, 0
    def walk(folder):
        nonlocal total, files
        for path in folder.iterdir():
            check()
            name = path.relative_to(root).as_posix(); actual.add(name)
            item = expected.get(name); info = path.lstat()
            if item is None: raise ValueError('Export contents differ')
            if item['type'] == 'directory' and stat.S_ISDIR(info.st_mode): walk(path)
            elif item['type'] == 'file' and stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(256 * 1024), b''): check(); digest.update(chunk)
                if info.st_size != item['size'] or digest.hexdigest() != item['sha256']: raise ValueError('Export contents differ')
                files += 1; total += info.st_size
            else: raise ValueError('Export link/type differs')
    if root.is_symlink(): raise ValueError('Export root is a link')
    walk(root)
    if actual != set(expected) or (files, total) != (manifest['files'], manifest['bytes']): raise ValueError('Export contents differ')
    return manifest


def export_native(subject, destination, deadline):
    destination.mkdir(mode=0o700)
    (destination / 'payload').mkdir(mode=0o700)
    # Ledger is outside the copied tree, so the copy is quiescent even while
    # its own helper transitions from running to removed.
    def invoke(args, *, timeout=30):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Local rehearsal total deadline exceeded')
        if len(args) > 2 and args[1] == 'start':
            from rehearsal_command import inspect_budget
            inspect_budget(lambda command, timeout: bounded(command, timeout=min(timeout, remaining)), args[0], args[-1])
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('Local rehearsal total deadline exceeded')
        return bounded(args, timeout=min(timeout, remaining))
    containers = Containers(destination / 'containers', subject.namespace, subject.docker, invoke=invoke)
    code = inspect.getsource(copy_evidence) + '\nimport json,os\nfrom pathlib import Path\nresult=copy_evidence("/source","/output/payload")\nwith open("/output/manifest.json","x") as stream:\n json.dump(result,stream); stream.flush(); os.fsync(stream.fileno())\n'
    try:
        # The local entry verified this full ID before setup; it remains usable
        # for evidence export even if setup failed before release tags existed.
        containers.start(subject.namespace + ':evidence', ['-c', code], image_id=subject.candidate_image_id,
            mounts=[str(subject.root) + ':/source:ro', str(destination) + ':/output'], user='0:0', timeout=250, memory=512)
    finally:
        containers.cleanup()
    manifest_file = destination / 'manifest.json'
    if manifest_file.is_symlink() or manifest_file.stat().st_size > 32 * 1024**2: raise ValueError('Invalid evidence manifest')
    manifest = json.loads(manifest_file.read_text())
    verify_export(destination / 'payload', manifest, deadline=deadline)
    return dict(path=str(destination), files=manifest['files'], bytes=manifest['bytes'], manifestSha256=hashlib.sha256(manifest_file.read_bytes()).hexdigest())


def rehearse(artifact, old_image):
    deadline = time.monotonic() + 3600
    desktop_target()
    if not re.fullmatch('sha256:[a-f0-9]{64}', old_image):
        raise ValueError('Rehearsal requires the complete old local image ID')
    root, commit, short = committed_source()
    manifest = verify_artifact(artifact, root, commit, short)
    base = root / '.qa'
    if base.is_symlink(): raise ValueError('Workspace QA directory is a link')
    with build_lock(base / '.jobs-radar-local-tasks.lock'):
        for receipt in (base / 'releases').glob('*/builder.json'):
            plan = json.loads(receipt.read_text())
            if plan.get('creation') != 'not-issued' and not plan.get('removed'):
                raise RuntimeError('A local builder remains unresolved; rehearsal refused')
        index = base / 'local-rehearsals'
        if index.is_symlink(): raise ValueError('Rehearsal index is a link')
        index.mkdir(mode=0o700, exist_ok=True)
        check_runs(index)
        stage = native_stage()
        for receipt in (receipt for prior_stage in (base / 'jobs-radar-stage', stage)
                        for ledger in ('containers', 'service-containers')
                        for receipt in prior_stage.glob('rehearsal-*/' + ledger + '/*.json')):
            plan = json.loads(receipt.read_text())
            if not plan.get('removed') or not plan.get('id'):
                raise RuntimeError('Previous rehearsal cleanup is unresolved: ' + str(receipt))
        config = base / ('rehearsal-context-' + uuid.uuid4().hex)
        config.mkdir(mode=0o700)
        desktop = DesktopBuild(config)  # Validates/isolates CLI config; starts no builder.
        for image in (old_image, manifest['imageId']):
            value = json.loads(desktop.call(['image', 'inspect', image]))[0]
            if value['Id'] != image:
                raise ValueError('Required local rehearsal image is unavailable')
            if image == manifest['imageId']:
                labels = value['Config'].get('Labels', {})
                if labels.get('org.opencontainers.image.revision') != commit or labels.get('jobs.source.sha256') != manifest['sourceSha256']:
                    raise ValueError('Local candidate differs from the verified artifact')
        real_docker = shutil.which('docker')
        if not real_docker:
            raise ValueError('WSL Docker CLI is unavailable')
        binary = config / 'bin'
        binary.mkdir()
        wrapper = binary / 'docker'
        wrapper.write_text('#!/bin/sh\nexec ' + ' '.join(shlex.quote(value) for value in [real_docker, *desktop.cli[1:]]) + ' "$@"\n')
        wrapper.chmod(0o700)
        previous = dict(os.environ)
        subject = object.__new__(Rehearsal)
        result = None
        receipt = index / (uuid.uuid4().hex + '.json')
        state = dict(status='running', oldImageId=old_image, imageId=manifest['imageId'])
        def save():
            temporary = receipt.with_suffix('.pending')
            with temporary.open('w') as stream:
                json.dump(state, stream); stream.flush(); os.fsync(stream.fileno())
            temporary.replace(receipt)
            if os.name == 'posix':
                fd = os.open(index, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(fd)
                finally: os.close(fd)
        def register(root, namespace):
            state.update(root=str(root), namespace=namespace); save()
        try:
            os.environ.clear()
            os.environ.update(desktop.env)
            os.environ['PATH'] = str(binary) + os.pathsep + previous.get('PATH', '')
            subject.__init__(stage, old_image, manifest['imageId'], deadline=deadline - 360, register=register)
            result = subject.run()
            return result
        finally:
            try:
                if state.get('root'):
                    subject.finalize()
                    state['export'] = export_native(subject, index / receipt.stem, deadline)
                    state.update(status='exported-clean', outcome='passed' if result is not None else 'failed'); save()
                    if result is not None: result['evidence'] = state['export']
            finally:
                os.environ.clear()
                os.environ.update(previous)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--old-image', required=True)
    args = parser.parse_args()
    print(json.dumps(rehearse(args.artifact, args.old_image), indent=2))
