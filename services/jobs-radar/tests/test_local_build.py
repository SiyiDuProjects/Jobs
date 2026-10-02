import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

import pytest

from test_docker_rehearsal import module


def test_actual_git_archive_is_identical_across_wall_clock_seconds(tmp_path):
    local = module('local_build')
    root = tmp_path / 'synthetic-repository'; root.mkdir()
    source = root / local.SERVICE; source.mkdir(parents=True)
    (source / 'proof.txt').write_bytes(b'committed synthetic source\n')
    environment = dict(os.environ, GIT_AUTHOR_DATE='1600000000 +0000', GIT_COMMITTER_DATE='1600000000 +0000')
    def git(*args):
        result = subprocess.run(['git','-C',str(root),*args], capture_output=True, text=True,
                                timeout=20, check=True, env=environment)
        return result.stdout.strip()
    git('init'); git('config','core.autocrlf','false'); git('add','.')
    git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source')
    commit = git('rev-parse','HEAD')
    first, second = tmp_path/'first.tar', tmp_path/'second.tar'
    local.archive_source(root, commit, first)
    boundary = int(time.time())
    time.sleep(1.1)  # This regression requires a real, not mocked, second boundary.
    assert int(time.time()) > boundary
    local.archive_source(root, commit, second)
    assert first.read_bytes() == second.read_bytes()
    with tarfile.open(first) as archive:
        assert {entry.mtime for entry in archive} == {1600000000}
        assert archive.extractfile('proof.txt').read() == b'committed synthetic source\n'


class Desktop:
    def __init__(self, fault=None):
        self.calls, self.container, self.pending, self.fault = [], None, None, fault
        self.image_id = 'sha256:' + 'd' * 64

    def __call__(self, args, **options):
        self.calls.append((args, options))
        if 'context' in args and 'inspect' in args:
            return json.dumps('unix:///var/run/docker.sock')
        if 'info' in args:
            return json.dumps(dict(Name='docker-desktop', OSType='linux', MemTotal=24 * 1024**3))
        if 'context' in args:
            name = args[args.index('create') + 1]
            assert name.startswith('jobs-radar-local-') and name != 'default'
            config = Path(options['env']['DOCKER_CONFIG']) / 'config.json'
            if config.exists():
                assert 'auths' not in config.read_text()
            return ''
        if 'buildx' in args:
            command = args[args.index('buildx') + 1]
            if command == 'create':
                self.name = 'buildx_buildkit_' + args[args.index('--name') + 1] + '0'
                driver = args[args.index('--driver-opt') + 1]
                self.operation = driver.split('env.JOBS_RELEASE_OPERATION=')[1]
            elif command == 'inspect':
                value = dict(Name='/' + self.name, Id='a' * 64,
                    Config={'Env': ['JOBS_RELEASE_OPERATION=' + self.operation]},
                    HostConfig=dict(Memory=4 * 1024**3, MemorySwap=4 * 1024**3, CpuPeriod=100000, CpuQuota=200000))
                if self.fault == 'late':
                    self.pending = value
                    raise subprocess.TimeoutExpired(args, options['timeout'])
                self.container = value
                if self.fault == 'budget':
                    self.container['HostConfig']['Memory'] = 0
            elif command == 'build':
                self.labels = dict(args[index + 1].split('=', 1) for index, value in enumerate(args) if value == '--label')
                self.image_id, self.archive = image_bytes(self.labels)
                Path(args[args.index('--iidfile') + 1]).write_text(self.image_id)
                assert '--secret' not in args and '--ssh' not in args
            return ''
        if 'ps' in args:
            return 'a' * 64 if self.container else ''
        if 'image' in args and 'inspect' in args:
            return json.dumps([dict(Id=self.image_id, Config={'Labels': self.labels})])
        if 'image' in args and 'save' in args:
            assert args[-1] == self.image_id
            Path(args[args.index('--output') + 1]).write_bytes(self.archive)
            return ''
        if 'inspect' in args:
            return json.dumps([self.container])
        if 'rm' in args:
            assert args[-1] == 'a' * 64
            self.container = None
            return ''
        raise AssertionError(args)


