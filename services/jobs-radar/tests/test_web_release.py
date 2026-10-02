"""Behavior coverage for independent website delivery and failure recovery."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile

import pytest
from starlette.testclient import TestClient
from jobs_radar.web_bundles import WebBundles, backend_fingerprint, read_manifest
from jobs_radar.server import create_server
from jobs_radar.store import Store

SERVICE = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('website_driver', SERVICE / 'deploy/web_release.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def bundle(folder, version='a' * 32, fingerprint='f' * 64, script='first version'):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'manage').mkdir(exist_ok=True)
    html = f'<html><script src="/assets/board.js?v={version}"></script><link href="/assets/board.css?v={version}"></html>'
    contents = {'board.js': script, 'board.css': 'body{color:blue}',
                'index.html': html, 'manage/index.html': html}
    manifest = {'format': 1, 'id': version, 'sourceCommit': 'c' * 40,
                'backendFingerprint': fingerprint, 'files': {}}
    for name, text in contents.items():
        data = text.encode()
        (folder / name).write_bytes(data)
        manifest['files'][name] = hashlib.sha256(data).hexdigest()
    (folder / 'manifest.json').write_text(json.dumps(manifest))
    return manifest


def archive(folder, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name in ['manifest.json', *driver.FILES]:
            tar.add(folder / name, arcname=name)
        if extra:
            member = tarfile.TarInfo(extra)
            member.size = 1
            tar.addfile(member, io.BytesIO(b'x'))
    data = output.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def publish(root, folder, fingerprint='f' * 64, verify=lambda *_: None):
    return driver.activate(root, *archive(folder), fingerprint, verify)


def test_switch_rollback_and_old_assets_leave_database_untouched(tmp_path):
    root = tmp_path / '.web'
    static = tmp_path / 'static'
    bundle(static, '0' * 32, script='baseline')
    a, b = tmp_path / 'a', tmp_path / 'b'
    bundle(a)
    bundle(b, 'b' * 32, script='second version')
    database = tmp_path / 'jobs.sqlite'
    database.write_bytes(b'private database remains untouched')
    before = (database.read_bytes(), database.stat().st_mtime_ns)
    runtime = WebBundles(static, root, 'f' * 64)

    def verify(version, manifest):
        assert runtime.status()['active'] == version
        if manifest:
            assert read_manifest(runtime.active()[0]) == manifest

    assert publish(root, a, verify=verify)['active'] == 'a' * 32
    assert publish(root, b, verify=verify)['previous'] == 'a' * 32
    assert runtime.asset('board.js', 'a' * 32)[0].read_text() == 'first version'
    assert runtime.asset('board.js', 'b' * 32)[0].read_text() == 'second version'
    driver.switch(root, 'a' * 32, 'f' * 64, verify)
    assert runtime.active()[0].name == 'a' * 32
    assert before == (database.read_bytes(), database.stat().st_mtime_ns)


def test_failed_live_check_restores_previous_pointer(tmp_path):
    a, b, root = tmp_path / 'a', tmp_path / 'b', tmp_path / '.web'
    bundle(a)
    bundle(b, 'b' * 32)
    publish(root, a)
    before = driver.read_state(root)
    checks = []
    def verify(version, _):
        checks.append(version)
        if version == 'b' * 32:
            raise ValueError('simulated HTTP hash mismatch')
    with pytest.raises(ValueError, match='HTTP hash'):
        publish(root, b, verify=verify)
    assert driver.read_state(root) == before
    assert checks == ['b' * 32, 'a' * 32]


def test_first_release_can_roll_back_to_bundled_website(tmp_path):
    candidate, root = tmp_path / 'candidate', tmp_path / '.web'
    bundle(candidate)
    publish(root, candidate)
    assert driver.read_state(root)['previous'] is None
    driver.switch(root, None, 'f' * 64, lambda *_: None)
    assert driver.read_state(root) == {'current': None, 'previous': 'a' * 32}


def test_incompatible_or_corrupt_artifact_never_switches(tmp_path):
    candidate, root = tmp_path / 'candidate', tmp_path / '.web'
    bundle(candidate)
    with pytest.raises(ValueError, match='incompatible'):
        publish(root, candidate, fingerprint='e' * 64)
    assert not (root / 'state.json').exists()
    (candidate / 'board.js').write_text('tampered')
    with pytest.raises(ValueError, match='hash differs'):
        publish(root, candidate)
    assert not (root / 'state.json').exists()


@pytest.mark.parametrize('extra', ['../../jobs.sqlite', '/etc/cron.d/unsafe', 'board.js'])
def test_archive_paths_and_duplicate_files_are_rejected(tmp_path, extra):
    candidate, root = tmp_path / 'candidate', tmp_path / '.web'
    bundle(candidate)
    with pytest.raises(ValueError, match='archive members'):
        driver.activate(root, *archive(candidate, extra), 'f' * 64, lambda *_: None)
    assert not (root / 'state.json').exists()


def test_full_service_change_uses_matching_bundled_baseline(tmp_path):
    candidate, root = tmp_path / 'candidate', tmp_path / '.web'
    bundle(candidate)
    publish(root, candidate)
    runtime = WebBundles(tmp_path / 'static', root, 'e' * 64)
    assert runtime.status()['active'] is None
    with pytest.raises(ValueError, match='incompatible'):
        driver.switch(root, 'a' * 32, 'e' * 64, lambda *_: None)


def test_python_and_node_compute_the_same_runtime_contract():
    script = """
