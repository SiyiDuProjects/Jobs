import hashlib
import importlib.util
from pathlib import Path
import sqlite3

import pytest



def implementation():
    path = Path(__file__).parents[1] / 'deploy' / 'migrate_release.py'
    spec = importlib.util.spec_from_file_location('release_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def current_database(path):
    from jobs_radar.store import Store
    store = Store(path)
    return store


def test_current_format_validation_is_readonly_and_isolated(tmp_path):
    database = tmp_path / 'current.sqlite'
    current_database(database)
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    report = implementation().migrate(database)
    assert report['dryRun'] and report['formatValidated']
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before
    assert not list(tmp_path.glob('release-rehearsal-*'))
    assert implementation().migrate(database, dry_run=False)['formatValidated']


@pytest.mark.parametrize('marker', ['applications-v2', 'native-extension-submission-reporting-v1', 'diagnostics-v2-2026-09-26'])
def test_missing_legacy_completion_marker_rejects_without_writes(tmp_path, marker):
    database = tmp_path / 'current.sqlite'
    store = current_database(database)
    with store.connect(True) as c:
        for table in ['schema_migrations', 'diagnostic_migrations']:
            c.execute('DELETE FROM ' + table + ' WHERE name=?', (marker,))
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match='Unsupported database format'):
        implementation().migrate(database, dry_run=False)
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before


def test_empty_database_initializes_but_legacy_rows_require_archived_release(tmp_path):
    from jobs_radar.store import Store
    database = tmp_path / 'new.sqlite'
    Store(database)
    with sqlite3.connect(database) as c:
        assert c.execute("SELECT 1 FROM schema_migrations WHERE name='applications-v2'").fetchone()
        c.execute('DELETE FROM schema_migrations')
        c.execute("INSERT INTO applications(job_id,status,updated) VALUES('legacy','not_started',0)")
    with pytest.raises(ValueError, match='Unsupported legacy'):
        Store(database)


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
