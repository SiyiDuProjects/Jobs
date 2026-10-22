"""Same-origin private browser access; no application data on public routes."""
import hashlib
import json
import ipaddress
import os
import secrets
import time
from pathlib import Path
from functools import wraps
from .async_work import run_sync, worker

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
            c.execute('CREATE TABLE IF NOT EXISTS web_session_limits(client TEXT PRIMARY KEY,started REAL,count INTEGER)')

    def allow_new_session(self, request, connection, now):
        peer = request.client.host if request.client else 'unknown'
        # Enabled only for the loopback-published deployment behind Cloudflare
        # Tunnel; public callers cannot reach this listener directly.
        if os.environ.get('JOBS_TRUST_SESSION_PROXY') == '1':
            forwarded = request.headers.get('cf-connecting-ip', '').strip()
            try:
                peer = str(ipaddress.ip_address(forwarded))
            except ValueError:
                pass
        key = hashlib.sha256(peer.encode()).hexdigest()
        connection.execute('DELETE FROM web_session_limits WHERE started<=?', (now - 900,))
        row = connection.execute('SELECT count FROM web_session_limits WHERE client=?', (key,)).fetchone()
        if row and row['count'] >= 20:
            return False
        connection.execute('INSERT INTO web_session_limits VALUES(?,?,1) ON CONFLICT(client) DO UPDATE SET count=count+1', (key, now))
        return True

    def session(self, request):
        token=request.cookies.get(COOKIE,'')
        with self.store.connect(read_only=True) as c:
            return c.execute('SELECT * FROM web_sessions WHERE hash=? AND expires>?',(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone()

    def authorize(self, request, *, write=False):
        current = self.session(request)
        if not current or not current['approved']:
            return False
        if write and request.headers.get('origin') != self.origin:
            return json_response({'error': 'Invalid origin'}, 403)
        return True

    def approve(self, request_id):
        with self.store.connect(True) as c:
            row=c.execute('SELECT * FROM web_sessions WHERE request_id=? AND expires>? AND approved=0',(request_id,time.time())).fetchone()
            if not row: raise ValueError('Browser request missing or expired')
            c.execute('UPDATE web_sessions SET approved=1,expires=? WHERE request_id=?',(time.time()+30*86400,request_id))
            c.execute("INSERT INTO audit(event,actor,created,payload) VALUES('web_login','owner',?,?)",(time.time(),request_id))
        return {'approved':True,'request_id':request_id}

def attach_web(server, store, origin, *, board=None, recruiting=None, application_progress=None):
    from .web_bundles import WebBundles
    bundles = WebBundles(STATIC, os.environ.get('JOBS_WEB_ROOT'))
    access = WebAccess(store,origin)
    board = board if board is not None else Board(store)
    recruiting = recruiting if recruiting is not None else Recruiting(store)
    extension = ExtensionSync(store)
    profiles = Profiles(store)
    management = Management(store)
    from .application_progress import ApplicationProgress
    application_progress = application_progress if application_progress is not None else ApplicationProgress(store)
    answers = Answers(store)
    from .answer_jobs import AnswerJobs
    answer_jobs = AnswerJobs(store, answers)
    api = RouteAPI(server)
    from .event_log import Diagnostics
    diagnostics = Diagnostics(store)
    def profile_access(request):
        auth = request.headers.get('authorization', '')
        return profiles.authenticate(auth[7:] if auth.startswith('Bearer ') else '')

    @api.route('/api/extension/diagnostics', ['POST'], profile_access, DiagnosticRequest, max_bytes=2 * 1024 * 1024)
    def extension_diagnostics(request, payload, device):
        return diagnostics.receive(device, payload.model_dump())
    def response(value,status=200):
        r=JSONResponse(value,status_code=status)
        r.headers['Cache-Control']='no-store'
        return r

    def browser_read(handler):
        @wraps(handler)
        def authorized(request):
            if not access.authorize(request):
                return response({'error':'Sign in first'},401)
            return handler(request)
        return authorized

    def management_access(request):
        auth=request.headers.get('authorization','')
        if auth.startswith('Bearer '):
            return bool(profiles.authenticate(auth[7:]))
        return access.authorize(request, write=request.method != 'GET')

    from .question_corpus import register_corpus_routes
    register_corpus_routes(api, store, management_access)

    from .web_inputs import (ProgressReviewRequest, ProgressRequest, ApplicationRequest, StateRequest, PairRequest,
        DeviceRequest, ResolveRequest, ReceiptRequest, AnswerJobRequest, BoardAction)
    from .application_records import ApplicationRecords
    records = ApplicationRecords(store)
    from .profile_routes import register_profile_routes
    register_profile_routes(api, profiles, management_access)
    register_profile_routes(api, profiles, profile_access, prefix='/api/extension/profiles')
    from .client_protocol import register_retired_routes, upgrade_required
    register_retired_routes(api, management_access)

    @api.route('/api/manage/applications', ['GET', 'POST'], management_access, ApplicationRequest)
    def management_applications(request, payload, principal):
        if request.method == 'GET':
            return records.list()
        return records.mutate([change.model_dump(exclude_none=True) for change in payload.changes], payload.idempotency_key)

    @api.route('/api/manage/progress', ['GET', 'POST'], management_access, ProgressRequest, max_bytes=8000)
    def management_progress(request, payload, principal):
        if request.method == 'GET':
            return application_progress.list(application_id=request.query_params.get('application_id'))
        return application_progress.update(**payload.model_dump(exclude_unset=True), source='web-owner')

    @api.route('/api/manage/progress-review', ['POST'], management_access, ProgressReviewRequest, max_bytes=2000)
    def management_progress_review(request, payload, principal):
        return application_progress.resolve_review(**payload.model_dump())

    from .browser_control import BrowserControl, MAX_BODY, enabled as control_enabled, observable as control_observable
    if control_observable():
        control = BrowserControl(store, allow_commands=control_enabled())

        @api.route('/api/extension/control', ['POST'], profile_access, ControlRequest, max_bytes=MAX_BODY)
        def extension_control(request, payload, device):
            try:
                return control.exchange(device, payload.model_dump())
            except ValueError as error:
                import logging
                # Errors here are fixed protocol messages, not form values or credentials.
                logging.getLogger(__name__).warning('control_exchange_rejected session_hash=%s reason=%s',
                    hashlib.sha256(payload.sessionId.encode()).hexdigest()[:12], str(error))
                raise

    @api.route('/api/manage/answer/jobs', ['GET', 'POST'], management_access, AnswerJobRequest)
    async def management_answer_jobs(request, payload, principal):
        if request.method == 'GET':
            return await run_sync(answer_jobs.status, request.query_params.get('id', ''))
        return json_response(await answer_jobs.start_async(payload.model_dump(exclude_none=True)), 202)

    @api.route('/api/manage/state', ['GET', 'POST'], management_access, StateRequest, max_bytes=24*1024*1024)
    def management_state(request, payload, principal):
        if payload and any(change.get('key') == 'appliedList' for change in payload.changes):
            return upgrade_required()
        if request.method == 'GET':
            return management.snapshot(include_applications=request.query_params.get('applications')!='0',
                keys=request.query_params['keys'].split(',') if 'keys' in request.query_params else None,
                revisions=json.loads(request.query_params['since']) if 'since' in request.query_params else None)
        return management.write(payload.changes, include_applications=request.query_params.get('applications')!='0')

    @server.custom_route('/api/session',methods=['GET','DELETE'])
    @worker
    def session(request):
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
            if not access.allow_new_session(request, c, now):
                return response({'error':'Too many sign-in requests; try again later'},429)
            token, rid = secrets.token_urlsafe(40), secrets.token_hex(12)
            c.execute('INSERT INTO web_sessions VALUES(?,?,?,?,0)',(hashlib.sha256(token.encode()).hexdigest(),rid,now,now+900))
        r=response({'authenticated':False,'request_id':rid})
        r.set_cookie(COOKIE,token,max_age=30*86400,httponly=True,secure=origin.startswith('https:'),samesite='lax',path='/')
        return r

    def owner_write(request):
        return access.authorize(request, write=True)

    def receipt_access(request):
        auth = request.headers.get('authorization', '')
        return extension.authenticate(auth[7:] if auth.startswith('Bearer ') else '')

    from .job_title_routes import register_job_title_routes
    register_job_title_routes(api,store,receipt_access)

    @api.route('/api/extension/connect', ['POST'], owner_write, PairRequest, max_bytes=1000)
    def extension_connect(request, payload, principal):
        paired = extension.pair(payload.device_id, payload.extension_id)
        if payload.profiles:
            paired['profile_token'] = profiles.grant(payload.device_id)
        return paired

    @api.route('/api/extension/events', ['POST'], receipt_access, ReceiptRequest, max_bytes=8000)
    def extension_event(request, payload, device):
        return extension.receive(device, payload.model_dump(exclude_none=True))

    @api.route('/api/extension/resolve', ['POST'], receipt_access, ResolveRequest, max_bytes=4000)
    def extension_resolve(request, payload, device):
        return extension.resolve(payload.model_dump(exclude_none=True))

    @api.route('/api/extension/disconnect', ['POST'], owner_write, DeviceRequest, max_bytes=1000)
    def extension_disconnect(request, payload, principal):
        return extension.disconnect(payload.device_id)

    @server.custom_route('/api/extension/status',methods=['GET'])
    @worker
    @browser_read
    def extension_status(request):
        return response(extension.status())

    @server.custom_route('/api/jobs',methods=['GET'])
    @worker
    @browser_read
    def jobs(request):
        try:
            p=dict(request.query_params)
            p['page']=int(p.get('page',1));p['page_size']=int(p.get('page_size',50))
            for key in ('added_since','added_before'):
                if key in p: p[key]=float(p[key]) if p[key] else None
            return response(board.list(**p))
        except (ValueError,TypeError) as e: return response({'error':str(e)},400)

    @server.custom_route('/api/filter-counts',methods=['GET'])
    @worker
    @browser_read
    def filter_counts(request):
        try:
            p=dict(request.query_params)
            for key in ('added_since','added_before'):
                if key in p: p[key]=float(p[key]) if p[key] else None
            return response(board.filter_counts(**p))
        except (ValueError,TypeError) as e: return response({'error':str(e)},400)

    @server.custom_route('/api/application-counts',methods=['GET'])
    @worker
    @browser_read
    def application_counts(request):
        try:
            from .application_records import counts
            today=float(request.query_params.get('today',''))
            week=float(request.query_params.get('week',''))
            return response(counts(store,today,week,request.query_params.get('kind')))
        except (ValueError,TypeError) as e: return response({'error':str(e)},400)

    @server.custom_route('/api/application-overview',methods=['GET'])
    @worker
    @browser_read
    def application_overview(request):
        return response(recruiting.overview())

    @api.route('/api/actions', ['POST'], owner_write, BoardAction, max_bytes=20000)
    def actions(request, payload, principal):
        values = payload.model_dump(exclude_none=True)
        action = values.pop('action')
        if action == 'review':
            return board.review(**values, actor='web-owner')
        return {'submitted': board.mark_submitted, 'undo_submitted': board.undo_submitted}[action](**values)

    @server.custom_route('/assets/{name:path}',methods=['GET'])
    @worker
    def assets(request):
        name=request.path_params['name']
        try:
            target, immutable = bundles.asset(name, request.query_params.get('v'))
        except (ValueError, OSError):
            return response({'error':'Not found'},404)
        return FileResponse(target,headers={'Cache-Control':'public, max-age=31536000, immutable' if immutable else 'no-cache','X-Content-Type-Options':'nosniff'})

    @server.custom_route('/.well-known/jobs-web-release', methods=['GET'])
    @worker
    def web_release_status(request):
        try:
            return response(bundles.status())
        except (ValueError, OSError):
            return response({'error':'Website release needs repair'},503)

    @worker
    def shell(request):
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
    @worker
    def manage_asset(request):
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
