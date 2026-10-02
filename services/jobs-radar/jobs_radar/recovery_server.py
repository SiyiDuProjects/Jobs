"""Owner website only. No MCP, extension grants, workers, or application routes."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import time
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import FileResponse, HTMLResponse, RedirectResponse
from starlette.routing import Route

from .http_routes import RouteAPI, json_response
from .management import Management
from .profile_routes import register_profile_routes
from .profiles import Profiles
from .restricted_recovery import RecoveryStore, writable_document, CODE, MESSAGE, MODE, service_lock
from .web import WebAccess, COOKIE, STATIC
from .web_inputs import StateRequest


class Routes:
    def __init__(self): self.routes = []

    def custom_route(self, path, methods):
        def register(handler):
            self.routes.append(Route(path, handler, methods=methods))
            return handler
        return register


def existing(cls, store, **attributes):
    # Preparation checks the complete schema. Bypass ordinary constructors'
    # CREATE statements; use the exact current domain read/write methods.
    value = cls.__new__(cls)
    value.store = store
    value.__dict__.update(attributes)
    return value


def pause_response():
    response = json_response(dict(code=CODE, error=MESSAGE), 503)
    response.headers['Retry-After'] = '30'
    return response


def profile_writes_paused(store):
    try: (store.bundle/'.pause-profile-writes').stat()
    except FileNotFoundError: return False
    except OSError: return True
    return True


def create_app(bundle, origin):
    origin = origin.rstrip('/')
    parsed = urlsplit(origin)
    if parsed.scheme not in {'https', 'http'} or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Invalid recovery origin')
    store = RecoveryStore(bundle)
    access = existing(WebAccess, store, origin=origin)
    profiles = existing(Profiles, store)
    management = existing(Management, store)
    router = Routes()
    api = RouteAPI(router, write_paused=lambda: profile_writes_paused(store))

    def authorize(request):
        # Recovery never accepts a bearer Profile/device grant, including one
        # valid in the full service. Only the owner's existing website cookie.
        current = access.session(request)
        if not current or not current['approved']: return False
        if request.method != 'GET' and request.headers.get('origin') != origin:
            return json_response({'error': 'Invalid origin'}, 403)
        return True

    register_profile_routes(api, profiles, authorize)

    @api.route('/api/manage/state', ['GET', 'POST'], authorize, StateRequest, max_bytes=24*1024*1024)
    async def state(request, payload, principal):
        if request.method == 'GET': return management.snapshot()
        if any(not writable_document(item.get('key')) for item in payload.changes):
            return pause_response()
        for item in payload.changes:
            if item['key'].startswith('jobsResponses:'):
                try: profiles.get(item['key'].split(':',1)[1], include_attachment=False)
                except KeyError: return json_response({'error':'Profile unavailable'},409)
        return management.write(payload.changes)

    @router.custom_route('/api/session', ['GET', 'DELETE'])
    async def session(request):
        current = access.session(request)
        if request.method == 'DELETE':
            if request.headers.get('origin') != origin: return json_response({'error': 'Invalid origin'}, 403)
            if profile_writes_paused(store): return pause_response()
            if current:
                with store.connect(True) as db: db.execute('DELETE FROM web_sessions WHERE hash=?', (current['hash'],))
            response = json_response({'ok': True}); response.delete_cookie(COOKIE, path='/'); return response
        if current:
            return json_response(dict(authenticated=bool(current['approved']), request_id=current['request_id'], recovery=dict(mode=MODE, applicationWrites='paused')))
        if profile_writes_paused(store): return pause_response()
        now = time.time()
        with store.connect(True) as db:
            db.execute('DELETE FROM web_sessions WHERE expires<?', (now,))
            if db.execute('SELECT count(*) FROM web_sessions WHERE created>?', (now-3600,)).fetchone()[0] >= 100:
                return json_response({'error': 'Too many sign-in requests'}, 429)
            token, request_id = secrets.token_urlsafe(40), secrets.token_hex(12)
            db.execute('INSERT INTO web_sessions VALUES(?,?,?,?,0)', (hashlib.sha256(token.encode()).hexdigest(), request_id, now, now+900))
        response = json_response(dict(authenticated=False, request_id=request_id, recovery=dict(mode=MODE, applicationWrites='paused')))
        response.set_cookie(COOKIE, token, max_age=30*86400, httponly=True, secure=parsed.scheme=='https', samesite='lax', path='/')
        return response

    @router.custom_route('/healthz', ['GET'])
    async def health(request):
        return json_response(dict(status='ok', mode=MODE, applicationWrites='paused', release=store.report['release']))

    @router.custom_route('/', ['GET'])
    async def home(request): return RedirectResponse('/manage/#/profile', status_code=307)

    @router.custom_route('/manage', ['GET'])
    async def redirect(request): return RedirectResponse('/manage/#/profile', status_code=307)

    @router.custom_route('/manage/', ['GET'])
    async def webpage(request):
        html = (STATIC/'manage/index.html').read_text(encoding='utf-8')
        banner = '<aside role="status" style="position:sticky;top:0;z-index:9999;background:#fff4cc;color:#382b00;padding:12px;text-align:center">' + MESSAGE + '</aside>'
        return HTMLResponse(html.replace('<body>', '<body>'+banner, 1), headers={
            'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
            'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"})

    @router.custom_route('/assets/{name}', ['GET'])
    async def asset(request):
        name = request.path_params['name']
        if name not in {'board.js','board.css'}: return pause_response()
        return FileResponse(STATIC/name, headers={'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'})

    @router.custom_route('/{path:path}', ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE','CONNECT'])
    async def unavailable(request): return pause_response()

    @asynccontextmanager
    async def lifespan(app):
        with service_lock(store.bundle):
            yield
    app = Starlette(routes=router.routes, lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[parsed.hostname, '127.0.0.1', 'localhost'])
    app.state.recovery_store = store
    return app


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--origin', default=os.environ.get('JOBS_ORIGIN', 'https://jobs.siyidu.com'))
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('serve')
    approve = commands.add_parser('approve-web'); approve.add_argument('request_id')
    args = parser.parse_args()
    if args.command == 'approve-web':
        store = RecoveryStore(args.bundle)
        if profile_writes_paused(store): raise RuntimeError('Profile writes are paused for recovery export')
        existing(WebAccess, store, origin=args.origin).approve(args.request_id)
        print('{"approved":true}')
    else:
        import uvicorn
        uvicorn.run(create_app(args.bundle, args.origin), host=os.environ.get('JOBS_HOST','127.0.0.1'),
                    port=int(os.environ.get('JOBS_PORT','8796')), access_log=False, log_level='warning', proxy_headers=False)


if __name__ == '__main__': main()
