import uuid

from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from jobs_radar.http_routes import RouteAPI
from jobs_radar.profile_routes import register_profile_routes
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.client_protocol import CURRENT_HEADERS, HEADER, register_retired_routes
from test_profile_contract import fixture


class Server:
    def __init__(self):
        self.routes = []

    def custom_route(self, path, methods):
        def register(fn):
            self.routes.append(Route(path, fn, methods=methods))
            return fn
        return register


def test_rest_conflicts_versions_deletion_and_readonly_projection(tmp_path):
    profiles = Profiles(Store(tmp_path / "profiles.sqlite"))
    server = Server()
    register_profile_routes(RouteAPI(server), profiles, lambda request: request.headers.get("authorization") == "fixture")
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        path = "/api/manage/profiles"
        assert client.get(path).status_code == 401
        client.headers["authorization"] = "fixture"
        value = fixture()
        value["resumeData"] = {"fileName": "fixture.pdf", "resumeBase64": "synthetic-binary", "fileSize": 1}
        created = client.post(path, json={"profile": value}).json()
        first = path + "/" + created["id"]
        record = client.get(first).json()
        assert record["profile"] == value
        assert record["schema_version"] == 1
        assert client.get(first).headers["cache-control"] == "no-store"
        assert "resumeBase64" not in profiles.agent_read(created["id"])["profile"]["resumeData"]
        assert "profile" not in profiles.agent_read()["profiles"][0]
        assert client.put(first, json={"profile": {**value, "profileName": "Changed"}}).status_code == 409
        assert client.put(first, json={"profile": value, "schema_version": 2}).status_code == 426
        assert client.put(first, json={"profile": value, "expected_sync": 5}).status_code == 400
        assert client.put(path + "/" + str(uuid.uuid4()), json={"profile": value}).status_code == 404
        changed = {**value, "applicationData": {"sponsorshipNow": False}}
        saved = client.put(first, json={"profile": changed, "expected_sync": created["last_sync"]}).json()
        assert client.get(first).json()["profile"] == changed
        assert client.request("DELETE", first, json={"expected_sync": saved["last_sync"]}).status_code == 400
        client.post(path, json={"profile": {**fixture(), "profileName": "Second"}})
        assert client.request("DELETE", first, json={"expected_sync": created["last_sync"]}).status_code == 409
        assert client.request("DELETE", first, json={"expected_sync": saved["last_sync"]}).status_code == 200
        assert client.get(first).status_code == 404


def test_retired_profile_envelopes_and_schema_never_write(tmp_path):
    profiles = Profiles(Store(tmp_path / 'profiles.sqlite'))
    server = Server()
    authorize = lambda request: request.headers.get('authorization') == 'fixture'
    register_profile_routes(RouteAPI(server), profiles, authorize)
    register_retired_routes(RouteAPI(server), authorize)
    with TestClient(Starlette(routes=server.routes)) as client:
        path = '/api/manage/profiles'
        legacy = {'path': '/api/ext/sync/profile/list', 'method': 'POST', 'body': {'profile': fixture()}}
        assert client.post(path, json=legacy, headers=CURRENT_HEADERS).status_code == 401
        assert client.post(path, json=legacy).status_code == 426
        client.headers['authorization'] = 'fixture'
        for old_path in [path, '/api/ext/sync/profile', '/api/ext/sync/profile/list', '/api/manage/answer']:
            response = client.post(old_path, json=legacy)
            assert response.status_code == 426
            assert response.json()['code'] == 'client_upgrade_required'
            assert '升级 Jobs 插件或刷新网站' in response.json()['error']
            assert response.headers['cache-control'] == 'no-store'
        assert profiles.list() == []
        client.headers.update(CURRENT_HEADERS)
        assert client.post(path, json={'profile': fixture(), 'schema_version': 999}).status_code == 426
        assert profiles.list() == []
        for old_path in ['/api/ext/sync/profile', '/api/ext/sync/profile/list', '/api/manage/answer']:
            assert client.post(old_path, json=legacy).status_code == 426
        assert client.post(path, json={'profile': fixture()}).status_code == 200
        assert len(profiles.list()) == 1
        client.headers[HEADER] = '1'
        assert client.post(path, json={'profile': fixture()}).status_code == 426
        assert len(profiles.list()) == 1


def test_creation_reference_and_deletion_are_retryable_without_duplicate_or_overwrite(tmp_path):
    profiles = Profiles(Store(tmp_path / 'retry.sqlite'))
    server = Server()
    register_profile_routes(RouteAPI(server), profiles, lambda request: True)
    with TestClient(Starlette(routes=server.routes), headers=CURRENT_HEADERS) as client:
        path = '/api/manage/profiles'
        identifier = str(uuid.uuid4())
        body = {'id': identifier, 'profile': fixture()}
        created = client.post(path, json=body)
        assert created.status_code == 200
        assert client.post(path, json=body).json() == created.json()
        assert len(profiles.list()) == 1
        changed = {**body, 'profile': {**fixture(), 'profileName': 'Different'}, 'expected_sync': created.json()['last_sync']}
        assert client.post(path, json=changed).status_code == 409
        assert profiles.get(identifier)['profile'] == fixture()
        assert client.post(path, json={**body, 'id': 'not-a-uuid'}).status_code == 400
        other = client.post(path, json={'id': str(uuid.uuid4()), 'profile': {**fixture(), 'profileName': 'Other'}}).json()
        deletion = {'expected_sync': created.json()['last_sync']}
        removed = client.request('DELETE', path + '/' + identifier, json=deletion)
        assert removed.status_code == 200 and removed.json()['id'] == other['id']
        assert client.request('DELETE', path + '/' + identifier, json=deletion).json() == removed.json()
        assert client.request('DELETE', path + '/' + identifier, json={'expected_sync': 'stale'}).status_code == 409
        assert client.post(path, json=body).status_code == 409
        assert len(profiles.list()) == 1
