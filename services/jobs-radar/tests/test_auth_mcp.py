import base64
import hashlib
import re
from urllib.parse import parse_qs, urlencode, urlsplit

from starlette.testclient import TestClient

from jobs_radar.auth import OwnerOAuth
from jobs_radar.server import create_server
from jobs_radar.store import Store
from test_store import observation

ORIGIN = "http://127.0.0.1:8796"


def test_agent_reads_each_profiles_supplemental_facts_without_attachment_bytes(tmp_path):
    from jobs_radar.profiles import Profiles
    from test_profile_details import enriched

    store = Store(tmp_path / 'agent-profiles.sqlite')
    profiles = Profiles(store)
    saved = []
    for name, month, notes in [
        ('Newgrad', '2027-05', 'Synthetic full-time project and availability notes.'),
        ('Intern', '2027-12', 'Synthetic internship project and summer schedule notes.'),
    ]:
        value = enriched()
        value['profileName'] = name
        value['educationData'][0]['endDate'] = month
        value['educationData'][0].pop('graduationDate')
        value['applicationData']['aiNotes'] = notes
        value['resumeData'] = {'fileName': name + '.pdf', 'resumeBase64': 'c3ludGhldGlj'}
        saved.append((profiles.save(value), value))

    with TestClient(create_server(store, ORIGIN).streamable_http_app(), base_url=ORIGIN) as client:
        token, _ = connect(client, store, scopes='jobs:read')
        metadata = rpc(client, token['access_token'], 'tools/call',
            {'name': 'get_profiles', 'arguments': {}}).json()['result']
        assert not metadata.get('isError'), metadata
        assert metadata['structuredContent']['profiles'] == [
            {'id': record['id'], 'profileName': value['profileName']} for record, value in saved]
        for record, value in saved:
            result = rpc(client, token['access_token'], 'tools/call',
                {'name': 'get_profiles', 'arguments': {'profile_id': record['id']}}).json()['result']
            assert not result.get('isError'), result
            facts = result['structuredContent']
            assert facts['id'] == record['id'] and facts['last_sync'] == record['last_sync']
            assert facts['profile']['profileName'] == value['profileName']
            assert facts['profile']['educationData'] == value['educationData']
            assert facts['profile']['applicationData'] == value['applicationData']
            assert facts['profile']['resumeData'] == {'fileName': value['resumeData']['fileName']}
            assert profiles.get(record['id'])['profile']['resumeData'] == value['resumeData']


def connect(client, store, scopes="jobs:read applications:write"):
    registration = client.post("/register", json={"client_name": "Jobs Integration Test", "redirect_uris": ["http://127.0.0.1:9876/callback"],
        "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": scopes})
    assert registration.status_code == 201, registration.text
    client_id = registration.json()["client_id"]
    verifier = "A" * 64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    response = client.get("/authorize?" + urlencode({"client_id": client_id, "redirect_uri": "http://127.0.0.1:9876/callback", "response_type": "code",
        "code_challenge": challenge, "code_challenge_method": "S256", "scope": scopes, "resource": ORIGIN + "/mcp", "state": "test-state"}), follow_redirects=False)
    assert response.status_code in {302, 303, 307}, response.text
    consent_url = response.headers["location"]
    rid = parse_qs(urlsplit(consent_url).query)["request"][0]
    consent = client.get(consent_url)
    assert consent.status_code == 200
    csrf = re.search(r'name="csrf" value="([^"]+)"', consent.text)[1]
    # Public flow alone cannot grant access.
    waiting = client.post(consent_url, data={"csrf": csrf}, headers={"Origin": ORIGIN}, follow_redirects=False)
    assert waiting.status_code == 200 and "Waiting" in waiting.text
    csrf = re.search(r'name="csrf" value="([^"]+)"', waiting.text)[1]
    OwnerOAuth(store, ORIGIN).approve(rid)
    response = client.post(consent_url, data={"csrf": csrf}, headers={"Origin": ORIGIN}, follow_redirects=False)
    assert response.status_code == 303
    qs = parse_qs(urlsplit(response.headers["location"]).query)
    assert qs["state"] == ["test-state"]
    assert qs["iss"] == [client.get("/.well-known/oauth-authorization-server").json()["issuer"]]
    token_args = {"grant_type": "authorization_code", "client_id": client_id, "code": qs["code"][0],
                  "redirect_uri": "http://127.0.0.1:9876/callback", "code_verifier": verifier, "resource": ORIGIN + "/mcp"}
    wrong = client.post("/token", data={**token_args, "code_verifier": "B" * 64})
    assert wrong.status_code == 400
    token = client.post("/token", data=token_args)
    assert token.status_code == 200, token.text
    assert client.post("/token", data=token_args).status_code == 400
    return token.json(), client_id


