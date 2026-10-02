"""Opt-in browser commands. Delivery is at most once; execution is never inferred.

This module has no scheduler, model calls, browser-opening or generic script API.
Only the authenticated extension can report the ATS documents it already owns.
"""
import hashlib
import json
import os
import re
import time
import uuid
from urllib.parse import parse_qsl, urlsplit

from .store import encoded
from . import browser_history


ACTIONS = {'inspect', 'autofill', 'fill_answers', 'answer_review', 'confirm_review', 'next', 'submit'}
MAX_BODY = 8 * 1024 * 1024
MAX_OPTIONS = 5000
FRESH_MS = 30_000
MAX_PAGES = 64


def enabled():
    return os.environ.get('JOBS_BROWSER_CONTROL_ENABLED') == '1'


def observable():
    return enabled() or os.environ.get('JOBS_BROWSER_OBSERVE_ENABLED') == '1'


class ControlConflict(ValueError):
    pass


def shape(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError('Invalid browser control shape')
    return value


def text(value, limit=200, *, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()) or '\x00' in value:
        raise ValueError('Invalid browser control text')
    # Never store obvious credential material, even when mislabeled as a title.
    if re.search(r'\b(?:Bearer\s+\S{8,}|sk-(?:proj-)?[\w-]{16,})', value, re.I):
        raise ValueError('Credentials are not browser control data')
    return value


def integer(value, maximum=2**53 - 1, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Invalid browser control integer')
    return value


def boolean(value):
    if type(value) is not bool:
        raise ValueError('Invalid browser control boolean')
    return value


def sequence(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError('Invalid browser control list')
    return value


def safe_url(value):
    from .public_job_url import SENSITIVE, posting_token
    text(value, 3000)
    try:
        parsed = urlsplit(value)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError('Only credential-free HTTPS page URLs are allowed')
        for key, part in parse_qsl(parsed.query, keep_blank_values=True) + parse_qsl(parsed.fragment, keep_blank_values=True):
            if SENSITIVE.search(key) and not posting_token(parsed.hostname, key, part):
                raise ValueError('Credential-bearing page URL')
    except (TypeError, ValueError) as error:
        raise ValueError('Invalid or credential-bearing page URL') from error
    return value


def answer_value(value):
    if isinstance(value, str):
        return text(value, 8000, empty=True)
    if type(value) is bool:
        return value
    return [text(v, 2000, empty=True) for v in sequence(value, 100)]


def field(value):
    shape(value, ('id', 'question', 'type', 'required', 'filled', 'invalid', 'supported'), ('options', 'value'))
    result = {key: text(value[key], 128 if key == 'id' else 2000 if key == 'question' else 40, empty=key == 'question')
              for key in ('id', 'question', 'type')}
    if value['type'] in {'password', 'hidden'}:
        raise ValueError('Private fields must not be reported')
    result.update({key: boolean(value[key]) for key in ('required', 'filled', 'invalid', 'supported')})
    if 'options' in value:
        result['options'] = []
        for option in sequence(value['options'], MAX_OPTIONS):
            shape(option, ('value', 'label'))
            result['options'].append({key: text(option[key], 2000, empty=True) for key in ('value', 'label')})
    if 'value' in value:
        if value['type'] == 'file':
            raise ValueError('File contents must not be reported')
        result['value'] = answer_value(value['value'])
    return result


def target(value):
    shape(value, ('tabId', 'frameId', 'documentId', 'revision'))
    return {'tabId': integer(value['tabId']), 'frameId': integer(value['frameId']),
            'documentId': text(value['documentId'], 128), 'revision': integer(value['revision'])}


def inventory_item(value):
    shape(value, ('tabId', 'frameId', 'documentId'), ('browserDocumentId',))
    result = {'tabId': integer(value['tabId']), 'frameId': integer(value['frameId']),
              'documentId': text(value['documentId'], 128)}
    if 'browserDocumentId' in value:
        result['browserDocumentId'] = text(value['browserDocumentId'], 128)
    return result


def document_key(value):
    return value['tabId'], value['frameId'], value['documentId']


def page(value, now):
    shape(value, ('tabId', 'frameId', 'documentId', 'revision', 'url', 'title', 'profileId', 'profileName',
                  'ats', 'phase', 'visibility', 'coverage', 'fields', 'counts', 'actions', 'observedAt'), ('events', 'review'))
    result = target({key: value[key] for key in ('tabId', 'frameId', 'documentId', 'revision')})
    result.update(url=safe_url(value['url']), title=text(value['title'], 500, empty=True),
                  profileId=None if value['profileId'] is None else text(value['profileId'], 128),
                  profileName=text(value['profileName'], 200, empty=True), ats=text(value['ats'], 80),
                  phase=text(value['phase'], 80), visibility=text(value['visibility'], 30), coverage=value['coverage'],
                  observedAt=integer(value['observedAt'], now + 60_000, 1))
    if value['coverage'] != 'partial' or value['visibility'] not in ('visible', 'hidden', 'unknown'):
        raise ValueError('Unsupported page coverage or visibility')
    result['fields'] = [field(v) for v in sequence(value['fields'], 200)]
    if len({v['id'] for v in result['fields']}) != len(result['fields']):
        raise ValueError('Duplicate field IDs')
    shape(value['counts'], ('total', 'unfilled', 'unsupported'))
    result['counts'] = {key: integer(value['counts'][key], 10000) for key in ('total', 'unfilled', 'unsupported')}
    if any(result['counts'][key] > result['counts']['total'] for key in ('unfilled', 'unsupported')):
        raise ValueError('Invalid field counts')
    result['actions'] = sequence(value['actions'], len(ACTIONS))
    if any(not isinstance(v, str) or v not in ACTIONS for v in result['actions']) or len(set(result['actions'])) != len(result['actions']):
        raise ValueError('Unsupported browser action')
    if 'review' in value:
        review = shape(value['review'], ('id', 'ready', 'action', 'items'))
        if review['action'] not in ('fill', 'next', 'submit'):
            raise ValueError('Invalid review continuation')
        items = []
        for item in sequence(review['items'], 200):
            shape(item, ('itemId', 'fieldId', 'version'))
            items.append({'itemId': text(item['itemId'], 128), 'fieldId': text(item['fieldId'], 128, empty=True), 'version': integer(item['version'])})
        if len({item['itemId'] for item in items}) != len(items):
            raise ValueError('Duplicate review item')
        result['review'] = {'id': text(review['id'], 128), 'ready': boolean(review['ready']), 'action': review['action'], 'items': items}
    if 'events' in value:
        result['events'] = []
        for event in sequence(value['events'], 50):
            shape(event, ('at', 'type'), ('fieldId', 'detail'))
            item = {'at': integer(event['at'], now + 60_000), 'type': text(event['type'], 80)}
            for key in ('fieldId', 'detail'):
                if key in event:
                    item[key] = text(event[key], 300, empty=True)
            result['events'].append(item)
    return result


def command_result(value):
    shape(value, ('id', 'state'), ('data', 'error'))
    result = {'id': text(value['id'], 128), 'state': value['state']}
    if value['state'] not in ('completed', 'failed', 'unknown'):
        raise ValueError('Invalid command result state')
    if 'error' in value:
        result['error'] = text(value['error'], 1000, empty=True)
    if 'data' in value:
        data = shape(value['data'], (), ('action', 'phase', 'appliedFieldIds', 'failedFieldIds', 'evidence'))
        result['data'] = {}
        for key in ('action', 'phase'):
            if key in data:
                result['data'][key] = text(data[key], 80)
        if 'action' in data and data['action'] not in ACTIONS:
            raise ValueError('Invalid result action')
        for key in ('appliedFieldIds', 'failedFieldIds'):
            if key in data:
                result['data'][key] = [text(v, 128) for v in sequence(data[key], 200)]
        if 'evidence' in data:
            evidence = shape(data['evidence'], ('type', 'text'), ('url',))
            if evidence['type'] not in ('none', 'navigation', 'validation_error', 'official_success'):
                raise ValueError('Invalid evidence type')
            result['data']['evidence'] = {'type': evidence['type'], 'text': text(evidence['text'], 2000, empty=True)}
            if 'url' in evidence:
                result['data']['evidence']['url'] = safe_url(evidence['url'])
    return result


class BrowserControl:
    def __init__(self, store, clock=None, *, allow_commands=True):
        self.store, self.clock = store, clock or (lambda: int(time.time() * 1000))
        self.allow_commands = allow_commands
        with store.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS browser_control_sessions(device TEXT,session TEXT,active INTEGER,seen INTEGER,pages TEXT,
                PRIMARY KEY(device,session));
              CREATE UNIQUE INDEX IF NOT EXISTS browser_control_active ON browser_control_sessions(device) WHERE active=1;
              CREATE TABLE IF NOT EXISTS browser_control_commands(id TEXT PRIMARY KEY,device TEXT,session TEXT,tab INTEGER,frame INTEGER,
                document TEXT,revision INTEGER,action TEXT,args TEXT,hash TEXT,state TEXT,created INTEGER,expires INTEGER,
                dispatched INTEGER,result TEXT);
              CREATE INDEX IF NOT EXISTS browser_control_pending ON browser_control_commands(device,session,tab,state);
              CREATE TABLE IF NOT EXISTS browser_control_inventory(device TEXT,session TEXT,data TEXT,
                PRIMARY KEY(device,session));
              CREATE TABLE IF NOT EXISTS browser_snapshot_requests(device TEXT,session TEXT,tab INTEGER,frame INTEGER,
                document TEXT,expires INTEGER,PRIMARY KEY(device,session,tab,frame,document));
            ''')
            browser_history.initialize(c)

    @staticmethod
    def _expire(c, now):
        c.execute("UPDATE browser_control_commands SET state='expired' WHERE state='queued' AND expires<=?", (now,))
        c.execute("UPDATE browser_control_commands SET state='unknown' WHERE state='dispatched' AND expires<=?", (now,))

    @staticmethod
    def _wire(row):
        return {'id': row['id'], 'sessionId': row['session'],
                'target': {'tabId': row['tab'], 'frameId': row['frame'], 'documentId': row['document'], 'revision': row['revision']},
                'action': row['action'], 'args': json.loads(row['args']), 'expiresAt': row['expires']}

    @classmethod
    def _status(cls, row):
        return {**cls._wire(row), 'deviceId': row['device'], 'state': row['state'],
                'createdAt': row['created'], 'dispatchedAt': row['dispatched'],
                'result': json.loads(row['result']) if row['result'] else None,
                'submissionConfirmed': False}

    def exchange(self, device, payload):
        shape(payload, ('protocolVersion', 'sessionId', 'inventory', 'pages', 'results'))
        if payload['protocolVersion'] != 2:
            raise ValueError('Update the extension: browser protocol version 2 is required')
        session = str(uuid.UUID(text(payload['sessionId'], 36)))
        if session != payload['sessionId']:
            raise ValueError('Invalid browser session ID')
        now = self.clock()
        inventory = [inventory_item(v) for v in sequence(payload['inventory'], MAX_PAGES)]
        if len({(p['tabId'], p['frameId']) for p in inventory}) != len(inventory):
            raise ValueError('Duplicate inventory page')
        active = {document_key(p) for p in inventory}
        pages = [page(v, now) for v in sequence(payload['pages'], MAX_PAGES)]
        uploaded = {document_key(p) for p in pages}
        if len({(p['tabId'], p['frameId']) for p in pages}) != len(pages):
            raise ValueError('Duplicate browser page')
        results = [command_result(v) for v in sequence(payload['results'], 64)]
        if not self.allow_commands:
            if results:
                raise ControlConflict('Remote execution is disabled')
            for item in pages:
                item['actions'] = ['inspect']
        with self.store.connect(True) as c:
            self._expire(c, now)
            c.execute('DELETE FROM browser_snapshot_requests WHERE expires<=?', (now,))
            c.execute("UPDATE browser_control_sessions SET pages='[]' WHERE seen<?", (now - 86400000,))
            current = c.execute('SELECT * FROM browser_control_sessions WHERE device=? AND session=?', (device, session)).fetchone()
            if current and not current['active']:
                raise ControlConflict('This browser session has ended')
            requested = {tuple(r) for r in c.execute(
                'SELECT tab,frame,document FROM browser_snapshot_requests WHERE device=? AND session=?', (device, session))}
            if any(document_key(p) not in requested or document_key(p) not in active for p in pages):
                raise ControlConflict('Page snapshot was not requested for this current document')
            cached = {document_key(p): p for p in json.loads(current['pages']) if document_key(p) in active} if current else {}
            cached.update({document_key(p): p for p in pages})
            for p in pages:
                c.execute('DELETE FROM browser_snapshot_requests WHERE device=? AND session=? AND tab=? AND frame=? AND document=?',
                          (device, session, *document_key(p)))
            pages = list(cached.values())
            if not current:
                c.execute('UPDATE browser_control_sessions SET active=0,pages=? WHERE device=? AND active=1', ('[]', device))
                c.execute('DELETE FROM browser_control_inventory WHERE device=?', (device,))
                c.execute('DELETE FROM browser_snapshot_requests WHERE device=?', (device,))
                c.execute("UPDATE browser_control_commands SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'unknown' END WHERE device=? AND state IN ('queued','dispatched')", (device,))
                c.execute('INSERT INTO browser_control_sessions VALUES(?,?,1,?,?)', (device, session, now, encoded(pages)))
            else:
                c.execute('UPDATE browser_control_sessions SET seen=?,pages=? WHERE device=? AND session=?', (now, encoded(pages), device, session))
            c.execute('INSERT OR REPLACE INTO browser_control_inventory VALUES(?,?,?)', (device, session, encoded(inventory)))
            for result in results:
                row = c.execute('SELECT * FROM browser_control_commands WHERE id=?', (result['id'],)).fetchone()
                if not row or row['device'] != device or row['session'] != session or row['dispatched'] is None:
                    raise ControlConflict('Result has no matching dispatched command')
                if result.get('data', {}).get('action', row['action']) != row['action']:
                    raise ControlConflict('Result action does not match command')
                if row['result'] and row['result'] != encoded(result):
                    raise ControlConflict('Conflicting command result')
                c.execute('UPDATE browser_control_commands SET state=?,result=? WHERE id=?', (result['state'], encoded(result), result['id']))
            commands = []
            for row in c.execute("SELECT * FROM browser_control_commands WHERE device=? AND session=? AND state='queued' ORDER BY created,id", (device, session)).fetchall() if self.allow_commands else []:
                command_document = (row['tab'], row['frame'], row['document'])
                if command_document not in active:
                    c.execute("UPDATE browser_control_commands SET state='cancelled' WHERE id=?", (row['id'],))
                    continue
                if command_document not in uploaded:
                    continue
                match = next((p for p in pages if all(p[key] == self._wire(row)['target'][key] for key in ('tabId', 'frameId', 'documentId', 'revision'))), None)
                if not match or now - match['observedAt'] > FRESH_MS or row['action'] not in match['actions']:
                    c.execute("UPDATE browser_control_commands SET state='cancelled' WHERE id=?", (row['id'],))
                    continue
                # Commit dispatch before returning. A lost HTTP response must never replay a click.
                c.execute("UPDATE browser_control_commands SET state='dispatched',dispatched=? WHERE id=?", (now, row['id']))
                commands.append(self._wire(row))
            requests = []
            for r in c.execute('SELECT tab,frame,document FROM browser_snapshot_requests WHERE device=? AND session=?', (device, session)):
                if tuple(r) in active:
                    requests.append({'tabId': r['tab'], 'frameId': r['frame'], 'documentId': r['document']})
        return {'enabled': True, 'protocolVersion': 2, 'commands': commands, 'snapshotRequests': requests}

    def history(self, application_id=None):
        if application_id is not None:
            text(application_id, 128)
        with self.store.connect() as c:
            return browser_history.read(c, application_id)

    def pages(self, device_id=None, session_id=None, page_target=None):
        now = self.clock()
        requested = None
        if any(v is not None for v in (device_id, session_id, page_target)):
            text(device_id, 128)
            text(session_id, 128)
            requested = inventory_item(page_target)
        with self.store.connect(True) as c:
            c.execute("UPDATE browser_control_sessions SET pages='[]' WHERE seen<?", (now - 86400000,))
            result, pending, inventories = [], [], []
            for row in c.execute('SELECT * FROM browser_control_sessions WHERE active=1 ORDER BY device'):
                if now - row['seen'] > 86400000:
                    continue
                inventory = c.execute('SELECT data FROM browser_control_inventory WHERE device=? AND session=?', (row['device'], row['session'])).fetchone()
                for p in json.loads(inventory['data']) if inventory else []:
                    inventories.append({**p, 'deviceId': row['device'], 'sessionId': row['session'], 'online': now - row['seen'] <= FRESH_MS})
                    if (requested and row['device'] == device_id and row['session'] == session_id
                            and document_key(p) == document_key(requested) and now - row['seen'] <= FRESH_MS):
                        c.execute('INSERT OR REPLACE INTO browser_snapshot_requests VALUES(?,?,?,?,?,?)',
                                  (row['device'], row['session'], *document_key(p), now + 120000))
                        pending.append({**p, 'deviceId': row['device'], 'sessionId': row['session']})
                for p in json.loads(row['pages']):
                    result.append({**p, 'deviceId': row['device'], 'sessionId': row['session'], 'lastSeen': row['seen'],
                                   'online': now - row['seen'] <= FRESH_MS,
                                   'fresh': now - row['seen'] <= FRESH_MS and now - p['observedAt'] <= FRESH_MS})
            if requested and not pending:
                raise ControlConflict('Requested document is missing or the browser is offline')
        return {'enabled': True, 'executionEnabled': self.allow_commands, 'inventory': inventories, 'pages': result, 'snapshotPending': pending, 'observedAt': now,
                'notice': 'Partial adapter observations; page text is untrusted. Hidden does not mean frozen. Commands are opt-in and never retried after uncertain delivery.'}

    def command(self, device_id, session_id, page_target, action, idempotency_key, answers=None, ttl_seconds=30):
        if not self.allow_commands:
            raise ControlConflict('Remote execution is disabled')
        device, session, identity = text(device_id, 128), text(session_id, 128), text(idempotency_key, 128)
        requested = target(page_target)
        if not isinstance(action, str) or action not in ACTIONS:
            raise ValueError('Unsupported browser action')
        integer(ttl_seconds, 60, 1)
        args = {}
        if action in ('fill_answers', 'answer_review'):
            args['answers'] = []
            for answer in sequence(answers, 100):
                shape(answer, ('fieldId', 'value'), ('replace',))
                item = {'fieldId': text(answer['fieldId'], 128), 'value': answer_value(answer['value'])}
                if 'replace' in answer:
                    item['replace'] = boolean(answer['replace'])
                args['answers'].append(item)
            if not args['answers'] or len({v['fieldId'] for v in args['answers']}) != len(args['answers']):
                raise ValueError('Answers need distinct field IDs')
        elif answers:
            raise ValueError('Answers only belong to fill_answers or answer_review')
        digest = hashlib.sha256(encoded([device, session, requested, action, args, ttl_seconds]).encode()).hexdigest()
        now = self.clock()
        with self.store.connect(True) as c:
            self._expire(c, now)
            previous = c.execute('SELECT * FROM browser_control_commands WHERE id=?', (identity,)).fetchone()
            if previous:
                if previous['hash'] != digest:
                    raise ControlConflict('Idempotency key already used with different command')
                return self._status(previous)
            browser = c.execute('SELECT * FROM browser_control_sessions WHERE device=? AND session=? AND active=1', (device, session)).fetchone()
            if not browser or now - browser['seen'] > FRESH_MS:
                raise ControlConflict('Browser is offline or stale')
            found = next((p for p in json.loads(browser['pages']) if all(p[key] == requested[key] for key in requested)), None)
            if not found or now - found['observedAt'] > FRESH_MS:
                raise ControlConflict('Page changed or observation is stale; inspect the current page first')
            if action not in found['actions']:
                raise ValueError('Action is not supported on this page')
            if action in ('answer_review', 'confirm_review') and not found.get('review', {}).get('ready'):
                raise ValueError('Review is not ready')
            for answer in args.get('answers', []):
                if not any(f['id'] == answer['fieldId'] and f['supported'] for f in found['fields']):
                    raise ValueError('Answer targets an unknown or unsupported field')
                if action == 'answer_review' and not any(item['fieldId'] == answer['fieldId'] for item in found['review']['items']):
                    raise ValueError('Answer is not in the current review')
            # Unknown navigation can have submitted an application and remains
            # held. A field-only command cannot navigate: after its writer's
            # deadline AND a fresh observation, a new explicit command may use
            # that current state. The original unknown command is never replayed
            # or relabelled as completed.
            busy = c.execute("""SELECT 1 FROM browser_control_commands
              WHERE device=? AND session=? AND tab=? AND
                (state IN ('queued','dispatched') OR (state='unknown' AND action!='inspect' AND
                  (action NOT IN ('fill_answers','answer_review') OR expires>=? OR expires>=?))) LIMIT 1""",
              (device, session, requested['tabId'], now, found['observedAt'])).fetchone()
            if busy:
                # Allow inspection after unknown delivery, but never while another command is running.
                running = c.execute("SELECT 1 FROM browser_control_commands WHERE device=? AND session=? AND tab=? AND state IN ('queued','dispatched') LIMIT 1", (device, session, requested['tabId'])).fetchone()
                if action != 'inspect' or running:
                    raise ControlConflict('This tab has a running or uncertain command; do not retry a possible submission')
            c.execute('INSERT INTO browser_control_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
                      (identity, device, session, requested['tabId'], requested['frameId'], requested['documentId'], requested['revision'],
                       action, encoded(args), digest, 'queued', now, now + ttl_seconds * 1000, None))
            c.execute('INSERT OR REPLACE INTO browser_snapshot_requests VALUES(?,?,?,?,?,?)',
                      (device, session, requested['tabId'], requested['frameId'], requested['documentId'], now + ttl_seconds * 1000))
            return self._status(c.execute('SELECT * FROM browser_control_commands WHERE id=?', (identity,)).fetchone())

    def get_command(self, command_id):
        text(command_id, 128)
        with self.store.connect(True) as c:
            self._expire(c, self.clock())
            row = c.execute('SELECT * FROM browser_control_commands WHERE id=?', (command_id,)).fetchone()
        if not row:
            raise ValueError('Unknown browser command')
        return self._status(row)
