import hashlib
import importlib.util
from pathlib import Path
import sqlite3

import pytest

from test_application_model_v2 import legacy_database


def implementation():
    path = Path(__file__).parents[1] / 'deploy' / 'migrate_release.py'
    spec = importlib.util.spec_from_file_location('release_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_combined_migration_uses_isolated_dryrun_and_one_commit(tmp_path):
    database = tmp_path / 'old.sqlite'
    legacy_database(database)
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    report = implementation().migrate(database)
    assert report['dryRun'] and report['diagnostics']['oldBrowserSessionsEnded']
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before
    assert not list(tmp_path.glob('release-rehearsal-*'))
    applied = implementation().migrate(database, dry_run=False)
    assert not applied['dryRun']
    with sqlite3.connect(database) as connection:
        assert connection.execute('SELECT count(*) FROM diagnostic_migrations').fetchone()[0] == 1


def test_diagnostic_failure_does_not_commit_application_schema(tmp_path, monkeypatch):
    database = tmp_path / 'old.sqlite'
    legacy_database(database)
    module = implementation()
    def fail(connection):
        raise ValueError('Synthetic diagnostic migration failure')
    monkeypatch.setattr(module, 'diagnostics', fail)
    with pytest.raises(ValueError, match='Synthetic'):
        module.migrate(database, dry_run=False)
    with sqlite3.connect(database) as connection:
        assert connection.execute('SELECT count(*) FROM claims').fetchone()[0] == 1
        assert connection.execute('SELECT count(*) FROM schema_migrations').fetchone()[0] == 0


def test_maintenance_blocks_auth_and_read_side_effects_before_any_route(tmp_path, monkeypatch):
    from starlette.testclient import TestClient
    from jobs_radar.store import Store
    from jobs_radar.server import create_server
    from test_auth_mcp import ORIGIN, connect, rpc
    database = tmp_path / 'live.sqlite'
    flag = tmp_path / 'maintenance'
    monkeypatch.setenv('JOBS_MAINTENANCE_FILE', str(flag))
    store = Store(database)
    server = create_server(store, ORIGIN)
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as client:
        token, _ = connect(client, store)
        with sqlite3.connect(database) as connection:
            before = list(connection.iterdump())
        flag.write_text('test release')
        for path in ['/authorize', '/consent', '/api/jobs', '/api/manage/state', '/api/browser/session']:
            result = client.get(path)
            assert result.status_code == 503, (path, result.text)
        for path in ['/register', '/token', '/revoke', '/consent', '/api/actions', '/api/extension/diagnostics']:
            assert client.post(path, json={}).status_code == 503
        assert rpc(client, token['access_token'], 'tools/list').status_code == 503
        assert client.get('/healthz').status_code == 200
        assert client.get('/.well-known/oauth-authorization-server').status_code == 200
        with sqlite3.connect(database) as connection:
            assert list(connection.iterdump()) == before
        flag.unlink()
        assert rpc(client, token['access_token'], 'tools/list').status_code == 200