def rpc(client, token, method, params=None, rid=1):
    return client.post("/mcp", headers={"Authorization": "Bearer " + token, "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def test_oauth_and_live_mcp_flow(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    store.ingest("simplify:newgrad", [observation()], "test")
    server = create_server(store, ORIGIN)
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as client:
        assert client.get("/healthz").json()["ok"]
        assert client.post("/mcp").status_code == 401
        metadata = client.get("/.well-known/oauth-authorization-server").json()
        assert metadata["code_challenge_methods_supported"] == ["S256"]
        assert client.get("/.well-known/oauth-protected-resource/mcp").json()["resource"] == ORIGIN + "/mcp"
        token, client_id = connect(client, store)
        access = token["access_token"]
        result = rpc(client, access, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
        assert result.status_code == 200, result.text
        from jobs_radar.operation_policy import POLICY_PATH, instructions
        assert result.json()['result']['instructions'] == instructions()
        assert POLICY_PATH.read_text(encoding='utf-8').strip() in result.json()['result']['instructions']
        tools = rpc(client, access, "tools/list").json()["result"]["tools"]
        assert 'approve_browser_login' not in {t['name'] for t in tools}
        assert len(tools) == len({t['name'] for t in tools})
        assert {'list_application_states','update_application_progress','record_unmatched_recruiting_email',
                'get_profiles','change_application_record','get_service_status'} <= {t['name'] for t in tools}
        import time
        from jobs_radar.screening_progress import ScreeningProgress
        ScreeningProgress(store).initialize(time.time()-86400)
        begun = rpc(client, access, 'tools/call', {'name':'manage_screening_run','arguments':{'action':'begin'}}).json()['result']
        assert not begun.get('isError'), begun
        run_id = begun['structuredContent']['id']
        queued = rpc(client, access, 'tools/call', {'name':'get_screening_queue','arguments':{'kind':'newgrad','run_id':run_id}}).json()['result']
        assert len(queued['structuredContent']['jobs'])==1
        unfinished = rpc(client, access, 'tools/call', {'name':'manage_screening_run','arguments':{'action':'complete','run_id':run_id}}).json()['result']
        assert unfinished['structuredContent']['completed'] is False
        assert next(t for t in tools if t["name"] == "change_application_record")["annotations"]["readOnlyHint"] is False
        search = rpc(client, access, "tools/call", {"name": "search_jobs", "arguments": {"location": "CA"}}).json()["result"]
        assert not search.get("isError"), search
        job_id = search["structuredContent"]["jobs"][0]["id"]
        assert not {'claim_jobs', 'record_application_result', 'manage_job_lease', 'reconcile_application', 'record_recruiting_email'} & {t['name'] for t in tools}
        profiles = rpc(client, access, 'tools/call', {'name': 'get_profiles', 'arguments': {}}).json()['result']
        assert not profiles.get('isError'), profiles
        refresh_args = {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": token["refresh_token"], "resource": ORIGIN + "/mcp"}
        refreshed = client.post("/token", data=refresh_args)
        assert refreshed.status_code == 200, refreshed.text
        assert rpc(client, refreshed.json()["access_token"], "tools/list").status_code == 200
        assert client.post("/token", data=refresh_args).status_code == 400
        assert rpc(client, access, "tools/list").status_code == 401
        assert rpc(client, refreshed.json()["access_token"], "tools/list").status_code == 401
        assert client.post('/token', data={**refresh_args, 'refresh_token': refreshed.json()['refresh_token']}).status_code == 400
        revoked = client.post("/revoke", data={"token": refreshed.json()["refresh_token"], "client_id": client_id, "client_secret": "", "token_type_hint": "refresh_token"})
        assert revoked.status_code == 200
        assert rpc(client, refreshed.json()["access_token"], "tools/list").status_code == 401
        # Restart preserves the OAuth connection.
        assert OwnerOAuth(Store(store.path), ORIGIN).pending() == []


def test_readonly_scope_rejects_write(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    server = create_server(store, ORIGIN)
    with TestClient(server.streamable_http_app(), headers={'X-Jobs-Protocol': '2'}, base_url=ORIGIN) as client:
        token, _ = connect(client, store, "jobs:read")
        result = rpc(client, token["access_token"], "tools/call", {"name": "change_application_record", "arguments": {"change": {"action": "delete", "application_id": "x", "expected_version": 0}, "idempotency_key": "test-change"}}).json()["result"]
        assert result["isError"] is True
        assert "required scope" in str(result)
        denied = rpc(client, token['access_token'], 'tools/call', {'name':'manage_screening_run','arguments':{'action':'begin'}}).json()['result']
        assert denied['isError'] is True