def builder(tmp_path, monkeypatch, fault=None):
    local = module('local_build')
    monkeypatch.setattr(local, 'desktop_target', lambda: ('default', 'unix:///var/run/docker.sock'))
    engine = Desktop(fault)
    return local, engine, local.DesktopBuild(tmp_path, invoke=engine)


def test_private_context_bounded_builder_pins_code_and_exports_only_immutable_image(tmp_path, monkeypatch):
    monkeypatch.setenv('SSH_AUTH_SOCK', 'must-not-forward')
    local, engine, build = builder(tmp_path, monkeypatch)
    result = build.build(tmp_path, 'b' * 40, 'b' * 12, 'c' * 64)
    assert result == engine.image_id and engine.container is None
    receipt = json.loads((tmp_path / 'builder.json').read_text())
    assert receipt['removed'] and receipt['id'] == 'a' * 64
    assert all('ssh' != arg for args, _ in engine.calls for arg in args)
    assert all(options.get('env', {}).get('DOCKER_CONFIG') == str(tmp_path / 'docker-config')
               for args, options in engine.calls if '--config' in args)
    assert 'SSH_AUTH_SOCK' not in build.env
    assert engine.labels['org.opencontainers.image.revision'] == 'b' * 40
    assert engine.labels['jobs.source.sha256'] == 'c' * 64


def test_unapplied_resource_budget_stops_before_build_and_still_removes_owned_container(tmp_path, monkeypatch):
    local, engine, build = builder(tmp_path, monkeypatch, 'budget')
    with pytest.raises(ValueError, match='resource limits'):
        build.build(tmp_path, 'b' * 40, 'b' * 12, 'c' * 64)
    assert engine.container is None
    assert not any(args[args.index('buildx') + 1] == 'build' for args, _ in engine.calls if 'buildx' in args)


def test_second_build_refuses_a_first_create_that_only_appears_after_timeout(tmp_path, monkeypatch):
    local = module('local_build')
    folder = tmp_path / '.qa/releases/first'
    folder.mkdir(parents=True)
    monkeypatch.setattr(local, 'desktop_target', lambda: ('default', 'unix:///var/run/docker.sock'))
    engine = Desktop('late')
    first = local.DesktopBuild(folder, invoke=engine)
    with pytest.raises(RuntimeError, match='creation remains pending'):
        first.build(folder, 'b' * 40, 'b' * 12, 'c' * 64)
    assert json.loads(first.receipt.read_text())['creation'] == 'pending'
    engine.container = engine.pending
    before = len(engine.calls)
    monkeypatch.setattr(local, 'committed_source', lambda: (tmp_path, 'b' * 40, 'b' * 12))
    with pytest.raises(RuntimeError, match='previous local builder remains unresolved'):
        local.build()
    assert len(engine.calls) == before and engine.container is not None
    # Explicit bounded cleanup can later identify the same late container.
    first.cleanup()
    assert engine.container is None and json.loads(first.receipt.read_text())['removed']


@pytest.mark.parametrize('key', ['DOCKER_HOST', 'DOCKER_CONTEXT', 'BUILDX_BUILDER', 'BUILDKIT_HOST'])
def test_builder_redirection_cannot_select_a_remote_host(monkeypatch, key):
    local = module('local_build')
    monkeypatch.setenv(key, 'remote-builder')
    with pytest.raises(ValueError, match='redirection'):
        local.desktop_target()


def tar_bytes(name='Dockerfile', data=b'FROM scratch'):
    destination = io.BytesIO()
    with tarfile.open(fileobj=destination, mode='w') as archive:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    return destination.getvalue()


def image_bytes(labels, tags=None, extra_image=False, unsafe=False):
    config = json.dumps({'config': {'Labels': labels}}).encode()
    image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
    config_name = image_id[7:] + '.json'
    manifest = [dict(Config=config_name, RepoTags=tags, Layers=[])]
    if extra_image:
        manifest.append(manifest[0])
    files = [(config_name, config), ('manifest.json', json.dumps(manifest).encode())]
    if unsafe:
        files.append(('../outside', b'bad'))
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w') as archive:
        for name, value in files:
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
    return image_id, result.getvalue()


