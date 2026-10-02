"""Installed server driver: complete static bundles only; never touch SQLite/Docker.

Called by release.sh's native Node client. The initial service release installs
this driver and the read-only website mount. All mutations share service locks.
"""
import argparse
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs_radar.web_bundles import FILES, MAX_FILE, VERSION, read_manifest

LIVE = Path('/home/ubuntu/siyi/jobs-radar')
ORIGIN = 'http://127.0.0.1:8796'
MAX_ARCHIVE = 40 * 1024 * 1024


def json_request(path):
    with urllib.request.urlopen(ORIGIN + path, timeout=10) as response:
        if response.status != 200:
            raise ValueError('Website verification failed')
        return json.load(response)


def status():
    try:
        value = json_request('/.well-known/jobs-web-release')
    except Exception as error:
        raise ValueError('Independent website publishing is unavailable; install it with a full service release first.') from error
    if value.get('format') != 1 or not value.get('independent'):
        raise ValueError('The running service has no independent website mount.')
    return value


@contextmanager
def release_lock(live):
    import fcntl
    with (live.parent / '.jobs-radar-release-host.lock').open('a') as host:
        fcntl.flock(host, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with (live / '.release.lock').open('a') as service:
            fcntl.flock(service, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield


def unpack(data, folder):
    if len(data) > MAX_ARCHIVE:
        raise ValueError('Website archive is too large')
    expected = {'manifest.json', *FILES}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != expected:
            raise ValueError('Unexpected website archive members')
        for member in members:
            if not member.isfile() or not 0 < member.size <= (8192 if member.name == 'manifest.json' else MAX_FILE):
                raise ValueError('Only bounded regular website files are allowed')
            target = folder / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
    return read_manifest(folder)


def read_state(root):
    path = root / 'state.json'
    if not path.exists():
        return {'current': None, 'previous': None}
    if path.is_symlink():
        raise ValueError('Website pointer must be a regular file')
    value = json.loads(path.read_text())
    if set(value) != {'current', 'previous'} or any(
            v is not None and (not isinstance(v, str) or not VERSION.fullmatch(v)) for v in value.values()):
        raise ValueError('Invalid website pointer')
    return value


def write_state(root, value):
    descriptor, name = tempfile.mkstemp(prefix='state-', suffix='.pending', dir=root)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        Path(name).chmod(0o644)
        os.replace(name, root / 'state.json')
        if os.name == 'posix':
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def verify_http(version, manifest):
    if status()['active'] != version:
        raise ValueError('Running service did not select the website version')
    paths = {'/': 'index.html', '/manage/': 'manage/index.html'}
    paths.update({'/assets/' + name + ('?v=' + version if version else ''): name
                  for name in ('board.js', 'board.css')})
    for route, name in paths.items():
        with urllib.request.urlopen(ORIGIN + route, timeout=10) as response:
            body = response.read(MAX_FILE + 1)
            if response.status != 200 or not body or len(body) > MAX_FILE:
                raise ValueError('Website route failed verification: ' + route)
            if manifest and hashlib.sha256(body).hexdigest() != manifest['files'][name]:
                raise ValueError('Served website differs from the artifact: ' + route)
    if not json_request('/healthz').get('ok'):
        raise ValueError('Backend is not healthy')


def switch(root, version, fingerprint, verify):
    before = read_state(root)
    manifest = read_manifest(root / 'releases' / version) if version else None
    if manifest and manifest['backendFingerprint'] != fingerprint:
        raise ValueError('Website is incompatible with the running backend; no switch occurred')
    if before['current'] == version:
        verify(version, manifest)
        return {'active': version, 'changed': False}
    # If the prior external bundle belongs to an older backend, rollback targets
    # this backend's bundled baseline, not an incompatible external website.
    previous = before['current']
    if previous and read_manifest(root / 'releases' / previous)['backendFingerprint'] != fingerprint:
        previous = None
    try:
        write_state(root, {'current': version, 'previous': previous})
        verify(version, manifest)
    except BaseException:
        write_state(root, before)
        previous_manifest = read_manifest(root / 'releases' / previous) if previous else None
        verify(previous, previous_manifest)
        raise
    return {'active': version, 'previous': previous, 'changed': True}


def activate(root, data, expected_hash, fingerprint, verify=verify_http):
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise ValueError('Uploaded website archive hash differs')
    if root.is_symlink() or root.resolve() != root.absolute():
        raise ValueError('Website storage must not use symlinks')
    releases = root / 'releases'
    releases.mkdir(parents=True, exist_ok=True, mode=0o755)
    if releases.resolve() != releases.absolute():
        raise ValueError('Website releases must not use symlinks')
    # The container serves as UID 10001, even when the SSH account uses umask 077.
    root.chmod(0o755)
    releases.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix='incoming-', dir=root) as temporary:
        folder = Path(temporary)
        manifest = unpack(data, folder)
        if manifest['backendFingerprint'] != fingerprint:
            raise ValueError('Website is incompatible with the running backend; no switch occurred')
        target = releases / manifest['id']
        if target.exists():
            if target.is_symlink() or read_manifest(target) != manifest:
                raise ValueError('An immutable website version already has different content')
        else:
            folder.chmod(0o755)
            (folder / 'manage').chmod(0o755)
            os.rename(folder, target)
        return switch(root, manifest['id'], fingerprint, verify)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'activate', 'rollback'))
    parser.add_argument('--sha256')
    args = parser.parse_args()
    if args.action == 'status':
        print(json.dumps(status()))
        return
    with release_lock(LIVE):
        current = status()
        root = LIVE / '.web'
        if args.action == 'activate':
            data = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
            result = activate(root, data, args.sha256, current['backendFingerprint'])
        else:
            state = read_state(root)
            if not (root / 'state.json').is_file():
                raise ValueError('No frontend release has been recorded')
            result = switch(root, state['previous'], current['backendFingerprint'], verify_http)
        print(json.dumps({**result, 'backendFingerprint': current['backendFingerprint']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
