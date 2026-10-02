"""Same-origin private browser access; no application data on public routes."""
import hashlib
import os
import secrets
import time
from pathlib import Path

from starlette.responses import FileResponse, JSONResponse, RedirectResponse
from .board import Board
from .recruiting import Recruiting
from .extension_sync import ExtensionSync
from .profiles import Profiles, ProfileConflict
from .management import Management
from .answers import Answers
from .http_routes import RouteAPI, RequestModel, json_response
from typing import Any, Literal


class DiagnosticRequest(RequestModel):
    protocolVersion: Literal[1]
    history: list[dict[str, Any]]


class ControlRequest(RequestModel):
    protocolVersion: Literal[2]
    sessionId: str
    inventory: list[dict[str, Any]]
    pages: list[dict[str, Any]]
    results: list[dict[str, Any]]

STATIC = Path(__file__).with_name('static')
COOKIE = 'radar_browser'

class WebAccess:
    def __init__(self, store, origin):
        self.store, self.origin = store, origin.rstrip('/')
        with store.connect() as c:
            c.execute('CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,request_id TEXT UNIQUE,created REAL,expires REAL,approved INTEGER DEFAULT 0)')

    def session(self, request):
        token=request.cookies.get(COOKIE,'')
        with self.store.connect() as c:
            return c.execute('SELECT * FROM web_sessions WHERE hash=? AND expires>?',(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone()

    def approve(self, request_id):
        with self.store.connect(True) as c:
            row=c.execute('SELECT * FROM web_sessions WHERE request_id=? AND expires>? AND approved=0',(request_id,time.time())).fetchone()
            if not row: raise ValueError('Browser request missing or expired')
            c.execute('UPDATE web_sessions SET approved=1,expires=? WHERE request_id=?',(time.time()+30*86400,request_id))
            c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('web_login','owner',?,?)",(time.time(),request_id))
        return {'approved':True,'request_id':request_id}

def attach_web(server, store, origin):
    from .web_bundles import WebBundles
    bundles = WebBundles(STATIC, os.environ.get('JOBS_WEB_ROOT'))
    access, board = WebAccess(store,origin), Board(store)
    extension = ExtensionSync(store)
    profiles = Profiles(store)
    management = Management(store)
    from .application_progress import ApplicationProgress
    application_progress = ApplicationProgress(store)
    answers = Answers(store)
    from .answer_jobs import AnswerJobs
    answer_jobs = AnswerJobs(store, answers)
    api = RouteAPI(server)
    from .browser_history import Diagnostics
    diagnostics = Diagnostics(store)
    def profile_access(request):
        auth = request.headers.get('authorization', '')
        return profiles.authenticate(auth[7:] if auth.startswith('Bearer ') else '')

    @api.route('/api/extension/diagnostics', ['POST'], profile_access, DiagnosticRequest, max_bytes=2 * 1024 * 1024)
    async def extension_diagnostics(request, payload, device):
        return diagnostics.receive(device, payload.model_dump())
    def response(value,status=200):
        r=JSONResponse(value,status_code=status)
        r.headers['Cache-Control']='no-store'
        return r

    def management_access(request):
        auth=request.headers.get('authorization','')
        if auth.startswith('Bearer '):
            return bool(profiles.authenticate(auth[7:]))
        current=access.session(request)
        if not current or not current['approved']: return False
        if request.method != 'GET' and request.headers.get('origin') != origin:
            return json_response({'error': 'Invalid origin'}, 403)
        return True

    from .web_inputs import (ProgressRequest, ApplicationRequest, StateRequest, PairRequest,
        DeviceRequest, ResolveRequest, ReceiptRequest, AnswerJobRequest, BoardAction)
    from .application_records import ApplicationRecords
    records = ApplicationRecords(store)
    from .profile_routes import register_profile_routes
    register_profile_routes(api, profiles, management_access)
    register_profile_routes(api, profiles, profile_access, prefix='/api/extension/profiles')
    from .storage_migrations import StorageMigrations
    from .storage_migration_routes import register_storage_migration_routes
    register_storage_migration_routes(api, StorageMigrations(store, profiles, management), profile_access)
    from .client_protocol import register_retired_routes, upgrade_required
    register_retired_routes(api, management_access)

    @api.route('/api/manage/applications', ['GET', 'POST'], management_access, ApplicationRequest)
    async def management_applications(request, payload, principal):
        if request.method == 'GET':
            return records.list()
        return records.mutate([change.model_dump(exclude_none=True) for change in payload.changes], payload.idempotency_key)

    @api.route('/api/manage/progress', ['GET', 'POST'], management_access, ProgressRequest, max_bytes=8000)
    async def management_progress(request, payload, principal):
        if request.method == 'GET':
            return application_progress.list(application_id=request.query_params.get('application_id'))
        return application_progress.update(**payload.model_dump(exclude_unset=True), source='web-owner')

    from .browser_control import BrowserControl, MAX_BODY, enabled as control_enabled, observable as control_observable
    if control_observable():
        control = BrowserControl(store, allow_commands=control_enabled())

        @api.route('/api/extension/control', ['POST'], profile_access, ControlRequest, max_bytes=MAX_BODY)
        async def extension_control(request, payload, device):
            return control.exchange(device, payload.model_dump())

    @api.route('/api/manage/answer/jobs', ['GET', 'POST'], management_access, AnswerJobRequest)
    async def management_answer_jobs(request, payload, principal):
        if request.method == 'GET':
            return answer_jobs.status(request.query_params.get('id', ''))
        return json_response(answer_jobs.start(payload.model_dump(exclude_none=True)), 202)

    @api.route('/api/manage/state', ['GET', 'POST'], management_access, StateRequest, max_bytes=24*1024*1024)
    async def management_state(request, payload, principal):
        if payload and any(change.get('key') == 'appliedList' for change in payload.changes):
            return upgrade_required()
        return management.snapshot() if request.method == 'GET' else management.write(payload.changes)

    @server.custom_route('/api/session',methods=['GET','DELETE'])
    async def session(request):
        current=access.session(request)
        if request.method=='DELETE':
            if request.headers.get('origin')!=origin: return response({'error':'Invalid origin'},403)
            if current:
                with store.connect(True) as c: c.execute('DELETE FROM web_sessions WHERE hash=?',(current['hash'],))
            r=response({'ok':True}); r.delete_cookie(COOKIE,path='/'); return r
        if current:
            return response({'authenticated':bool(current['approved']),'request_id':current['request_id']})
        now=time.time()
        with store.connect(True) as c:
            c.execute('DELETE FROM web_sessions WHERE expires<?',(now,))
            if c.execute('SELECT count(*) FROM web_sessions WHERE created>?',(now-3600,)).fetchone()[0]>=100:
                return response({'error':'Too many sign-in requests; try again later'},429)
            token, rid = secrets.token_urlsafe(40), secrets.token_hex(12)
            c.execute('INSERT INTO web_sessions VALUES(?,?,?,?,0)',(hashlib.sha256(token.encode()).hexdigest(),rid,now,now+900))
        r=response({'authenticated':False,'request_id':rid})
        r.set_cookie(COOKIE,token,max_age=30*86400,httponly=True,secure=origin.startswith('https:'),samesite='lax',path='/')
        return r

    def owner_write(request):
        current = access.session(request)
        if not current or not current['approved']:
            return False
        if request.headers.get('origin') != origin:
            return json_response({'error': 'Invalid origin'}, 403)
        return True

    def receipt_access(request):
        auth = request.headers.get('authorization', '')
        return extension.authenticate(auth[7:] if auth.startswith('Bearer ') else '')

    from .job_title_routes import register_job_title_routes
    register_job_title_routes(api,store,receipt_access)

    @api.route('/api/extension/connect', ['POST'], owner_write, PairRequest, max_bytes=1000)
    async def extension_connect(request, payload, principal):
        paired = extension.pair(payload.device_id, payload.extension_id)
        if payload.profiles:
            paired['profile_token'] = profiles.grant(payload.device_id)
        return paired

    @api.route('/api/extension/events', ['POST'], receipt_access, ReceiptRequest, max_bytes=8000)
    async def extension_event(request, payload, device):
        return extension.receive(device, payload.model_dump(exclude_none=True))

    @api.route('/api/extension/resolve', ['POST'], receipt_access, ResolveRequest, max_bytes=4000)
    async def extension_resolve(request, payload, device):
        return extension.resolve(payload.model_dump(exclude_none=True))

    @api.route('/api/extension/disconnect', ['POST'], owner_write, DeviceRequest, max_bytes=1000)
    async def extension_disconnect(request, payload, principal):
        return extension.disconnect(payload.device_id)

    @server.custom_route('/api/extension/status',methods=['GET'])
    async def extension_status(request):
        current=access.session(request)
        if not current or not current['approved']: return response({'error':'Sign in first'},401)
        return response(extension.status())

    @server.custom_route('/api/jobs',methods=['GET'])
    async def jobs(request):
        current=access.session(request)
        if not current or not current['approved']: return response({'error':'Sign in first'},401)
        try:
            p=dict(request.query_params)
            p['page']=int(p.get('page',1));p['page_size']=int(p.get('page_size',50))
            for key in ('added_since','added_before'):
                if key in p: p[key]=float(p[key]) if p[key] else None
            return response(board.list(**p))
        except (ValueError,TypeError) as e: return response({'error':str(e)},400)

    @server.custom_route('/api/filter-counts',methods=['GET'])
    async def filter_counts(request):
        current=access.session(request)
        if not current or not current['approved']: return response({'error':'Sign in first'},401)
        try:
            p=dict(request.query_params)
            for key in ('added_since','added_before'):
                if key in p: p[key]=float(p[key]) if p[key] else None
            return response(board.filter_counts(**p))
        except (ValueError,TypeError) as e: return response({'error':str(e)},400)

    @server.custom_route('/api/application-overview',methods=['GET'])
    async def application_overview(request):
        current=access.session(request)
        if not current or not current['approved']: return response({'error':'Sign in first'},401)
        return response(Recruiting(store).overview())

    @api.route('/api/actions', ['POST'], owner_write, BoardAction, max_bytes=20000)
    async def actions(request, payload, principal):
        values = payload.model_dump(exclude_none=True)
        action = values.pop('action')
        if action == 'review':
            return board.review(**values, actor='web-owner')
        return {'submitted': board.mark_submitted, 'undo_submitted': board.undo_submitted,
                'opened': board.opened}[action](**values)

    @server.custom_route('/assets/{name}',methods=['GET'])
    async def assets(request):
        name=request.path_params['name']
        try:
            target, immutable = bundles.asset(name, request.query_params.get('v'))
        except (ValueError, OSError):
            return response({'error':'Not found'},404)
        return FileResponse(target,headers={'Cache-Control':'public, max-age=31536000, immutable' if immutable else 'no-cache','X-Content-Type-Options':'nosniff'})

    @server.custom_route('/.well-known/jobs-web-release', methods=['GET'])
    async def web_release_status(request):
        try:
            return response(bundles.status())
        except (ValueError, OSError):
            return response({'error':'Website release needs repair'},503)

    async def shell(request):
        try:
            root, _ = bundles.active()
        except (ValueError, OSError):
            return response({'error':'Website release needs repair'},503)
        return FileResponse(root/'index.html',headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
            'X-Content-Type-Options':'nosniff',
            'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
    for path in ['/', '/full-time', '/internships', '/trash']:
        server.custom_route(path,methods=['GET'])(shell)

    @server.custom_route('/manage',methods=['GET'])
    async def manage_redirect(request):
        return RedirectResponse('/manage/',status_code=307)

    @server.custom_route('/manage/{name:path}',methods=['GET'])
    async def manage_asset(request):
        name=request.path_params.get('name') or 'index.html'
        try:
            root=(bundles.active()[0]/'manage').resolve()
        except (ValueError, OSError):
            return response({'error':'Website release needs repair'},503)
        target=(root/name).resolve()
        if root not in target.parents or not target.is_file(): return response({'error':'Not found'},404)
        if target.suffix not in {'.html','.js','.css','.svg','.png','.woff2'}: return response({'error':'Not found'},404)
        return FileResponse(target,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
            'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"})
    return access