def oci_image_bytes(labels, fault=None):
    """Docker 29 containerd save: ID is the OCI manifest, not its config."""
    config = json.dumps({'architecture': 'amd64', 'os': 'linux', 'config': {'Labels': labels}}).encode()
    config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
    layer = b'synthetic layer content'
    layer_digest = 'sha256:' + hashlib.sha256(layer).hexdigest()
    image = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
             'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'size': len(config), 'digest': config_digest},
             'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar', 'size': len(layer), 'digest': layer_digest}]}
    if fault == 'config-reference':
        image['config']['digest'] = 'sha256:' + 'e' * 64
    if fault == 'layer-reference':
        image['layers'][0]['digest'] = 'sha256:' + 'e' * 64
    raw = json.dumps(image).encode()
    image_id = 'sha256:' + hashlib.sha256(raw).hexdigest()
    descriptor = {'mediaType': image['mediaType'], 'digest': image_id, 'size': len(raw)}
    if fault == 'index-reference':
        descriptor['digest'] = 'sha256:' + 'e' * 64
    if fault == 'tag':
        descriptor['annotations'] = {'org.opencontainers.image.ref.name': 'jobs-radar:0.1.0'}
    config_name, layer_name = ['blobs/sha256/' + value[7:] for value in (config_digest, layer_digest)]
    index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
             'manifests': [descriptor] * (2 if fault == 'second-image' else 1)}
    files = [(config_name, config + (b' ' if fault == 'config-bytes' else b'')), (layer_name, layer),
             ('blobs/sha256/' + image_id[7:], raw + (b' ' if fault == 'manifest-bytes' else b'')),
             ('index.json', json.dumps(index).encode()), ('oci-layout', b'{"imageLayoutVersion":"1.0.0"}'),
             ('manifest.json', json.dumps([{'Config': config_name, 'RepoTags': None, 'Layers': [layer_name]}]).encode())]
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w') as archive:
        for name, value in files:
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
    return image_id, result.getvalue()


@pytest.mark.parametrize('fault', [None, 'index-reference', 'config-reference', 'layer-reference',
    'manifest-bytes', 'config-bytes', 'second-image', 'tag'])
def test_containerd_archive_binds_manifest_id_to_one_config_and_ordered_layers(tmp_path, fault):
    local = module('local_build')
    labels = {'release': 'b' * 12, 'org.opencontainers.image.revision': 'b' * 40, 'jobs.source.sha256': 'c' * 64}
    image_id, contents = oci_image_bytes(labels, fault)
    image = tmp_path / 'oci-image.tar'
    image.write_bytes(contents)
    if fault:
        with pytest.raises(ValueError):
            local.verify_image_archive(image, image_id, labels)
    else:
        identity = local.verify_image_archive(image, image_id, labels)
        assert identity['format'] == 'oci-manifest'
        assert identity['imageId'] != identity['configDigest']


@pytest.mark.parametrize('name', ['data/profile.json', 'DATA/profile.json', 'Source-Materials/facts.md',
    '.env', '.env.production', '.ENV.local', 'backup.sqlite', '../outside', 'key.pem', '.SSH/id_rsa', 'Credentials.json'])
def test_even_committed_private_files_cannot_enter_build_context(tmp_path, monkeypatch, name):
    local = module('local_build')
    def fake_archive(args, **kwargs):
        if 'show' in args: return '1600000000'
        Path(next(arg.split('=', 1)[1] for arg in args if arg.startswith('--output='))).write_bytes(tar_bytes(name))
        return ''
    monkeypatch.setattr(local, 'command', fake_archive)
    with pytest.raises(ValueError, match='Private or unsupported'):
        local.archive_source(tmp_path, 'b' * 40, tmp_path / 'source.tar')


