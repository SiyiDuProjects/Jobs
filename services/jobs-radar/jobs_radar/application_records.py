"""Row operations for the authoritative applications table.

Metadata, submission state and recruiting progress live together. No caller can
replace another device's entire inventory; edits require a per-record version.
"""
import json
import time
import uuid
from urllib.parse import urlsplit
from datetime import datetime, timezone
from .job_match import job_key, posting_key, job_index
from .verified_postings import canonical_key, equivalent_keys
from .profiles import ProfileConflict

STATUSES = {'applied','assessment','phone_screen','screen','interview','offer','accepted','rejected','withdrawn','offer_declined','archived'}
FIELDS = ('jobTitle','jobLink','companyName','companyLink','date','status','profileName')


STATE_COLUMNS={'status','detail','evidence','owner_run_id','record','progress','attempted_at','confirmed_at','submission_error','deleted','updated'}


def can_remove_unsubmitted(app):
    """Explicit owner removal may abandon a draft, never hide submission evidence."""
    return bool(app is not None and app['status'] in {
        'not_started', 'in_progress', 'needs_input', 'retryable_failure', 'skipped'
    } and app['attempted_at'] is None and app['confirmed_at'] is None
        and not app['submission_error'] and not app['record'])


def submission_state(app):
    """Same submission facts for the website and the extension's current page."""
    submitted = app['attempted_at'] is not None or app['confirmed_at'] is not None or app['status'] in {'submitted', 'submitted_unconfirmed'}
    confirmed = app['confirmed_at'] is not None
    return {'status': app['status'], 'attempted_at': app['attempted_at'], 'confirmed_at': app['confirmed_at'],
            'error': app['submission_error'], 'submitted': submitted, 'confirmed': confirmed,
            'label': '已确认投递' if confirmed else '提交后报错，待核实' if submitted and app['submission_error'] else '已投递' if app['status']=='submitted' else '已尝试提交' if submitted else '未投递'}


def write_state(c, job_id, changes, *, version_step=0, record_step=0, reason):
    """Sole runtime lifecycle writer; the caller appends its event atomically.

    All callers already hold the store write transaction. An unknown or confirmed
    submission can only leave the submitted pool through the checked owner undo.
    """
    if not isinstance(changes,dict) or not changes or set(changes)-STATE_COLUMNS:
        raise ValueError('Invalid application state change')
    before=c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone()
    if not before:raise ValueError('Unknown application')
    if before['status'] in {'submitted','submitted_unconfirmed'} and changes.get('status',before['status']) not in {'submitted','submitted_unconfirmed'} and reason!='owner_undo':
        raise ValueError('Uncertain submission cannot be automatically retried')
    if before['confirmed_at'] is not None and (changes.get('confirmed_at',before['confirmed_at']) is None or changes.get('status',before['status'])!='submitted') and reason!='owner_undo':
        raise ValueError('Confirmation cannot be downgraded')
    columns=list(changes)
    assignments=','.join(name+'=?' for name in columns)
    c.execute('UPDATE applications SET '+assignments+',version=version+?,record_version=record_version+? WHERE job_id=?',
        [*(changes[name] for name in columns),version_step,record_step,job_id])
    after=dict(c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone())
    if any(before[name]!=after[name] for name in columns):
        c.execute("INSERT INTO application_events(event_key,application_id,job_id,kind,payload,created) VALUES(?,?,?,'state_change',?,?)",
            ('state:'+str(uuid.uuid4()),after['application_id'],job_id,json.dumps({'reason':reason,'before':{name:before[name] for name in columns},'after':{name:after[name] for name in columns}},ensure_ascii=False),time.time()))
    return after


def read(c):
    rows=[]
    for app in c.execute('SELECT * FROM applications WHERE record IS NOT NULL AND deleted=0 ORDER BY updated DESC,job_id'):
        rows.append(record(app))
    return rows


def record(app):
    row=json.loads(app['record'])
    row.update(id=app['application_id'], job_id=app['job_id'], version=app['record_version'], submission=submission_state(app))
    if app['progress']:
        from .application_progress import public_state
        progress=json.loads(app['progress']);row['status']=progress['stage'];row['progress']=public_state(progress)
    return row


def validate(row):
    if not isinstance(row,dict) or not all(isinstance(row.get(k),str) for k in FIELDS):
        raise ValueError('Invalid application record')
    if row['status'] not in STATUSES: raise ValueError('Invalid application stage')
    if len(json.dumps(row).encode())>24000: raise ValueError('Application record too large')
    if row['jobLink'] and not job_key(row['jobLink']): raise ValueError('Invalid application URL')
    if row['companyLink']:
        # Company careers pages often have no posting identifier. They are
        # display metadata, never an input to posting-identity resolution.
        try:
            url = urlsplit(row['companyLink'])
            valid = url.scheme in {'https', 'http'} and bool(url.hostname) and not url.username and not url.password
            valid = valid and url.port != 0 and not any(ord(char) <= 32 or ord(char) == 127 for char in row['companyLink'])
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('Invalid company URL')
    return {k:row[k] for k in FIELDS}


