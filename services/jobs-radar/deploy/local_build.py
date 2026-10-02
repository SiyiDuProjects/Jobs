"""Build committed source through WSL and this machine's Docker Desktop only."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import uuid

from release_helpers import bounded


MEMORY = 4 * 1024**3
SERVICE = 'services/jobs-radar'
REDIRECT = ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
            'DOCKER_CONFIG', 'BUILDX_BUILDER', 'BUILDKIT_HOST')


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix('.pending')
    with temporary.open('w', encoding='utf-8') as target:
        json.dump(value, target, indent=2)
        target.flush()
        os.fsync(target.fileno())
    temporary.replace(path)
    if os.name == 'posix':
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def command(args, *, env=None, timeout=180):
    result = bounded(args, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Local release command failed: ' + result.stderr.strip())
    return result.stdout.strip()


def committed_source():
    root = Path(command(['git', 'rev-parse', '--show-toplevel'])).resolve()
    if command(['git', '-C', str(root), 'status', '--porcelain', '--', SERVICE]):
        raise ValueError('Commit service changes before building')
    commit = command(['git', '-C', str(root), 'rev-parse', 'HEAD'])
    short = command(['git', '-C', str(root), 'rev-parse', '--short=12', commit])
    if not re.fullmatch('[a-f0-9]{40}', commit) or not commit.startswith(short):
        raise ValueError('Invalid committed source identity')
    return root, commit, short


def archive_source(root, commit, destination):
    # commit:subdirectory resolves to a tree, whose default archive timestamp
    # is "now". Pin the commit timestamp so later exact-byte verification is
    # reproducible without weakening source or image hash checks.
    timestamp = command(['git', '-C', str(root), 'show', '-s', '--format=%ct', commit])
    if not re.fullmatch(r'[0-9]+', timestamp):
        raise ValueError('Invalid committed source timestamp')
    command(['git', '-C', str(root), 'archive', '--format=tar', '--mtime=@' + timestamp,
             '--output=' + str(destination), commit + ':' + SERVICE])
    # Only code/public dependencies belong in a build. Fail even when a private
    # file was accidentally committed; .dockerignore alone is not sufficient.
    with tarfile.open(destination) as archive:
        for item in archive:
            parts = Path(item.name).parts
            lower = item.name.lower()
            lowered_parts = tuple(part.lower() for part in parts)
            basename = Path(lower).name
            if (not parts or item.name.startswith(('/', '\\')) or '..' in parts
                    or item.issym() or item.islnk() or not (item.isfile() or item.isdir())
                    or any(part in {'data', '.git', '.qa', 'source-materials', '.ssh', 'credentials', 'secrets'} for part in lowered_parts)
                    or basename == '.env' or basename.startswith('.env.')
                    or basename in {'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa', 'credentials.json'}
                    or any(value in lower for value in ('.sqlite', '.pem', '.p12', '.pfx'))):
                raise ValueError('Private or unsupported build archive member: ' + item.name)


def image_json(data):
    # Go's image import merges repeated map values; Python would keep only the
    # last. Reject duplicates rather than validate a different effective object.
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate image metadata field')
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError('Nonfinite image metadata value')
    return json.loads(data, object_pairs_hook=unique, parse_constant=invalid_constant)


def image_fields(value, fields):
    # encoding/json matches struct field names without case. Fields used by
    # our checks must have their canonical spelling, including optional ones.
    if not isinstance(value, dict):
        raise ValueError('Invalid image metadata object')
    names = {name.casefold(): name for name in fields}
    for key in value:
        canonical = names.get(key.casefold())
        if canonical is not None and key != canonical:
            raise ValueError('Noncanonical image metadata field')
    return value


def verify_image_archive(path, image_id, expected_labels):
    """Check the Docker load manifest/config without materializing image layers."""
    names, sizes, manifest, index = set(), {}, None, None
    with tarfile.open(path, mode='r|*') as archive:
        for item in archive:
            parts = PurePosixPath(item.name).parts
            canonical = PurePosixPath(item.name).as_posix()
            # containerd cleans tar paths before dispatching metadata. Reject
            # aliases so a second index/manifest cannot replace the checked one.
            valid_names = {canonical, canonical + '/'} if item.isdir() else {canonical}
            if (item.name.startswith('/') or '\\' in item.name or '..' in parts or item.name in names
                    or canonical == '.' or item.name not in valid_names or canonical in names
                    or not (item.isfile() or item.isdir())):
                raise ValueError('Unsafe or duplicate image archive member')
            names.add(canonical)
            sizes[item.name] = item.size
            if item.name in {'manifest.json', 'repositories', 'index.json'}:
                if not item.isfile() or item.size > 1024 * 1024:
                    raise ValueError('Invalid image archive metadata')
                value = image_json(archive.extractfile(item).read())
                if item.name == 'manifest.json':
                    manifest = value
                elif item.name == 'repositories' and value:
                    raise ValueError('Image archive contains mutable repository tags')
                elif item.name == 'index.json':
                    index = image_fields(value, ('schemaVersion', 'mediaType', 'manifests', 'annotations'))
                    if value.get('schemaVersion') != 2 or not isinstance(value.get('manifests'), list):
                        raise ValueError('Invalid OCI image index')
                    # Docker/containerd recognizes both annotation spellings.
                    # Even an archive with no RepoTags can otherwise retag live.
                    for entry in [value, *value.get('manifests', [])]:
                        image_fields(entry, ('mediaType', 'digest', 'size', 'urls', 'annotations', 'data', 'platform', 'artifactType'))
                        annotations = entry.get('annotations', {})
                        if any(name in annotations for name in (
                                'org.opencontainers.image.ref.name', 'io.containerd.image.name')):
                            raise ValueError('Image archive contains a mutable OCI reference')
    if not isinstance(manifest, list) or len(manifest) != 1:
        raise ValueError('Import requires one image with no repository tags')
    image_fields(manifest[0], ('Config', 'RepoTags', 'Layers', 'Parent', 'LayerSources'))
    if manifest[0].get('RepoTags') not in (None, []):
        raise ValueError('Import requires one image with no repository tags')
    config_name = manifest[0].get('Config')
    layers = manifest[0].get('Layers')
    if not isinstance(config_name, str) or config_name not in names or not isinstance(layers, list) or any(name not in names for name in layers):
        raise ValueError('Image manifest references missing content')
    if index is not None and (not isinstance(index.get('manifests'), list) or len(index['manifests']) != 1):
        raise ValueError('Import requires one OCI image descriptor')
    image_manifest_name = 'blobs/sha256/' + image_id.removeprefix('sha256:')
    contents = {}
    with tarfile.open(path, mode='r|*') as archive:
        for item in archive:
            if item.name not in {config_name, image_manifest_name}:
                continue
            if not item.isfile() or item.size > 1024 * 1024:
                raise ValueError('Invalid image configuration size')
            contents[item.name] = archive.extractfile(item).read()
    config = contents.get(config_name)
    if config is None:
        raise ValueError('Image archive has no matching configuration')
    config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
    config_value = image_fields(image_json(config), ('config',))
    labels = image_fields(config_value.get('config', {}), ('Labels',)).get('Labels', {})
    if any(labels.get(key) != value for key, value in expected_labels.items()):
        raise ValueError('Image archive labels differ from committed source')
    if config_digest == image_id and index is None:
        return {'format': 'docker-config', 'imageId': image_id, 'configDigest': config_digest}
    # The containerd image store identifies a single-platform image by its OCI
    # manifest, unlike the classic engine's configuration digest. Bind both
    # descriptors to the exact config and ordered layers before Docker sees it.
    descriptor = index['manifests'][0] if index is not None else {}
    raw_manifest = contents.get(image_manifest_name)
    allowed = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
    if (not raw_manifest or descriptor.get('digest') != image_id
            or descriptor.get('mediaType') not in allowed
            or descriptor.get('size') != len(raw_manifest)
            or 'sha256:' + hashlib.sha256(raw_manifest).hexdigest() != image_id):
        raise ValueError('Image archive configuration digest or OCI manifest differs from its image ID')
    image_manifest = image_fields(image_json(raw_manifest), ('schemaVersion', 'mediaType', 'config', 'layers', 'annotations', 'subject', 'artifactType'))
    if image_manifest.get('schemaVersion') != 2 or image_manifest.get('mediaType') not in allowed:
        raise ValueError('Unsupported OCI image manifest')
    config_descriptor = image_fields(image_manifest.get('config', {}), ('mediaType', 'digest', 'size', 'urls', 'annotations', 'data'))
    if (config_descriptor.get('digest') != config_digest or config_descriptor.get('size') != len(config)
            or config_name != 'blobs/sha256/' + config_digest[7:]):
        raise ValueError('OCI manifest does not bind the archived configuration')
    descriptors = image_manifest.get('layers')
    if not isinstance(descriptors, list) or len(descriptors) != len(layers):
        raise ValueError('OCI manifest does not bind the archived layers')
    for descriptor, name in zip(descriptors, layers):
        image_fields(descriptor, ('mediaType', 'digest', 'size', 'urls', 'annotations', 'data'))
        digest_value = descriptor.get('digest', '')
        if (not re.fullmatch('sha256:[a-f0-9]{64}', digest_value)
                or name != 'blobs/sha256/' + digest_value[7:]
                or descriptor.get('size') != sizes[name]):
            raise ValueError('OCI manifest does not bind the archived layers')
    return {'format': 'oci-manifest', 'imageId': image_id, 'configDigest': config_digest}


@contextmanager
def build_lock(path):
    """A local OS lock is released on crashes; no stale pid file is trusted."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0)
            if not lock.read(1):
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == 'nt':
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def desktop_target():
    if any(os.environ.get(name) for name in REDIRECT):
        raise ValueError('Docker builder redirection variables are not accepted')
    if os.name == 'nt':
        raise ValueError('Run release.sh --build inside WSL; native Windows process-tree cleanup is not verified')
    if sys.platform == 'linux' and 'microsoft' in Path('/proc/version').read_text().lower():
        return 'default', 'unix:///var/run/docker.sock'
    raise ValueError('Build requires the verified local WSL Docker Desktop environment')