@pytest.mark.parametrize('location', ['index', 'descriptor'])
@pytest.mark.parametrize('annotation', ['io.containerd.image.name', 'org.opencontainers.image.ref.name'])
def test_oci_import_rejects_both_image_name_annotations(tmp_path, location, annotation):
    local = module('local_build')
    image_id, contents = oci_image_bytes({})
    output = tmp_path / 'tagged.tar'
    with tarfile.open(fileobj=io.BytesIO(contents)) as source, tarfile.open(output, 'w') as target:
        for member in source:
            data = source.extractfile(member).read()
            if member.name == 'index.json':
                value = json.loads(data)
                reference = value if location == 'index' else value['manifests'][0]
                reference['annotations'] = {annotation: 'docker.io/library/jobs-radar:0.1.0'}
                data = json.dumps(value).encode()
                member.size = len(data)
            target.addfile(member, io.BytesIO(data))
    with pytest.raises(ValueError, match='mutable OCI reference'):
        local.verify_image_archive(output, image_id, {})


@pytest.mark.parametrize('alias', ['./index.json', 'index.json/', 'a/../index.json',
    './manifest.json', 'blobs//sha256/extra', './repositories'])
def test_oci_import_rejects_path_aliases_before_containerd_normalizes_them(tmp_path, alias):
    local = module('local_build')
    image_id, contents = oci_image_bytes({})
    output = tmp_path / 'alias.tar'
    output.write_bytes(contents)
    with tarfile.open(output, 'a') as archive:
        data = b'{"schemaVersion":2,"manifests":[],"annotations":{"io.containerd.image.name":"jobs-radar:0.1.0"}}'
        member = tarfile.TarInfo(alias)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    with pytest.raises(ValueError, match='Unsafe or duplicate'):
        local.verify_image_archive(output, image_id, {})


@pytest.mark.parametrize('fault', ['uppercase-annotations', 'uppercase-manifests',
    'lowercase-repotags', 'duplicate-annotations'])
def test_image_metadata_rejects_python_go_json_parser_differences(tmp_path, fault):
    local = module('local_build')
    image_id, contents = image_bytes({}) if fault == 'lowercase-repotags' else oci_image_bytes({})
    output = tmp_path / 'parser-difference.tar'
    with tarfile.open(fileobj=io.BytesIO(contents)) as source, tarfile.open(output, 'w') as target:
        for member in source:
            data = source.extractfile(member).read()
            if member.name == 'manifest.json' and fault == 'lowercase-repotags':
                value = json.loads(data)
                value[0]['repotags'] = ['jobs-radar:0.1.0']
                data = json.dumps(value).encode()
            if member.name == 'index.json':
                value = json.loads(data)
                if fault == 'uppercase-annotations':
                    value['manifests'][0]['Annotations'] = {'io.containerd.image.name': 'jobs-radar:0.1.0'}
                elif fault == 'uppercase-manifests':
                    value['Manifests'] = value['manifests'] * 2
                data = json.dumps(value).encode()
                if fault == 'duplicate-annotations':
                    data = data[:-1] + b',"annotations":{"io.containerd.image.name":"jobs-radar:0.1.0"},"annotations":{}}'
            member.size = len(data)
            target.addfile(member, io.BytesIO(data))
    with pytest.raises(ValueError):
        local.verify_image_archive(output, image_id, {})


def artifact(tmp_path, local):
    folder = tmp_path / ('jobs-radar-stage/import-' + 'b' * 40 + '-' + 'a' * 12)
    folder.mkdir(parents=True)
    (tmp_path / 'jobs-radar').mkdir()
    (folder / 'source.tar').write_bytes(tar_bytes())
    labels = {'release': 'b' * 12, 'org.opencontainers.image.revision': 'b' * 40, 'jobs.source.sha256': local.digest(folder / 'source.tar')}
    image_id, image = image_bytes(labels)
    (folder / 'image.tar').write_bytes(image)
    manifest = dict(version=1, commit='b' * 40, release='b' * 12, imageId=image_id,
        sourceSha256=local.digest(folder / 'source.tar'), imageSha256=local.digest(folder / 'image.tar'))
    (folder / 'manifest.json').write_text(json.dumps(manifest))
    return folder, manifest