def seed_progress(aid, stage='applied', source='owner'):
    return dict(application_id=aid,stage=stage,round=None,final=False,version=0,
                observed_at=None,updated_at=None,source=source,summary='',reference='',
                manual_updated_at=0,ended_from=None,receipt_confirmed=False)


def matching_applications(c, key, *, verified=True):
    keys=equivalent_keys(key) if verified else (key,) if key else ()
    if not keys:return []
    marks=','.join('?' for _ in keys)
    return c.execute(f'SELECT * FROM applications WHERE job_key IN ({marks}) ORDER BY CASE WHEN record IS NULL THEN 1 ELSE 0 END,updated DESC',keys).fetchall()


def receipt_application(c, job_id, key):
    """A source row is not a new owner inventory identity for the same posting."""
    matches=matching_applications(c,key)
    identities={r['application_id'] for r in matches if r['application_id']}
    if len(identities)>1:
        raise ValueError('Multiple applications share the posting identity; review required')
    owner=next((r for r in matches if r['application_id'] and r['record']),None)
    return owner if owner is not None else (
        c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone() if job_id else None)


def upsert(c,row,*,migration=False,submission_status=None,receipt_proof=None):
    value=validate(row);key=(job_key if migration else posting_key)(value['jobLink']);now=time.time()
    current=c.execute('SELECT * FROM applications WHERE application_id=?',(row.get('id'),)).fetchone() if row.get('id') else None
    if current is None and row.get('job_id'):
        current=c.execute('SELECT * FROM applications WHERE job_id=?',(row['job_id'],)).fetchone()
    if receipt_proof:
        current=receipt_application(c,row.get('job_id'),key)
    matches=matching_applications(c,key,verified=not migration)
    if current is None and matches:
        identities={r['application_id'] for r in matches if r['application_id']}
        if len(identities)>1: raise ValueError('Multiple applications share the posting identity; review required')
        current=matches[0]
    if current is None:
        if migration:
            ids={r['id'] for r in c.execute('SELECT id FROM jobs WHERE job_key=? AND id NOT IN (SELECT alias_id FROM job_aliases)',(key,))} if key else set()
        else:
            ids=job_index(c).get(key,set()) if key else set()
        if len(ids)>1:
            from .job_duplicates import preferred_job
            jid=preferred_job(c,ids)
        else: jid=next(iter(ids),None)
        if jid: current=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
    aid=(current['application_id'] if current else None) or row.get('id') or str(uuid.uuid4())
    jid=current['job_id'] if current else 'external:'+aid
    if receipt_proof and current and current['record']:
        from .submission_events import observed_timestamp
        old=json.loads(current['record'])
        latest=max(observed_timestamp(old.get('date')),current['attempted_at'] or 0,current['confirmed_at'] or 0)
        owner_edited=c.execute("SELECT 1 FROM application_events WHERE application_id=? AND kind='record_edit' LIMIT 1",(aid,)).fetchone()
        # Receipts enrich submission evidence independently of editable record
        # metadata. Older events and validation failures cannot rewrite it;
        # explicit owner edits retain precedence even over newer receipts.
        if (owner_edited or receipt_proof=='submit_validation_error'
                or observed_timestamp(value['date']) <= latest
                or current['confirmed_at'] is not None and receipt_proof!='ats_confirmation'):
            return record(current)
    if current and current['record']:
        # Existing progress never comes from an uploaded metadata copy.
        old=json.loads(current['record'])
        if migration:
            value={**value,**old}
            for field in ('companyName','companyLink','profileName'):
                value[field]=old.get(field) or row.get(field,'')
    if current and current['record'] and not migration:
        old=json.loads(current['record'])
        for field in FIELDS:
            if not value[field]:value[field]=old.get(field,'')
    progress=(current['progress'] if current else None) or json.dumps(seed_progress(aid,value['status'],'migration' if migration else 'owner'))
    status=submission_status or (current['status'] if current and current['status']!='not_started' else 'submitted_unconfirmed')
    if current:
        c.execute('UPDATE applications SET application_id=?,job_key=?,record=?,progress=?,record_version=record_version+1,deleted=0 WHERE job_id=?',
                  (aid,key,json.dumps(value,ensure_ascii=False),progress,jid))
    else:
        c.execute('INSERT INTO applications(job_id,status,updated,application_id,job_key,record,progress,record_version) VALUES(?,?,?,?,?,?,?,1)',
                  (jid,status,now,aid,key,json.dumps(value,ensure_ascii=False),progress))
    if submission_status or migration and current and current['status']=='not_started':
        from .submission_events import observed_timestamp
        fresh=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        write_state(c,jid,dict(status='submitted' if fresh['confirmed_at'] is not None else submission_status or 'submitted_unconfirmed',
            attempted_at=fresh['attempted_at'] or observed_timestamp(value['date']) or now),reason='inventory')
    return record(c.execute('SELECT * FROM applications WHERE application_id=?',(aid,)).fetchone())


