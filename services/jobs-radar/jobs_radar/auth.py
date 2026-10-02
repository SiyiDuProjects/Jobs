"""Single-owner OAuth with out-of-band SSH approval, SDK PKCE and hashed bearer tokens.

No public signup or shared ATS credentials. A new connection must be explicitly approved
by the owner through the private server CLI after matching its displayed request ID.
"""
import hashlib
import html
import json
import secrets
import time
from urllib.parse import urlsplit
from uuid import uuid4

from mcp.server.auth.provider import (AccessToken, AuthorizationCode, AuthorizationParams,
    AuthorizeError, OAuthAuthorizationServerProvider, RefreshToken, RegistrationError, TokenError,
    construct_redirect_uri)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.responses import HTMLResponse, RedirectResponse

SCOPES = ["jobs:read", "applications:write"]
OWNER = "siyidu-owner"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class OwnerOAuth(OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]):
    def __init__(self, store, origin):
        self.store, self.origin = store, origin.rstrip("/")
        self.issuer = self.origin + "/"  # Match the SDK's AnyHttpUrl metadata serialization exactly.
        self.resource = self.origin + "/mcp"
        with store.connect() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY,payload TEXT,created REAL);
            CREATE TABLE IF NOT EXISTS oauth_requests(id TEXT PRIMARY KEY,client_id TEXT,params TEXT,
                expires REAL,approved INTEGER DEFAULT 0,browser_hash TEXT,csrf_hash TEXT);
            CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY,payload TEXT,expires REAL);
            CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY,kind TEXT,payload TEXT,expires REAL,family TEXT);
            """)

    async def get_client(self, client_id):
        with self.store.connect() as c:
            row = c.execute("SELECT payload FROM oauth_clients WHERE id=?", (client_id,)).fetchone()
            return OAuthClientInformationFull.model_validate_json(row[0]) if row else None

    async def register_client(self, client_info):
        for uri in client_info.redirect_uris or []:
            p = urlsplit(str(uri))
            if p.username or p.password or p.fragment or not (p.scheme == "https" or p.scheme == "http" and p.hostname in {"127.0.0.1", "localhost", "::1"}):
                raise RegistrationError("invalid_redirect_uri", "HTTPS or loopback redirect required")
        with self.store.connect(True) as c:
            if c.execute("SELECT count(*) FROM oauth_clients WHERE created>?", (time.time() - 3600,)).fetchone()[0] >= 50:
                raise RegistrationError("invalid_client_metadata", "Registration rate limit")
            c.execute("INSERT INTO oauth_clients VALUES(?,?,?)", (client_info.client_id, client_info.model_dump_json(), time.time()))

    async def authorize(self, client, params):
        if params.resource not in {None, self.resource}:
            raise AuthorizeError("invalid_request", "Unknown resource")
        if not set(params.scopes or SCOPES) <= set(SCOPES):
            raise AuthorizeError("invalid_scope", "Unsupported scope")
        params.resource = self.resource
        params.scopes = params.scopes or SCOPES
        rid = str(uuid4())
        with self.store.connect(True) as c:
            c.execute("DELETE FROM oauth_requests WHERE expires<?", (time.time(),))
            if c.execute("SELECT count(*) FROM oauth_requests").fetchone()[0] >= 100:
                raise AuthorizeError("temporarily_unavailable", "Too many pending connections")
            c.execute("INSERT INTO oauth_requests(id,client_id,params,expires) VALUES(?,?,?,?)", (rid, client.client_id, params.model_dump_json(), time.time() + 900))
        return self.origin + "/consent?request=" + rid

    def pending(self):
        with self.store.connect() as c:
            return [{"request_id": r["id"], "client_id": r["client_id"], "redirect_uri": json.loads(r["params"])["redirect_uri"],
                     "scopes": json.loads(r["params"])["scopes"], "browser_opened": bool(r["browser_hash"]), "approved": bool(r["approved"])}
                    for r in c.execute("SELECT * FROM oauth_requests WHERE expires>?", (time.time(),))]

    def approve(self, request_id):
        with self.store.connect(True) as c:
            row = c.execute("SELECT * FROM oauth_requests WHERE id=? AND expires>?", (request_id, time.time())).fetchone()
            if not row or not row["browser_hash"]:
                raise ValueError("Open the matching browser consent page before approving")
            c.execute("UPDATE oauth_requests SET approved=1 WHERE id=?", (request_id,))
            c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('oauth_approval',?,?,?)", (OWNER + ":ssh-admin", time.time(), json.dumps({"request_id": request_id, "client_id": row["client_id"]})))
            return {"approved": True, "request_id": request_id}

    async def consent(self, request):
        rid = request.query_params.get("request", "")
        cookie_name = "jobs_approval_" + rid.replace("-", "")
        with self.store.connect(True) as c:
            row = c.execute("SELECT * FROM oauth_requests WHERE id=? AND expires>?", (rid, time.time())).fetchone()
            if not row:
                return HTMLResponse("This connection request expired. Start again in ChatGPT.", status_code=400)
            browser = request.cookies.get(cookie_name, "")
            if not row["browser_hash"]:
                browser = secrets.token_urlsafe(32)
                c.execute("UPDATE oauth_requests SET browser_hash=? WHERE id=?", (digest(browser), rid))
            elif not browser or not secrets.compare_digest(row["browser_hash"], digest(browser)):
                return HTMLResponse("Open this request in its original browser.", status_code=403)
            params = AuthorizationParams.model_validate_json(row["params"])
            if request.method == "POST":
                form = await request.form()
                if request.headers.get("origin") != self.origin or not row["csrf_hash"] or not secrets.compare_digest(row["csrf_hash"], digest(str(form.get("csrf", "")))):
                    return HTMLResponse("Invalid consent request.", status_code=403)
                if row["approved"]:
                    code = secrets.token_urlsafe(32)
                    auth_code = AuthorizationCode(code="", client_id=row["client_id"], scopes=params.scopes or SCOPES,
                        expires_at=time.time() + 120, code_challenge=params.code_challenge,
                        redirect_uri=params.redirect_uri, redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                        resource=self.resource, subject=OWNER)
                    c.execute("INSERT INTO oauth_codes VALUES(?,?,?)", (digest(code), auth_code.model_dump_json(), auth_code.expires_at))
                    c.execute("DELETE FROM oauth_requests WHERE id=?", (rid,))
                    response = RedirectResponse(construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state, iss=self.issuer), status_code=303)
                    response.delete_cookie(cookie_name, path="/consent")
                    response.headers["Cache-Control"] = "no-store"
                    response.headers["Referrer-Policy"] = "no-referrer"
                    return response
            csrf = secrets.token_urlsafe(32)
            c.execute("UPDATE oauth_requests SET csrf_hash=? WHERE id=?", (digest(csrf), rid))
        status = "Approved. Continue to ChatGPT." if row["approved"] else "Waiting for the owner's approval."
        page = f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <title>Connect Jobs Radar</title><body><main><h1>Connect Jobs Radar</h1>
        <p>Private access to jobs and your application records.</p><p>{status}</p>
        <p>Request ID: <strong>{html.escape(rid)}</strong></p>
        <p>Return to: {html.escape(str(params.redirect_uri))}</p><p>Permissions: {html.escape(', '.join(params.scopes or []))}</p>
        <p>Ask your server administrator to approve this exact request ID, then continue. Never approve a request you did not start.</p>
        <form method="post"><input type="hidden" name="csrf" value="{csrf}"><button>Continue</button></form>
        </main></body></html>"""
        response = HTMLResponse(page)
        response.set_cookie(cookie_name, browser, max_age=900, httponly=True, secure=self.origin.startswith("https:"), samesite="lax", path="/consent")
        # no-referrer makes real HTML form POSTs send Origin: null in browsers.
        # strict-origin preserves the CSRF origin check without exposing the request URL.
        redirect = urlsplit(str(params.redirect_uri))
        redirect_origin = f"{redirect.scheme}://{redirect.netloc}"
        # Chrome applies form-action to the 303 redirect as well as the POST.
        # Permit only this client's registered callback origin, never a wildcard.
        response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "strict-origin",
                                 "Content-Security-Policy": f"default-src 'none'; form-action 'self' {redirect_origin}; frame-ancestors 'none'; base-uri 'none'"})
        return response

    async def load_authorization_code(self, client, authorization_code):
        with self.store.connect() as c:
            row = c.execute("SELECT * FROM oauth_codes WHERE hash=? AND expires>?", (digest(authorization_code), time.time())).fetchone()
            if not row:
                return None
            model = AuthorizationCode.model_validate_json(row["payload"])
            if model.client_id != client.client_id:
                return None
            model.code = authorization_code
            return model

    def _issue(self, c, client_id, scopes, family=None):
        now = int(time.time())
        access, refresh, family = secrets.token_urlsafe(32), secrets.token_urlsafe(32), family or secrets.token_hex(24)
        for kind, token, expires in [("access", access, now + 3600), ("refresh", refresh, now + 30 * 86400)]:
            data = {"token": "", "client_id": client_id, "scopes": scopes, "expires_at": expires, "resource": self.resource, "subject": OWNER}
            c.execute("INSERT INTO oauth_tokens VALUES(?,?,?,?,?)", (digest(token), kind, json.dumps(data), expires, family))
        return OAuthToken(access_token=access, refresh_token=refresh, token_type="Bearer", expires_in=3600, scope=" ".join(scopes))

    async def exchange_authorization_code(self, client, authorization_code):
        with self.store.connect(True) as c:
            row = c.execute("SELECT * FROM oauth_codes WHERE hash=? AND expires>?", (digest(authorization_code.code), time.time())).fetchone()
            if not row or json.loads(row["payload"])["client_id"] != client.client_id:
                raise TokenError("invalid_grant", "Expired or consumed authorization code")
            c.execute("DELETE FROM oauth_codes WHERE hash=?", (digest(authorization_code.code),))
            return self._issue(c, client.client_id, authorization_code.scopes)

    async def load_access_token(self, token):
        return self._load_token(token, "access", AccessToken)

    async def load_refresh_token(self, client, refresh_token):
        model = self._load_token(refresh_token, "refresh", RefreshToken)
        return model if model and model.client_id == client.client_id else None

    def _load_token(self, token, kind, model_class):
        with self.store.connect() as c:
            row = c.execute("SELECT * FROM oauth_tokens WHERE hash=? AND kind=? AND expires>?", (digest(token), kind, time.time())).fetchone()
            if not row:
                return None
            model = model_class.model_validate_json(row["payload"])
            if not c.execute("SELECT 1 FROM oauth_clients WHERE id=?", (model.client_id,)).fetchone():
                return None
            if model.resource != self.resource or model.subject != OWNER:
                return None
            model.token = token
            return model

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        with self.store.connect(True) as c:
            row = c.execute("SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh' AND expires>?", (digest(refresh_token.token), time.time())).fetchone()
            if not row or json.loads(row["payload"])["client_id"] != client.client_id or not set(scopes) <= set(refresh_token.scopes):
                raise TokenError("invalid_grant", "Invalid, expired or consumed refresh token")
            c.execute("DELETE FROM oauth_tokens WHERE family=?", (row["family"],))
            return self._issue(c, client.client_id, scopes, row["family"])

    async def revoke_token(self, token):
        with self.store.connect(True) as c:
            c.execute("DELETE FROM oauth_tokens WHERE family IN (SELECT family FROM oauth_tokens WHERE hash=?)", (digest(token.token),))