@pytest.mark.parametrize('failure', [None, 'source', 'image', 'git'])
def test_artifact_verification_compares_bytes_with_the_exact_committed_archive(tmp_path, monkeypatch, failure):
    local = module('local_build')
    folder, manifest = artifact(tmp_path, local)
    def archive(root, commit, destination):
        assert root == tmp_path and commit == manifest['commit']
        destination.write_bytes(tar_bytes(data=b'different Git source') if failure == 'git' else tar_bytes())
    monkeypatch.setattr(local, 'archive_source', archive)
    if failure in {'source', 'image'}:
        (folder / (failure + '.tar')).write_bytes(b'changed transfer')
    if failure:
        with pytest.raises(ValueError, match='hash mismatch|exact Git source'):
            local.verify_artifact(folder, tmp_path, manifest['commit'], manifest['release'])
    else:
        assert local.verify_artifact(folder, tmp_path, manifest['commit'], manifest['release']) == manifest


@pytest.mark.parametrize('failure', [None, 'hash', 'identity', 'existing', 'lock'])
def test_import_never_builds_or_starts_and_verifies_both_locks_and_image_identity(tmp_path, monkeypatch, failure):
    imported, local = module('import_image'), module('local_build')
    folder, manifest = artifact(tmp_path, local)
    calls = []
    def invoke(args, **kwargs):
        calls.append((args, kwargs))
        if args[1:3] == ['image', 'ls']:
            return 'sha256:' + 'f' * 64 if failure == 'existing' else ''
        if args[1:3] == ['image', 'inspect']:
            current = args[-1] == 'jobs-radar:0.1.0'
            labels = {'release': 'a' * 12} if current else {'release': manifest['release'],
                'org.opencontainers.image.revision': manifest['commit'], 'jobs.source.sha256': manifest['sourceSha256']}
            if not current and failure == 'identity':
                labels['org.opencontainers.image.revision'] = 'e' * 40
            return json.dumps([dict(Id='sha256:' + 'a' * 64 if current else manifest['imageId'], Config={'Labels': labels})])
        return ''
    if failure == 'hash':
        (folder / 'image.tar').write_bytes(b'changed')
    if failure == 'lock':
        with local.build_lock(tmp_path / '.jobs-radar-release-host.lock'):
            with pytest.raises(OSError):
                imported.import_artifact(folder, manifest['commit'], root=tmp_path, invoke=invoke)
    elif failure:
        with pytest.raises(ValueError):
            imported.import_artifact(folder, manifest['commit'], root=tmp_path, invoke=invoke)
    else:
        assert imported.import_artifact(folder, manifest['commit'], root=tmp_path, invoke=invoke) == manifest['imageId']
    assert not any('build' in args or 'run' in args or 'create' in args for args, _ in calls)
    if failure:
        assert not any(args[1] == 'tag' for args, _ in calls)
    if failure in {'hash', 'lock'}:
        assert calls == []
    assert all(kwargs.get('timeout', 180) <= 180 for _, kwargs in calls)


@pytest.mark.parametrize('bad', ['tag', 'multiple', 'path', 'config_digest', 'labels'])
def test_unsafe_or_retagging_archive_is_rejected_before_docker_load(tmp_path, bad):
    imported, local = module('import_image'), module('local_build')
    folder, manifest = artifact(tmp_path, local)
    labels = {'release': manifest['release'], 'org.opencontainers.image.revision': manifest['commit'], 'jobs.source.sha256': manifest['sourceSha256']}
    if bad == 'labels':
        labels['jobs.source.sha256'] = 'e' * 64
    image_id, image = image_bytes(labels, ['jobs-radar:0.1.0'] if bad == 'tag' else None, bad == 'multiple', bad == 'path')
    (folder / 'image.tar').write_bytes(image)
    manifest.update(imageId='sha256:' + 'e' * 64 if bad == 'config_digest' else image_id,
        imageSha256=local.digest(folder / 'image.tar'))
    (folder / 'manifest.json').write_text(json.dumps(manifest))
    calls = []
    with pytest.raises(ValueError):
        imported.import_artifact(folder, manifest['commit'], root=tmp_path, invoke=lambda *args, **kwargs: calls.append(args))
    assert calls == []


