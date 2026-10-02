"""Immutable website bundles, independent of service and private data releases."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path
import re

FILES = ('board.css', 'board.js', 'index.html', 'manage/index.html')
MAX_FILE = 16 * 1024 * 1024
VERSION = re.compile(r'[a-f0-9]{32}')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def backend_fingerprint(service):
    """Conservative compatibility fence shared with the JS artifact builder.

    Any runtime/config/schema/shared-contract change requires a service release.
    Documentation, tests, deploy tooling and website-only edits do not.
    """
    service = Path(service)
    names = {'pyproject.toml', 'requirements-lock.txt'}
    for directory, suffixes in [('jobs_radar', {'.py', '.json'}),
                                ('config', {'.json'}), ('contracts', {'.js'})]:
        names.update(p.relative_to(service).as_posix() for p in (service / directory).glob('*')
                     if p.is_file() and p.suffix in suffixes)
    rows = [name + ':' + digest((service / name).read_bytes().replace(b'\r\n', b'\n'))
            for name in sorted(names)]
    return digest('\n'.join(rows).encode())


def read_manifest(folder):
    folder = Path(folder)
    raw = (folder / 'manifest.json').read_bytes()
    if len(raw) > 8192 or (folder / 'manifest.json').is_symlink():
        raise ValueError('Invalid website manifest')
    manifest = json.loads(raw)
    if (manifest.get('format') != 1 or not VERSION.fullmatch(manifest.get('id', ''))
            or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('sourceCommit', ''))
            or not re.fullmatch(r'[a-f0-9]{64}', manifest.get('backendFingerprint', ''))
            or set(manifest.get('files', {})) != set(FILES)):
        raise ValueError('Invalid website manifest')
    for name in FILES:
        target = folder / name
        if target.is_symlink() or target.resolve() != target.absolute():
            raise ValueError('Website file escaped its bundle')
        if not 0 < target.stat().st_size <= MAX_FILE or digest(target.read_bytes()) != manifest['files'][name]:
            raise ValueError('Website file hash differs: ' + name)
    root = (folder / 'index.html').read_text(encoding='utf-8')
    if root != (folder / 'manage/index.html').read_text(encoding='utf-8'):
        raise ValueError('Website and management entry must match')
    refs = re.findall(r'/assets/(board\.(?:css|js))\?v=([a-f0-9]+)', root)
    if sorted(refs) != [('board.css', manifest['id']), ('board.js', manifest['id'])]:
        raise ValueError('Website assets are not pinned to this bundle')
    return manifest


class WebBundles:
    def __init__(self, static, external=None, fingerprint=None):
        self.static = Path(static)
        self.external = Path(external) if external else None
        self.fingerprint = fingerprint or backend_fingerprint(Path(__file__).resolve().parents[1])

    def state(self):
        if not self.external:
            return {'current': None, 'previous': None}
        try:
            value = json.loads((self.external / 'state.json').read_text())
        except FileNotFoundError:
            return {'current': None, 'previous': None}
        if set(value) != {'current', 'previous'} or any(
                item is not None and (not isinstance(item, str) or not VERSION.fullmatch(item))
                for item in value.values()):
            raise ValueError('Invalid website release pointer')
        return value

    @lru_cache(maxsize=64)
    def bundle(self, version):
        if not self.external or not VERSION.fullmatch(version):
            raise ValueError('Unknown website version')
        folder = self.external / 'releases' / version
        if folder.resolve() != folder.absolute():
            raise ValueError('Website bundle must not contain directory links')
        manifest = read_manifest(folder)
        if manifest['id'] != version:
            raise ValueError('Website version mismatch')
        return folder, manifest

    def active(self):
        version = self.state()['current']
        if version:
            folder, manifest = self.bundle(version)
            if manifest['backendFingerprint'] == self.fingerprint:
                return folder, manifest
        # A full service upgrade/rollback always has its own compatible baseline.
        return self.static, None

    def status(self):
        _, manifest = self.active()
        return {'format': 1, 'independent': self.external is not None,
                'backendFingerprint': self.fingerprint,
                'active': manifest['id'] if manifest else None}

    def asset(self, name, version=None):
        if name not in {'board.js', 'board.css'}:
            raise ValueError('Unknown website asset')
        if version and VERSION.fullmatch(version):
            # An already-open page must still receive its exact old JS/CSS.
            return self.bundle(version)[0] / name, True
        if version:
            html = (self.static / 'index.html').read_text(encoding='utf-8')
            if f'/assets/{name}?v={version}' not in html:
                raise ValueError('Unknown bundled website version')
            return self.static / name, False
        return self.active()[0] / name, False