import fs from 'node:fs';
import path from 'node:path';
import {fingerprint} from './deploy/web_release.mjs';
const names=['pyproject.toml','requirements-lock.txt'];
for (const dir of ['jobs_radar','config','contracts'])
  for (const name of fs.readdirSync(dir)) names.push(dir+'/'+name);
console.log(fingerprint(names, name=>fs.readFileSync(name)));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=SERVICE,
                            capture_output=True, text=True, timeout=30, check=True)
    assert result.stdout.strip() == backend_fingerprint(SERVICE)


def test_http_switch_is_visible_without_restart_and_keeps_auth(tmp_path, monkeypatch):
    import jobs_radar.web as web
    root, static = tmp_path / '.web', tmp_path / 'static'
    static.mkdir()
    (static / 'manage').mkdir()
    baseline = '<script src="/assets/board.js?v=1234"></script>'
    (static / 'index.html').write_text(baseline)
    (static / 'manage/index.html').write_text(baseline)
    (static / 'board.js').write_text('baseline')
    (static / 'board.css').write_text('body{}')
    monkeypatch.setattr(web, 'STATIC', static)
    monkeypatch.setenv('JOBS_WEB_ROOT', str(root))
    store = Store(tmp_path / 'test.sqlite')
    server = create_server(store, 'http://localhost')
    with TestClient(server.streamable_http_app(), base_url='http://localhost') as client:
        assert client.get('/').text == baseline
        assert client.get('/api/jobs').status_code == 401
        fingerprint = client.get('/.well-known/jobs-web-release').json()['backendFingerprint']
        candidate = tmp_path / 'candidate'
        bundle(candidate, fingerprint=fingerprint)
        publish(root, candidate, fingerprint)
        assert 'a' * 32 in client.get('/').text
        assert client.get('/manage/').text == client.get('/').text
        asset = client.get('/assets/board.js?v=' + 'a' * 32)
        assert asset.text == 'first version' and 'immutable' in asset.headers['cache-control']
        assert client.get('/assets/board.js?v=1234').text == 'baseline'
        assert client.get('/assets/board.js?v=' + 'e' * 32).status_code == 404
        assert client.get('/assets/jobs.sqlite').status_code == 404
        assert client.get('/api/jobs').status_code == 401
        assert client.get('/.well-known/oauth-authorization-server').status_code == 200
        assert client.get('/healthz').json()['ok']


def test_node_packages_and_rejects_changed_bundle(tmp_path):
    source = tmp_path / 'static'
    bundle(source)
    script = """
import fs from 'node:fs';
import {packageWebsite, verifyBundle} from './deploy/web_release.mjs';
const [source,target]=process.argv.slice(1);
const info={commit:'c'.repeat(40),backendFingerprint:'f'.repeat(64)};
const manifest=packageWebsite(source,target,info);
verifyBundle(target,info);
fs.appendFileSync(target+'/board.js','tampered');
try {verifyBundle(target,info);process.exit(2);} catch(error) {
  if (!error.message.includes('changed')) throw error;
}
console.log(manifest.id);
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(source), str(tmp_path / 'bundle')],
                            cwd=SERVICE, capture_output=True, text=True, timeout=30, check=True)
    assert len(result.stdout.strip()) == 32
