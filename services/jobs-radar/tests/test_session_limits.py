from starlette.testclient import TestClient

from jobs_radar.server import create_server
from jobs_radar.store import Store
from jobs_radar.web import WebAccess


def test_new_session_limits_isolate_clients_and_keep_existing_sessions(tmp_path, monkeypatch):
    monkeypatch.setenv('JOBS_TRUST_SESSION_PROXY', '1')
    store = Store(tmp_path / 'sessions.sqlite')
    origin = 'http://127.0.0.1:8796'
    with TestClient(create_server(store, origin).streamable_http_app(), base_url=origin) as client:
        for i in range(20):
            client.cookies.clear()
            result = client.get('/api/session', headers={'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': f'192.0.2.{i}'})
            assert result.status_code == 200
        # An existing pending session is reusable even at the limit.
        assert client.get('/api/session', headers={'CF-Connecting-IP': '198.51.100.1'}).status_code == 200
        client.cookies.clear()
        assert client.get('/api/session', headers={'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '192.0.2.200'}).status_code == 429
        other = client.get('/api/session', headers={'CF-Connecting-IP': '198.51.100.2'})
        assert other.status_code == 200
        WebAccess(store, origin).approve(other.json()['request_id'])
        assert client.get('/api/session').json()['authenticated'] is True
        client.cookies.clear()
        monkeypatch.setattr('jobs_radar.web.time.time', lambda: 2000000000)
        assert client.get('/api/session', headers={'CF-Connecting-IP': '198.51.100.1'}).status_code == 200


def test_untrusted_forwarded_headers_cannot_bypass_limit(tmp_path, monkeypatch):
    monkeypatch.delenv('JOBS_TRUST_SESSION_PROXY', raising=False)
    store = Store(tmp_path / 'direct.sqlite')
    with TestClient(create_server(store, 'http://localhost').streamable_http_app(), base_url='http://localhost') as client:
        for i in range(21):
            client.cookies.clear()
            response = client.get('/api/session', headers={'CF-Connecting-IP': f'192.0.2.{i}', 'X-Forwarded-For': f'192.0.2.{i}'})
            assert response.status_code == (200 if i < 20 else 429)
