"""Local rehearsal boundaries; no Docker daemon or production connection."""
import hashlib
import json
import os
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy'))
import local_rehearsal as local


def test_mac_rehearsal_stops_before_creating_artifacts(monkeypatch, tmp_path):
    monkeypatch.setattr(local, 'desktop_target', lambda: None)
    monkeypatch.setattr(local.sys, 'platform', 'darwin')
    with pytest.raises(ValueError, match='WSL native Linux'):
        local.rehearse(tmp_path / 'artifact', 'sha256:' + 'a' * 64)
    assert list(tmp_path.iterdir()) == []


def test_native_stage_refuses_drvfs_before_starting_containers(tmp_path, monkeypatch):
    monkeypatch.setattr(local, 'filesystem_type', lambda path: '9p')
    with pytest.raises(ValueError, match='native'):
        local.native_stage(tmp_path)


def test_tree_export_preserves_empty_dirs_bytes_and_manifest(tmp_path):
    source, destination = tmp_path / 'source', tmp_path / 'destination'
    (source / 'empty').mkdir(parents=True)
    (source / 'data').mkdir()
    (source / 'data/db.sqlite').write_bytes(b'synthetic\x00database')
    destination.mkdir()
    manifest = local.copy_evidence(source, destination, seconds=10)
    assert manifest['files'] == 1
    assert local.verify_export(destination, manifest) == manifest
    assert (destination / 'empty').is_dir()
    assert (destination / 'data/db.sqlite').read_bytes() == b'synthetic\x00database'
    (destination / 'extra').write_text('not in source')
    with pytest.raises(ValueError, match='contents'):
        local.verify_export(destination, manifest)


@pytest.mark.parametrize('kind', ['symlink', 'hardlink'])
def test_export_rejects_links_instead_of_following_or_omitting_them(tmp_path, kind):
    source, destination = tmp_path / 'source', tmp_path / 'destination'
    source.mkdir(); destination.mkdir()
    original = source / 'one'; original.write_text('synthetic')
    try:
        if kind == 'symlink': (source / 'two').symlink_to(original)
        else: os.link(original, source / 'two')
    except OSError: pytest.skip('Host cannot create links')
    with pytest.raises(ValueError, match='link'):
        local.copy_evidence(source, destination, seconds=10)


@pytest.mark.parametrize('name', ['../outside', '/absolute', 'a/../b', 'a\\b'])
def test_export_manifest_cannot_redirect_verification(tmp_path, name):
    with pytest.raises(ValueError):
        local.verify_export(tmp_path, {'files': 1, 'bytes': 0, 'entries': [dict(path=name, type='file', size=0, sha256=hashlib.sha256(b'').hexdigest())]})


def test_pending_native_run_cannot_be_bypassed_by_a_new_workspace_stage(tmp_path):
    index = tmp_path / 'runs'; index.mkdir()
    (index / 'one.json').write_text(json.dumps({'status': 'running', 'root': '/tmp/old-native-stage'}))
    with pytest.raises(RuntimeError, match='unresolved'):
        local.check_runs(index)


def test_export_deadline_keeps_source_and_does_not_claim_complete(tmp_path):
    source, destination = tmp_path / 'source', tmp_path / 'destination'
    source.mkdir(); destination.mkdir()
    (source / 'data').write_bytes(b'original')
    with pytest.raises(TimeoutError): local.copy_evidence(source, destination, seconds=-1)
    assert (source / 'data').read_bytes() == b'original'
    assert not (destination / 'evidence-manifest.json').exists()


@pytest.mark.parametrize('phase', ['constructor', 'run', 'cleanup', 'export'])
def test_failure_retains_native_path_and_restores_environment(tmp_path, monkeypatch, phase):
    import time
    candidate='sha256:'+'b'*64
    monkeypatch.setattr(local, 'desktop_target', lambda: None)
    monkeypatch.setattr(local.sys, 'platform', 'linux')
    monkeypatch.setattr(local, 'committed_source', lambda: (tmp_path,'d'*40,'d'*12))
    monkeypatch.setattr(local, 'verify_artifact', lambda *_: dict(imageId=candidate,sourceSha256='c'*64))
    stage=tmp_path/'native/jobs-radar-stage'; stage.mkdir(parents=True)
    monkeypatch.setattr(local,'native_stage',lambda:stage)
    original=dict(os.environ); calls=[]
    class Desktop:
        def __init__(self,path): self.cli=['docker','--context','synthetic']; self.env=original
        def call(self,args):
            return json.dumps([dict(Id=args[-1],Config=dict(Labels={'org.opencontainers.image.revision':'d'*40,'jobs.source.sha256':'c'*64}))])
    class Run:
        def __init__(self,stage,*args,deadline,register):
            self.root=stage/'rehearsal-123456789abcdef0'; self.root.mkdir()
            (self.root/'retained').write_text('synthetic original evidence')
            register(self.root,'jobs-radar-rehearsal-123456789abcdef0')
            if phase=='constructor': raise RuntimeError('constructor')
        def run(self):
            if phase=='run': raise RuntimeError('run')
            return {'passed':True}
        def finalize(self):
            calls.append('cleanup')
            if phase=='cleanup': raise RuntimeError('cleanup')
    def export(*args):
        calls.append('export')
        if phase=='export': raise RuntimeError('export')
        return {'verified':True}
    monkeypatch.setattr(local,'DesktopBuild',Desktop); monkeypatch.setattr(local,'Rehearsal',Run)
    monkeypatch.setattr(local,'export_native',export); monkeypatch.setattr(local.shutil,'which',lambda _: '/usr/bin/docker')
    with pytest.raises(RuntimeError,match=phase): local.rehearse(tmp_path/'artifact','sha256:'+'a'*64)
    assert dict(os.environ)==original
    receipt=json.loads(next((tmp_path/'.qa/local-rehearsals').glob('*.json')).read_text())
    assert (Path(receipt['root'])/'retained').read_text()=='synthetic original evidence'
    if phase in {'constructor','run'}:
        assert calls==['cleanup','export'] and receipt['status']=='exported-clean' and receipt['outcome']=='failed'
    else:
        assert receipt['status']=='running'
        with pytest.raises(RuntimeError): local.check_runs(tmp_path/'.qa/local-rehearsals')