@pytest.mark.parametrize('failure', [None, 'candidate', 'builder', 'rehearsal', 'rehearsal-service'])
def test_local_rehearsal_requires_verified_local_images_and_no_unresolved_prior_work(tmp_path, monkeypatch, failure):
    rehearsal = module('local_rehearsal')
    manifest = dict(imageId='sha256:' + 'b' * 64, sourceSha256='c' * 64)
    monkeypatch.setattr(rehearsal, 'desktop_target', lambda: ('default', 'unix:///var/run/docker.sock'))
    monkeypatch.setattr(rehearsal, 'committed_source', lambda: (tmp_path, 'd' * 40, 'd' * 12))
    monkeypatch.setattr(rehearsal, 'verify_artifact', lambda *_: manifest)
    stage = tmp_path / 'native/jobs-radar-stage'
    stage.mkdir(parents=True)
    monkeypatch.setattr(rehearsal, 'native_stage', lambda: stage)
    monkeypatch.setattr(rehearsal, 'export_native', lambda *_: {'verified': True})
    calls = []
    previous = dict(os.environ)
    class DesktopContext:
        def __init__(self, folder):
            calls.append('context')
            self.cli = ['docker', '--config', str(folder / 'empty-config'), '--context', 'private-context']
            self.env = {key: value for key, value in previous.items() if key != 'SSH_AUTH_SOCK'}
        def call(self, args):
            calls.append(args)
            return json.dumps([dict(Id=args[-1], Config={'Labels': {'org.opencontainers.image.revision': 'wrong' if failure == 'candidate' else 'd' * 40,
                'jobs.source.sha256': 'c' * 64}})])
    class IsolatedRehearsal:
        def __init__(self, stage, old, candidate, *, deadline, register):
            assert stage == tmp_path / 'native/jobs-radar-stage'
            assert old == 'sha256:' + 'a' * 64 and candidate == manifest['imageId']
            wrapper = Path(os.environ['PATH'].split(os.pathsep)[0]) / 'docker'
            assert '--context private-context' in wrapper.read_text() and '--config' in wrapper.read_text()
            assert 'SSH_AUTH_SOCK' not in os.environ
            calls.append('rehearsal')
            register(stage / 'rehearsal-123456789abc1234', 'isolated')
        def run(self):
            return {'syntheticDataOnly': True}
        def finalize(self): pass
    monkeypatch.setattr(rehearsal, 'DesktopBuild', DesktopContext)
    monkeypatch.setattr(rehearsal, 'Rehearsal', IsolatedRehearsal)
    monkeypatch.setattr(rehearsal.shutil, 'which', lambda _: '/usr/bin/docker')
    if failure in {'builder', 'rehearsal', 'rehearsal-service'}:
        relative = ('releases/old/builder.json' if failure == 'builder' else
                    'jobs-radar-stage/rehearsal-123456789abc/' + ('service-containers' if failure == 'rehearsal-service' else 'containers') + '/old.json')
        receipt = tmp_path / '.qa' / relative
        receipt.parent.mkdir(parents=True)
        receipt.write_text(json.dumps(dict(creation='pending', removed=False)))
    if failure:
        with pytest.raises((RuntimeError, ValueError)):
            rehearsal.rehearse(tmp_path / 'artifact', 'sha256:' + 'a' * 64)
        assert 'rehearsal' not in calls
        if failure != 'candidate':
            assert calls == []
    else:
        assert rehearsal.rehearse(tmp_path / 'artifact', 'sha256:' + 'a' * 64) == {'syntheticDataOnly': True, 'evidence': {'verified': True}}
    assert dict(os.environ) == previous
