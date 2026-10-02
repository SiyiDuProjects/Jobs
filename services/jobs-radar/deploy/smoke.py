"""Production read-only OAuth/MCP smoke. Run through the private server admin context.

Creates a temporary OAuth client/grant, exercises real HTTP, and revokes its tokens.
--internal verifies the loopback service before DNS; default verifies public HTTPS.
Never prints access tokens, cookies, authorization codes or private job details.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from jobs_radar.auth import OwnerOAuth
from jobs_radar.store import Store


parser = argparse.ArgumentParser()
parser.add_argument("--internal", action="store_true")
args = parser.parse_args()
origin = os.environ.get("JOBS_ORIGIN", "https://jobs.siyidu.com")
base = "http://127.0.0.1:8796" if args.internal else origin
provider = OwnerOAuth(Store(os.environ.get("JOBS_DB", "/data/jobs.sqlite")), origin)
result = {"transport": "loopback HTTP" if args.internal else "public HTTPS"}
with httpx.Client(timeout=30, follow_redirects=False) as client:
    assert client.get(base + "/healthz").json()["ok"]
    assert client.post(base + "/mcp").status_code == 401
    meta = client.get(base + "/.well-known/oauth-authorization-server").json()
    assert meta["issuer"] == provider.issuer
    registration = client.post(base + "/register", json={"client_name": "Jobs Radar temporary deployment smoke", "redirect_uris": ["http://127.0.0.1:19876/callback"],
        "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": "jobs:read"})
    registration.raise_for_status()
    client_id = registration.json()["client_id"]
    access = refresh = None
    try:
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        authorization = client.get(base + "/authorize", params={"client_id": client_id, "response_type": "code", "redirect_uri": "http://127.0.0.1:19876/callback", "scope": "jobs:read",
            "code_challenge": challenge, "code_challenge_method": "S256", "state": "deployment-smoke", "resource": origin + "/mcp"})
        consent_url = authorization.headers["location"].replace(origin, base, 1)
        rid = parse_qs(urlsplit(consent_url).query)["request"][0]
        consent = client.get(consent_url)
        consent.raise_for_status()
        csrf = re.search(r'name="csrf" value="([^"]+)"', consent.text)[1]
        provider.approve(rid)
        # The production cookie remains Secure. In loopback tests supply only this temporary test cookie explicitly.
        headers = {"Origin": origin}
        if args.internal:
            headers["Cookie"] = "; ".join(f"{c.name}={c.value}" for c in client.cookies.jar)
        approved = client.post(consent_url, data={"csrf": csrf}, headers=headers)
        assert approved.status_code == 303
        code = parse_qs(urlsplit(approved.headers["location"]).query)["code"][0]
        assert parse_qs(urlsplit(approved.headers["location"]).query)["iss"][0] == meta["issuer"]
        response = client.post(base + "/token", data={"grant_type": "authorization_code", "client_id": client_id, "code": code,
            "redirect_uri": "http://127.0.0.1:19876/callback", "code_verifier": verifier, "resource": origin + "/mcp"})
        response.raise_for_status()
        access, refresh = response.json()["access_token"], response.json()["refresh_token"]
        def rpc(method, params=None):
            response = client.post(base + "/mcp", headers={"Authorization": "Bearer " + access, "Accept": "application/json, text/event-stream"},
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
            response.raise_for_status()
            data = response.json()
            assert "error" not in data, "MCP protocol error"
            return data["result"]
        initialized = rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "deployment-smoke", "version": "1"}})
        tools = rpc("tools/list")["tools"]
        names = {tool["name"] for tool in tools}
        assert {"get_profiles", "change_application_record", "list_application_states"} <= names
        assert not {"claim_jobs", "manage_job_lease", "record_application_result", "reconcile_application"} & names
        status = rpc("tools/call", {"name": "get_service_status", "arguments": {}})["structuredContent"]
        search = rpc("tools/call", {"name": "search_jobs", "arguments": {"location": "CA", "posted_within_hours": 24, "limit": 3}})["structuredContent"]
        listed = rpc("tools/call", {"name": "get_profiles", "arguments": {}})["structuredContent"]
        checked_profiles = 0
        for profile in listed["profiles"]:
            current = rpc("tools/call", {"name": "get_profiles", "arguments": {"profile_id": profile["id"]}})["structuredContent"]
            assert current["id"] == profile["id"] and current["schema_version"] == listed["schema_version"]
            assert "resumeBase64" not in current["profile"].get("resumeData", {})
            assert not re.search(r'"(?:password|passcode|access_token|refresh_token)"\s*:', json.dumps(current), re.I)
            checked_profiles += 1
        # Invoke a CURRENT write tool with valid arguments. An unknown tool or
        # an input-validation error would not prove read-only authorization.
        rejected = rpc("tools/call", {"name": "change_application_record", "arguments": {
            "change": {"action": "delete", "application_id": "nonexistent-smoke-fixture", "expected_version": 0},
            "idempotency_key": "readonly-smoke-" + secrets.token_hex(8)}})
        assert rejected["isError"]
        assert "required scope" in json.dumps(rejected), "Write rejection was not an authorization check"
        result.update({"oauth": True, "tools": len(tools), "source_count": len(status["sources"]), "all_sources_fresh": all(not s["stale"] for s in status["sources"]),
            "jobs": status["jobs"], "query_results": len(search["jobs"]), "readonly_scope_enforced": True,
            "profiles_read_without_attachments_or_credentials": checked_profiles})
    finally:
        if refresh:
            revoked = client.post(base + "/revoke", data={"token": refresh, "client_id": client_id, "client_secret": "", "token_type_hint": "refresh_token"})
            result["test_grant_revoked"] = revoked.status_code == 200
        # Remove only this temporary client; the revocation audit and operational state are preserved.
        with provider.store.connect(True) as c:
            c.execute("DELETE FROM oauth_tokens WHERE json_extract(payload,'$.client_id')=?", (client_id,))
            c.execute("DELETE FROM oauth_clients WHERE id=?", (client_id,))
print(json.dumps(result))