class DesktopBuild:
    def __init__(self, folder, invoke=command):
        self.folder, self.invoke = Path(folder), invoke
        self.operation = uuid.uuid4().hex
        self.builder = 'jobs-radar-build-' + self.operation
        self.name = 'buildx_buildkit_' + self.builder + '0'
        self.receipt = self.folder / 'builder.json'
        self.plan = dict(operation=self.operation, builder=self.builder, name=self.name, creation='not-issued', removed=False)
        original_context, endpoint = desktop_target()
        original = ['docker', '--context', original_context]
        actual = json.loads(invoke([*original, 'context', 'inspect', original_context, '--format', '{{json .Endpoints.docker.Host}}']))
        if actual != endpoint:
            raise ValueError('Docker context is not the fixed local Desktop endpoint')
        info = json.loads(invoke([*original, 'info', '--format', '{{json .}}']))
        if info.get('Name') != 'docker-desktop' or info.get('OSType') != 'linux' or info.get('MemTotal', 0) < 8 * 1024**3:
            raise ValueError('Local Docker Desktop engine identity or capacity differs')
        # A private empty CLI config prevents registry credentials, proxies and
        # host buildx settings from being sent into the build session.
        config = self.folder / 'docker-config'
        config.mkdir(mode=0o700)
        self.context = 'jobs-radar-local-' + self.operation
        self.env = {key: value for key, value in os.environ.items()
                    if key not in REDIRECT and key != 'SSH_AUTH_SOCK' and not key.upper().endswith('_PROXY')}
        self.env['DOCKER_CONFIG'] = str(config)
        invoke(['docker', '--config', str(config), 'context', 'create', self.context, '--docker', 'host=' + endpoint], env=self.env)
        self.cli = ['docker', '--config', str(config), '--context', self.context]

    def call(self, args, timeout=180):
        return self.invoke([*self.cli, *args], env=self.env, timeout=timeout)

    def inspect(self):
        listed = self.call(['ps', '-a', '--filter', 'name=^/' + self.name + '$', '--format', '{{.ID}}'])
        if not listed:
            return None
        info = json.loads(self.call(['inspect', self.plan.get('id') or self.name]))[0]
        if (info['Name'] != '/' + self.name or 'JOBS_RELEASE_OPERATION=' + self.operation not in info['Config'].get('Env', [])
                or self.plan.get('id') and self.plan['id'] != info['Id']):
            raise ValueError('Local build container ownership changed')
        if not re.fullmatch('[a-f0-9]{64}', info['Id']):
            raise ValueError('Local build container has no full ID')
        volumes = [mount['Name'] for mount in info.get('Mounts', []) if mount.get('Type') == 'volume']
        if any(name != self.name + '_state' for name in volumes):
            raise ValueError('BuildKit cache escaped the unique task volume')
        self.plan.update(id=info['Id'], creation='known')
        self.plan['volumes'] = volumes
        write_json(self.receipt, self.plan)
        return info

    def cleanup(self):
        if self.plan['creation'] == 'not-issued':
            return
        info = self.inspect()
        if info is None and not self.plan.get('id'):
            raise RuntimeError('Local builder creation remains pending; retain its receipt for review')
        if info:
            self.call(['rm', '-f', info['Id']])
        # Never call buildx rm after deleting by ID: it resolves the name again
        # and could act on a replacement. Remove only cache volumes witnessed
        # on the verified container; Docker refuses volumes still in use.
        for volume in self.plan.get('volumes', []):
            self.call(['volume', 'rm', volume])
        self.plan['removed'] = True
        write_json(self.receipt, self.plan)

    def build(self, source, commit, short, source_hash):
        self.call(['buildx', 'create', '--name', self.builder, '--driver', 'docker-container',
            '--driver-opt', 'memory=4g,memory-swap=4g,cpu-period=100000,cpu-quota=200000,env.JOBS_RELEASE_OPERATION=' + self.operation,
            self.context])
        self.plan['creation'] = 'pending'
        write_json(self.receipt, self.plan)
        try:
            self.call(['buildx', 'inspect', '--bootstrap', self.builder], timeout=180)
            info = self.inspect()
            if not info:
                raise RuntimeError('BuildKit startup has no verified container')
            host = info['HostConfig']
            if (host.get('Memory') != MEMORY or host.get('MemorySwap') != MEMORY
                    or host.get('CpuPeriod') != 100000 or host.get('CpuQuota') != 200000):
                raise ValueError('BuildKit resource limits were not applied')
            image_file = self.folder / 'image.id'
            self.call(['buildx', 'build', '--builder', self.builder, '--platform', 'linux/amd64', '--load',
                '--iidfile', str(image_file), '--label', 'release=' + short,
                '--label', 'org.opencontainers.image.revision=' + commit,
                '--label', 'jobs.source.sha256=' + source_hash, str(source)], timeout=1800)
            image_id = image_file.read_text().strip()
            if not re.fullmatch('sha256:[a-f0-9]{64}', image_id):
                raise ValueError('Build did not produce a complete image ID')
            info = json.loads(self.call(['image', 'inspect', image_id]))[0]
            expected = {'release': short, 'org.opencontainers.image.revision': commit, 'jobs.source.sha256': source_hash}
            if info['Id'] != image_id or any(info['Config']['Labels'].get(key) != value for key, value in expected.items()):
                raise ValueError('Built image identity differs from the archived source')
            # Saving by ID omits mutable release tags from the transfer archive.
            self.call(['image', 'save', '--output', str(self.folder / 'image.tar'), image_id], timeout=300)
            verify_image_archive(self.folder / 'image.tar', image_id, expected)
            return image_id
        finally:
            self.cleanup()


