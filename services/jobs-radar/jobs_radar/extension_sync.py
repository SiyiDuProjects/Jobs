"""Owner-paired extension receipts; exact URL identity, durable deduplication."""
import hashlib
import json
import re
import secrets
import time
from urllib.parse import urlsplit

from .identity import identity
from .submission_events import blocked_by_owner_undo

EXTENSION_ID = 'ccohapahbamkcbgkpegidkpknoeikiko'


class ExtensionSync:
    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS extension_devices(
                device_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, created REAL,
                expires REAL, last_seen REAL, revoked INTEGER DEFAULT 0);
            ''')

    def pair(self, device_id, extension_id):
        if extension_id != EXTENSION_ID or not isinstance(device_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{20,80}', device_id):
            raise ValueError('Invalid extension identity')
        token = secrets.token_urlsafe(48)
        now = time.time()
        with self.store.connect(True) as c:
            c.execute('''INSERT INTO extension_devices VALUES(?,?,?,?,?,0)
              ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash,
              expires=excluded.expires,last_seen=excluded.last_seen,revoked=0''',
              (device_id, hashlib.sha256(token.encode()).hexdigest(), now, now+180*86400, now))
        return {'token': token, 'device_id': device_id}

    def authenticate(self, token):
        if not isinstance(token, str) or not 40 <= len(token) <= 100:
            return None
        with self.store.connect() as c:
            row = c.execute('SELECT device_id FROM extension_devices WHERE token_hash=? AND revoked=0 AND expires>?',
                            (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
            return row['device_id'] if row else None

    def disconnect(self, device_id):
        if not isinstance(device_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{20,80}', device_id):
            raise ValueError('Invalid device')
        with self.store.connect(True) as c:
            c.execute('UPDATE extension_devices SET revoked=1 WHERE device_id=?', (device_id,))
        return {'ok': True}

    @staticmethod
    def validate(payload):
        if not isinstance(payload, dict):
            raise ValueError('Invalid receipt')
        allowed = {'event_id', 'job_url', 'job_title', 'company', 'observed_at', 'proof', 'website_job_id', 'profile_id', 'profile_name', 'run_id', 'detail'}
        if set(payload) - allowed:
            raise ValueError('Unexpected receipt fields')
        for name, limit in [('event_id', 80), ('job_url', 2000), ('job_title', 500), ('company', 250), ('observed_at', 80), ('proof', 40)]:
            if not isinstance(payload.get(name, ''), str) or len(payload.get(name, '')) > limit:
                raise ValueError('Invalid ' + name)
        if not re.fullmatch(r'[a-zA-Z0-9-]{20,80}', payload.get('event_id', '')):
            raise ValueError('Invalid event ID')
        if payload.get('proof') not in {'ats_confirmation', 'tracker_record', 'submit_attempt', 'submit_validation_error'}:
            raise ValueError('Invalid receipt proof')
        if 'website_job_id' in payload and (not isinstance(payload['website_job_id'],str) or not re.fullmatch(r'[a-f0-9]{24}',payload['website_job_id'])):
            raise ValueError('Invalid website job ID')
        canonical = identity(payload.get('job_url', ''))
        parsed = urlsplit(payload['job_url'])
        if parsed.hostname in {'localhost', '127.0.0.1', '::1'}:
            raise ValueError('Invalid job URL')
        return canonical

    def receive(self, device_id, payload):
        if isinstance(payload, dict) and payload.get('proof') in {'ats_unavailable', 'manual_remove', 'undo_unavailable'}:
            from .job_availability import JobAvailability
            return JobAvailability(self.store).receive(device_id, payload)
        self.validate(payload)
        from .application_records import upsert, write_state, receipt_application
        from .submission_events import observed_timestamp
        observed=observed_timestamp(payload.get('observed_at'))
        if not 1577836800 <= observed <= time.time()+600:
            raise ValueError('Use the actual timezone-aware event timestamp')
        for name in ('profile_id','profile_name','run_id','detail'):
            if name in payload and (not isinstance(payload[name],str) or len(payload[name])>1000):
                raise ValueError('Invalid '+name)
        raw=json.dumps(payload,sort_keys=True,separators=(',',':'))
        checksum=hashlib.sha256(raw.encode()).hexdigest();now=time.time()
        with self.store.connect(True) as c:
            previous=c.execute('SELECT * FROM application_events WHERE event_key=?',(payload['event_id'],)).fetchone()
            if previous:
                if previous['device_id']!=device_id or previous['checksum']!=checksum:
                    raise ValueError('Receipt ID already used for different content')
                # Migrated transport holds must be resolved through the current
                # matching and owner-undo checks; terminal receipts remain immutable.
                if previous['state'] not in {'unmatched','held','needs_confirmation','recorded'}:
                    return json.loads(previous['result'])
            if not c.execute('SELECT 1 FROM extension_devices WHERE device_id=? AND revoked=0 AND expires>?',(device_id,now)).fetchone():
                raise ValueError('Device authorization expired')
            c.execute('UPDATE extension_devices SET last_seen=? WHERE device_id=?',(now,device_id))
            from .job_match import resolve
            ids,method=resolve(c,payload['job_url'],payload.get('website_job_id'))
            if any(blocked_by_owner_undo(c,jid,payload['observed_at']) for jid in ids):
                result={'event_id':payload['event_id'],'state':'ignored_after_undo','job_id':ids[0],'job_ids':ids,'retryable':False,'matched_by':method}
                application_id=None
            else:
                jid=payload.get('website_job_id') if payload.get('website_job_id') in ids else ids[0] if ids else None
                from .job_match import posting_key
                before=receipt_application(c,jid,posting_key(payload['job_url']))
                if before is not None:jid=before['job_id']
                value=upsert(c,dict(job_id=jid,jobTitle=payload.get('job_title',''),jobLink=payload['job_url'],companyName=payload.get('company',''),
                    companyLink='',date=payload['observed_at'],status='applied',profileName=payload.get('profile_name','')),receipt_proof=payload['proof'])
                application_id=value['id'];jid=value['job_id']
                app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
                if payload['proof']=='submit_validation_error' and app['attempted_at'] is None:
                    raise ValueError('A validation error must follow a recorded submit action')
                confirmed=payload['proof']=='ats_confirmation'
                # The owner's native Applied record is the board's source of
                # truth. A receipt enriches provenance; it is not a second gate.
                error=(payload.get('detail') or '提交后报错，待核实') if payload['proof']=='submit_validation_error' else (
                    None if payload['proof'] in {'tracker_record','ats_confirmation'} else app['submission_error'])
                receipt_error=error
                has_confirmation=confirmed or app['confirmed_at'] is not None
                # Out-of-order receipts remain evidence, but cannot replace
                # the displayed result of an authoritative ATS confirmation.
                if has_confirmation:error=None
                new_status='submitted' if has_confirmation or not error else 'submitted_unconfirmed'
                evidence=json.loads(app['evidence'] or '[]')
                evidence.append(dict(type='extension_confirmation' if confirmed else payload['proof'],reference=payload['job_url'],
                    observed_at=payload['observed_at'],reported_by='jobs-extension',event_id=payload['event_id']))
                if app['attempted_at'] is None:
                    reviews=[dict(r) for r in c.execute("SELECT * FROM job_screening WHERE job_id=? AND state='trash'",(jid,))]
                    c.execute('INSERT OR REPLACE INTO owner_submission_undo VALUES(?,?,?,?,?)',
                        (jid,app['version']+1,now+86400,json.dumps(dict(before or app)),json.dumps(reviews)))
                unchanged=bool(app['status']==new_status and app['submission_error']==error and (
                    app['confirmed_at'] is not None or app['attempted_at'] is not None and payload['proof'] in {'submit_attempt','tracker_record'}))
                write_state(c,jid,dict(status=new_status,updated=now,evidence=json.dumps(evidence),
                    attempted_at=app['attempted_at'] or observed,confirmed_at=app['confirmed_at'] or (observed if confirmed else None),
                    submission_error=error,detail='网站已确认' if has_confirmation else error or '插件已记录投递'),
                    version_step=0 if unchanged else 1,reason='extension')
                if not unchanged:
                    # Attempt, validation and confirmation are evidence for the
                    # same submission. Keep its original owner-undo snapshot,
                    # advancing the guard only if no other operation intervened.
                    c.execute('UPDATE owner_submission_undo SET version=? WHERE job_id=? AND version=?',
                        (app['version']+1,jid,app['version']))
                for alias in ids:
                    if alias==jid:continue
                    alias_app=c.execute('SELECT * FROM applications WHERE job_id=?',(alias,)).fetchone()
                    alias_confirmed=confirmed or alias_app['confirmed_at'] is not None
                    alias_error=None if alias_confirmed else receipt_error
                    write_state(c,alias,dict(status='submitted' if alias_confirmed or not alias_error else 'submitted_unconfirmed',
                        attempted_at=alias_app['attempted_at'] or observed,
                        confirmed_at=alias_app['confirmed_at'] or (observed if confirmed else None),evidence=json.dumps(evidence),
                        submission_error=alias_error,
                        detail='网站已确认' if alias_confirmed else alias_error or '插件已记录投递'),
                        version_step=1,reason='extension_alias')
                # Late submission evidence remains authoritative, but must not
                # undo the owner's explicit removal or restart the application.
                c.execute("UPDATE job_screening SET state='keep',manual_keep=1,expires_at=NULL,version=version+1 WHERE job_id=? AND state='trash' AND reason!='manual'",(jid,))
                result={'event_id':payload['event_id'],'state':'already_submitted' if unchanged and app['confirmed_at'] is not None else new_status,'job_id':jid,'job_ids':ids,
                        'application_id':application_id,'retryable':False,'matched_by':method}
            c.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created,device_id,checksum,updated,state,result) VALUES(?,?,?,'extension',?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET application_id=excluded.application_id,job_id=excluded.job_id,updated=excluded.updated,state=excluded.state,result=excluded.result",
                (payload['event_id'],application_id,result['job_id'],raw,now,device_id,checksum,now,result['state'],json.dumps(result)))
            return result

    def resolve(self, payload):
        """Which listed job (and employment kind) a page belongs to.

        The extension binds the matching Profile for pages opened outside the
        website (agent tools, bookmarks, a reloaded extension)."""
        if not isinstance(payload, dict) or set(payload) - {'url', 'website_job_id'}:
            raise ValueError('Invalid resolve request')
        url, hint = payload.get('url'), payload.get('website_job_id')
        if not isinstance(url, str) or len(url) > 2000 or (hint is not None and not isinstance(hint, str)):
            raise ValueError('Invalid resolve request')
        identity(url)
        from .job_match import resolve, posting_key, identity_job_keys
        from .application_records import submission_state, can_remove_unsubmitted, matching_applications
        def application_state(rows):
            held = sorted(rows, key=lambda row: (row['confirmed_at'] is not None,
                bool(row['submission_error']), row['attempted_at'] is not None or row['status'] in {'submitted', 'submitted_unconfirmed'},
                bool(row['application_id'] and row['record']), row['updated']), reverse=True)
            return ({'id': held[0]['application_id'], 'version': held[0]['record_version'],
                     **submission_state(held[0])} if held else None)
        with self.store.connect() as c:
            ids, method = resolve(c, url, hint)
            if not ids:
                external = matching_applications(c, posting_key(url))
                return {'state': 'unmatched', 'application': application_state(external)}
            identity_keys = identity_job_keys(c, ids, url)
            marks = ','.join('?' for _ in ids)
            rows = [json.loads(r[0]) for r in c.execute(f'SELECT payload FROM observations WHERE job_id IN ({marks})', ids)]
            # Read-only queue eligibility uses the board's discovery boundary
            # and all matching aliases. It creates no second application ledger
            # or lease, and never interprets an uncertain attempt as retryable.
            from .scope import discovery_scope
            scope, scope_values = discovery_scope()
            visible = c.execute(f'''SELECT 1 FROM search_index s JOIN observations o USING(stream,source_id)
                WHERE {scope} AND s.job_id IN ({marks}) AND s.active=1 AND s.visible=1 AND o.present=1
                AND NOT EXISTS (SELECT 1 FROM job_screening q WHERE q.job_id=s.job_id AND q.kind=s.kind AND q.state='trash') LIMIT 1''',
                [*scope_values, *ids]).fetchone()
            applications = list({r['job_id']:r for r in [
                *c.execute(f'SELECT * FROM applications WHERE job_id IN ({marks})', ids).fetchall(),
                *matching_applications(c, posting_key(url))]}.values())
            statuses = [r['status'] for r in applications]
            removed = c.execute(f"SELECT 1 FROM job_screening WHERE job_id IN ({marks}) AND state='trash' LIMIT 1", ids).fetchone() is not None
            removal = {'allowed': len(statuses) >= len(ids) and all(can_remove_unsubmitted(r) for r in applications), 'removed': removed}
            pending_screening = c.execute(f"SELECT 1 FROM job_screening WHERE job_id IN ({marks}) AND state='pending' LIMIT 1", ids).fetchone()
            missing_application = set(ids) - {r['job_id'] for r in applications}
            reason = ('not_in_current_list' if not visible else 'application_history' if missing_application or any(
                r['status'] != 'not_started' or r['attempted_at'] is not None or r['confirmed_at'] is not None
                or r['record'] or r['submission_error'] or r['job_id'] not in ids and r['version'] > 0
                for r in applications) else 'screening_required' if pending_screening else '')
            queue = {'version': 1, 'allowed': not reason, 'reason': reason, 'checked_at': int(time.time() * 1000)}
            application = application_state(applications)
            selected_id = hint if hint in ids else ids[0]
            title_override = c.execute('SELECT title FROM job_title_overrides WHERE job_id=?',(selected_id,)).fetchone()
        kinds = sorted({{'internship': 'intern'}.get(r.get('kind'), r.get('kind')) for r in rows} & {'intern', 'newgrad'})
        first = rows[0] if rows else {}
        return {'state': 'matched', 'job_id': selected_id, 'job_ids': ids, 'kinds': kinds,
                **({'identity_job_keys': identity_keys} if identity_keys is not None else {}),
                'matched_by': method, 'company': str(first.get('company', ''))[:250], 'title': title_override['title'] if title_override else str(first.get('title', ''))[:500],
                'queue': queue, 'application': application, 'removal': removal}

    def status(self):
        with self.store.connect() as c:
            return {
                'connected_devices': c.execute('SELECT count(*) FROM extension_devices WHERE revoked=0 AND expires>?', (time.time(),)).fetchone()[0],
                'last_received': c.execute("SELECT max(created) FROM application_events WHERE kind='extension'").fetchone()[0],
                'pending': 0,
            }