def reconcile(c,job_ids=None):
    """Attach external records when a known posting is collected, preserving IDs."""
    changed=0
    for external in c.execute("SELECT * FROM applications WHERE job_id LIKE 'external:%' OR job_id LIKE 'historical:%'").fetchall():
        ids=job_index(c).get(canonical_key(external['job_key']),set())
        if job_ids is not None: ids &= set(job_ids)
        if len(ids)!=1: continue
        jid=next(iter(ids));target=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        if not target or target['record'] or target['status']!='not_started' or target['version']>0:continue
        c.execute('DELETE FROM applications WHERE job_id=?',(jid,))
        c.execute('UPDATE applications SET job_id=?,job_key=? WHERE job_id=?',(jid,canonical_key(external['job_key']),external['job_id']))
        c.execute('UPDATE application_events SET job_id=? WHERE job_id=?',(jid,external['job_id']))
        changed+=1
    return changed


def manual_id(jid):return str(uuid.uuid5(uuid.NAMESPACE_URL,'jobs-board:'+jid))


def add_manual(c,jid):
    app=c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
    if not app:return
    if app['record']: return record(app)
    existing=[r for r in matching_applications(c,app['job_key']) if r['record'] is not None]
    if len(existing)>1:raise ValueError('Multiple applications share the posting identity; review required')
    if existing:return record(existing[0])
    source=next((json.loads(r[0]) for r in c.execute('SELECT payload FROM observations WHERE job_id=? ORDER BY last_seen DESC',(jid,)) if json.loads(r[0]).get('apply_url')),None)
    if not source:return
    source_key=posting_key(source['apply_url'])
    if app['job_key'] and source_key!=canonical_key(app['job_key']):raise ValueError('Application source posting identity changed; review required')
    existing=[r for r in matching_applications(c,source_key) if r['record'] is not None]
    if len(existing)>1:raise ValueError('Multiple applications share the posting identity; review required')
    if existing:return record(existing[0])
    return upsert(c,dict(id=manual_id(jid),jobTitle=source['title'],jobLink=source['apply_url'],companyName=source.get('company',''),companyLink='',
        profileName='Intern' if source.get('kind') in {'intern','internship'} else 'Newgrad',date=datetime.fromtimestamp(app['updated'],timezone.utc).isoformat(),status='applied'))


class ApplicationRecords:
    def __init__(self,store):self.store=store

    def list(self):
        from .application_progress import project_display
        with self.store.connect() as c:return {'applications':project_display(c,read(c))}

    def mutate(self,changes,idempotency_key,*,guard=None):
        if not isinstance(changes,list) or not 1<=len(changes)<=1000:raise ValueError('Provide 1..1000 application changes')
        with self.store.connect(True) as c:
            digest,old=self.store._idem(c,idempotency_key,['application-rows',changes])
            if old is not None:return old
            if guard is not None:guard(c)
            changed=[]
            for change in changes:
                if not isinstance(change,dict) or set(change)-{'action','application_id','expected_version','value'}:raise ValueError('Invalid application change')
                action=change.get('action');aid=change.get('application_id')
                app=c.execute('SELECT * FROM applications WHERE application_id=? AND deleted=0',(aid,)).fetchone() if aid else None
                if action=='create':
                    value=validate(change.get('value'))
                    key=posting_key(value['jobLink'])
                    duplicate=any(r['record'] is not None for r in matching_applications(c,key))
                    if duplicate:raise ProfileConflict('This posting already has an application record')
                    result=upsert(c,value,submission_status='submitted_unconfirmed')
                    c.execute('UPDATE applications SET attempted_at=?,version=version+1 WHERE application_id=?',(time.time(),result['id']))
                    aid=result['id']
                elif action in {'update','delete'}:
                    if not app or type(change.get('expected_version')) is not int or app['record_version']!=change['expected_version']:
                        raise ProfileConflict('申请记录已修改，请刷新后重试')
                    if action=='update':
                        value=validate(change.get('value'))
                        if posting_key(value['jobLink'])!=canonical_key(app['job_key']):raise ValueError('Posting identity cannot be changed by a metadata edit')
                        old_value=json.loads(app['record']);value['status']=old_value['status']
                        c.execute('UPDATE applications SET record=?,record_version=record_version+1,version=version+1 WHERE application_id=?',(json.dumps(value,ensure_ascii=False),aid))
                    else:
                        # Hiding a record never makes an uncertain submission retryable.
                        c.execute('UPDATE applications SET deleted=1,record_version=record_version+1,version=version+1 WHERE application_id=?',(aid,))
                else:raise ValueError('Invalid application action')
                c.execute('INSERT INTO application_events(event_key,application_id,kind,payload,created) VALUES(?,?,?,?,?)',
                    ('row:'+idempotency_key+':'+str(len(changed)),aid,'record_edit',json.dumps(change,ensure_ascii=False),time.time()))
                changed.append(aid)
            result={'changed':changed}
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',(idempotency_key,digest,json.dumps(result)))
            return result