def verify_artifact(folder, root, commit, short):
    folder = Path(folder).resolve(strict=True)
    manifest = json.loads((folder / 'manifest.json').read_text())
    if (manifest.get('version') != 1 or manifest.get('commit') != commit or manifest.get('release') != short
            or not re.fullmatch('sha256:[a-f0-9]{64}', manifest.get('imageId', ''))):
        raise ValueError('Artifact does not describe this committed source')
    for name, key in [('source.tar', 'sourceSha256'), ('image.tar', 'imageSha256')]:
        if (folder / name).is_symlink() or digest(folder / name) != manifest[key]:
            raise ValueError('Artifact hash mismatch: ' + name)
    verify_image_archive(folder / 'image.tar', manifest['imageId'], {'release': short,
        'org.opencontainers.image.revision': commit, 'jobs.source.sha256': manifest['sourceSha256']})
    with tempfile.TemporaryDirectory(dir=folder) as temporary:
        expected = Path(temporary) / 'source.tar'
        archive_source(root, commit, expected)
        if digest(expected) != manifest['sourceSha256']:
            raise ValueError('Artifact archive differs from the exact Git source')
    return manifest


def build():
    desktop_target()
    root, commit, short = committed_source()
    base = root / '.qa' / 'releases'
    with build_lock(base.parent / '.jobs-radar-local-tasks.lock'):
        for receipt in base.glob('*/builder.json'):
            previous = json.loads(receipt.read_text())
            if previous.get('creation') != 'not-issued' and not previous.get('removed'):
                raise RuntimeError('A previous local builder remains unresolved: ' + str(receipt))
        folder = base / (commit + '-' + uuid.uuid4().hex[:12])
        folder.mkdir(mode=0o700)
        source_archive = folder / 'source.tar'
        archive_source(root, commit, source_archive)
        source_hash = digest(source_archive)
        with tempfile.TemporaryDirectory(prefix='context-', dir=folder) as temporary:
            source = Path(temporary)
            with tarfile.open(source_archive) as archive:
                archive.extractall(source, filter='data')
            image_id = DesktopBuild(folder).build(source, commit, short, source_hash)
        write_json(folder / 'manifest.json', dict(version=1, commit=commit, release=short,
            imageId=image_id, sourceSha256=source_hash, imageSha256=digest(folder / 'image.tar'),
            builder='local-docker-desktop', cpuLimit=2, memoryBytes=MEMORY))
        return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('build', 'verify'))
    parser.add_argument('--artifact', type=Path)
    args = parser.parse_args()
    if args.mode == 'build':
        if args.artifact:
            parser.error('Build output is assigned under the workspace .qa directory')
        print(build())
    else:
        if not args.artifact:
            parser.error('Verification requires --artifact')
        root, commit, short = committed_source()
        print(verify_artifact(args.artifact, root, commit, short)['imageId'])


if __name__ == '__main__':
    main()
