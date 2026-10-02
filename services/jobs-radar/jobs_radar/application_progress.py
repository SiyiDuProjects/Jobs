"""One owner application timeline, shared by mail, management UI and MCP.

Application metadata and recruiting progress share the applications row; events
are append-only and metadata edits never replace authoritative progress.
"""
import json
import time
from pathlib import Path
from datetime import datetime

from . import application_records as records
from .job_match import job_key, job_index
from .profiles import ProfileConflict

STAGES = ('applied', 'assessment', 'phone_screen', 'screen', 'interview', 'offer',
          'accepted', 'rejected', 'withdrawn', 'offer_declined', 'archived')
TERMINAL = {'accepted', 'rejected', 'withdrawn', 'offer_declined', 'archived'}
ASSESSMENT_TYPES = {'unknown', 'automatic', 'screened'}
RANK = {'applied': 0, 'assessment': 1, 'screen': 1, 'phone_screen': 2,
        'interview': 3, 'offer': 4, **dict.fromkeys(TERMINAL, 5)}
STAGE_CONTRACT=json.loads(Path(__file__).with_name('application-stages.json').read_text(encoding='utf-8'))
LABELS=STAGE_CONTRACT['statuses']

def pending_reviews(c):
    return [{**(value:=json.loads(r[0])), 'label':stage_label(value['stage'],assessment_type=value.get('assessment_type','unknown'))} for r in c.execute("SELECT payload FROM application_events WHERE kind='pending' ORDER BY event_key")]


def timestamp(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None: raise ValueError()
        result = dt.timestamp()
        if not 1577836800 <= result <= time.time() + 600: raise ValueError()
        return result
    except (TypeError, AttributeError, ValueError):
        raise ValueError('Use a timezone-aware observed_at timestamp')


def identity(row):
    return job_key(row.get('jobLink')) or row.get('id') or json.dumps(
        [row.get(k) for k in ('companyName', 'jobTitle', 'date', 'profileName')])


def state(c, application_id):
    row = c.execute('SELECT progress FROM applications WHERE application_id=?', (application_id,)).fetchone()
    return json.loads(row[0]) if row and row[0] else None


def put(c, value):
    row=c.execute('SELECT job_id FROM applications WHERE application_id=?',(value['application_id'],)).fetchone()
    if not row:raise ValueError('Progress must belong to an existing application')
    records.write_state(c,row['job_id'],{'progress':json.dumps(value,ensure_ascii=False)},reason='progress')


def sync_records(c, previous=None):
    return records.read(c)


def public_state(value):
    result = {k: v for k, v in value.items() if k not in {'manual_updated_at', 'advancement_reset_at', 'advancement_reset_key'}}
    result['assessment_type'] = value.get('assessment_type', 'unknown')
    result['stage_is_advancement'] = qualifies(value['stage'], result['assessment_type'])
    return result


def qualifies(stage, assessment_type='unknown'):
    return stage in {'phone_screen','interview','offer','accepted','offer_declined'} or (
        stage=='assessment' and assessment_type=='screened')


def advanced_applications(c):
    """Verified historical advancement, with owner reclassifications respected."""
    states={r['application_id']:json.loads(r['progress']) for r in c.execute('SELECT application_id,progress FROM applications WHERE progress IS NOT NULL')}
    advanced={aid for aid,s in states.items() if qualifies(s['stage'],s.get('assessment_type'))}
    events=c.execute("SELECT rowid,event_key,application_id,payload FROM application_events WHERE kind='progress'").fetchall()
    event_order={row['event_key']:row['rowid'] for row in events}
    for row in events:
        event=json.loads(row['payload']); current=states.get(row['application_id'])
        if not current: continue
        reset_key=current.get('advancement_reset_key')
        if reset_key in event_order:
            if row['rowid']<event_order[reset_key]: continue
        elif event['recorded_at']<=current.get('advancement_reset_at',0): continue
        if not event['applied'] and event.get('reason') not in {'older_event','earlier_stage','earlier_round','finished_application'}: continue
        if qualifies(event['to'],event.get('assessment_type')): advanced.add(row['application_id'])
    return advanced, {aid for aid,s in states.items() if s.get('advancement_reset_at')}


def display_stage(stage, advanced=False, assessment_type='unknown'):
    """Owner's compact grouping; never replace the underlying email outcome."""
    if stage in {'applied', 'received', 'screen', None}: return 'no_answer'
    if stage == 'assessment' and assessment_type != 'screened': return 'no_answer'
    if stage == 'rejected' and not advanced: return 'no_answer'
    return 'interview' if stage == 'phone_screen' else stage


def chart_path(current, events, advanced):
    """Only recorded steps; never fill in presumed screening or interview rounds."""
    if display_stage(current['stage'],advanced,current.get('assessment_type'))=='no_answer': return [{'stage':'no_answer'}]
    reset=current.get('advancement_reset_key')
    cutoff=next((r['rowid'] for r in events if r['event_key']==reset),None)
    usable=[]
    for row in events:
        event=json.loads(row['payload'])
        if cutoff is not None and row['rowid']<cutoff: continue
        if cutoff is None and event['recorded_at']<=current.get('advancement_reset_at',0): continue
        if not event['applied'] and event.get('reason') not in {'older_event','earlier_stage','earlier_round','finished_application'}: continue
        usable.append(event)
    path=[]
    def append(stage,round=None,final=False,correct=False,assessment_type='unknown'):
        if stage in {'applied','screen'}: return
        if stage=='assessment' and assessment_type!='screened': return
        item={'stage':stage}
        if stage=='interview': item.update(round=round,final=final)
        if correct:
            while path and RANK.get(path[-1]['stage'],0)>=RANK.get(stage,0): path.pop()
        if not path or path[-1]!=item: path.append(item)
    for event in sorted(usable,key=lambda e:(e['observed_at'],e['recorded_at'])):
        append(event['to'],event.get('round'),event.get('final',False),event['action']=='correct',event.get('assessment_type'))
    if not path and current.get('ended_from'):
        before=current['ended_from']; append(before['stage'],before.get('round'),before.get('final',False),assessment_type=before.get('assessment_type'))
    # A later owner correction is authoritative even if its event was backdated.
    target={'stage':current['stage']}
    if current['stage']=='interview':target.update(round=current['round'],final=current['final'])
    if target in path: path=path[:path.index(target)+1]
    else: append(current['stage'],current.get('round'),current.get('final',False),assessment_type=current.get('assessment_type'))
    return path or [{'stage':'no_answer'}]


def stage_label(stage, round=None, final=False, assessment_type='unknown'):
    if stage in {'interview','phone_screen'}:return ('终面' if final else 'Interview')+(f' · 第 {round} 轮' if round else '')
    if stage=='screen':return '待核对'
    if stage=='assessment':return {'automatic':'OA · 自动发放','screened':'OA · 筛选后发放'}.get(assessment_type,'OA')
    return LABELS.get(stage,stage)


def display_fields(current, advanced):
    stage=current['stage'];display=display_stage(stage,advanced,current.get('assessment_type'))
    label=stage_label(stage,current.get('round'),current.get('final'),current.get('assessment_type'))
    if display=='no_answer':label='No Answer'+(' · OA '+('自动发放' if current.get('assessment_type')=='automatic' else '待确认') if stage=='assessment' else '')
    elif stage=='rejected' and (current.get('ended_from') or {}).get('stage')=='phone_screen':label='Screening → Rejected'
    elif current.get('ended_from'):
        before=current['ended_from'];label+=' · '+stage_label(before['stage'],before.get('round'),before.get('final'))+'后'
    options={'applied':['assessment','interview'],'assessment':['interview'],'screen':['assessment','interview'],
             'phone_screen':['interview','offer'],'interview':['next_interview','offer'],'offer':['accepted','offer_declined']}
    next_values=options.get(stage,[])+(['rejected','withdrawn'] if stage in options else [])
    return dict(label=label,stage_label=stage_label(stage,current.get('round'),current.get('final'),current.get('assessment_type')),next_stages={key:'下一轮面试' if key=='next_interview' else LABELS[key] for key in next_values})


def project_display(c, rows):
    advanced, _ = advanced_applications(c)
    events={}
    for event in c.execute("SELECT rowid,event_key,application_id,payload FROM application_events WHERE kind='progress'"):
        events.setdefault(event['application_id'],[]).append(event)
    for row in rows:
        current = state(c, row.get('id'))
        if not current: continue
        row['status'] = current['stage']
        row['progress'] = {**public_state(current), 'ever_advanced': row['id'] in advanced,
                           'display_stage': display_stage(current['stage'], row['id'] in advanced,current.get('assessment_type')),
                           'chart_path': chart_path(current,events.get(row['id'],[]),row['id'] in advanced),
                           **display_fields(current,row['id'] in advanced)}
    return rows


def matching_jobs(c, row, index=None):
    key = job_key(row.get('jobLink'))
    ids = (index if index is not None else job_index(c)).get(key, set()) if key else set()
    if not key:
        ids = {r[0] for r in c.execute('SELECT id FROM jobs') if records.manual_id(r[0])==row['id']}
    return ids


def job_progress(c, job_id):
    row=c.execute('SELECT progress FROM applications WHERE job_id=?',(job_id,)).fetchone()
    if not row or not row[0]:return None
    current=json.loads(row[0])
    return dict(job_id=job_id,stage='received' if current['stage']=='applied' and current['receipt_confirmed'] else current['stage'],
        received_at=current['observed_at'],message_id=current['reference'] if current['source']=='email' else '',
        summary=current['summary'],version=current['version'])


def apply_event(c, row, *, stage, observed_at, source, reference, summary,
                event_key, action='set', interview_round=None, is_final=None,
                allow=False, assessment_type=None):
    previous = state(c, row['id'])
    if stage not in STAGES: raise ValueError('Unsupported application stage')
    if action not in {'set','next_interview','correct'}: raise ValueError('Invalid action')
    if assessment_type is not None and (assessment_type not in ASSESSMENT_TYPES or stage!='assessment'):
        raise ValueError('assessment_type is unknown, automatic or screened, for OA only')
    if interview_round is not None and (type(interview_round) is not int or not 1 <= interview_round <= 99):
        raise ValueError('interview_round must be 1..99, or omitted when unknown')
    if is_final is not None and type(is_final) is not bool: raise ValueError('is_final must be boolean')
    if (interview_round is not None or is_final is not None) and stage!='interview':
        raise ValueError('Round and final flag are for interviews only')
    seen = c.execute('SELECT payload FROM application_events WHERE event_key=?', (event_key,)).fetchone()
    if seen:
        event = json.loads(seen[0])
        if event['application_id']!=row['id'] or event['to']!=stage:
            raise ValueError('This event belongs to a different application or stage')
        return dict(duplicate=True, applied=event['applied'], progress=public_state(previous))
    if action=='next_interview':
        if stage!='interview' or previous['stage']!='interview':
            raise ValueError('Next interview requires an existing interview')
        if previous['round'] is None and interview_round is None:
            raise ValueError('Previous round is unknown; supply the confirmed round number')
        interview_round = interview_round or previous['round']+1
        if previous['round'] is not None and interview_round<=previous['round']:
            raise ValueError('Next interview must increase the round')
    if source=='email' and action=='correct': raise ValueError('Corrections require owner confirmation')
    if source!='email' and action!='correct':
        if previous['stage'] in TERMINAL and stage!=previous['stage']:
            raise ValueError('Use correct to reopen a finished application')
        if stage in {'accepted','offer_declined'} and previous['stage'] not in {'offer',stage}:
            raise ValueError('Record the offer first, or use an explicit correction')
    reason = ''
    if source=='email' and not allow:
        if observed_at <= previous['manual_updated_at']: reason='older_than_owner_update'
        elif previous['observed_at'] and observed_at < previous['observed_at']: reason='older_event'
        elif previous['stage'] in TERMINAL and stage!=previous['stage']: reason='finished_application'
        elif RANK[stage] < RANK[previous['stage']]: reason='earlier_stage'
        elif stage=='interview' and interview_round is not None and previous['round'] is not None and interview_round<previous['round']:
            reason='earlier_round'
    current = dict(previous)
    if not reason:
        same_interview = stage=='interview' and previous['stage']=='interview' and action!='correct'
        round_number = interview_round if interview_round is not None else previous['round'] if same_interview else None
        final = is_final if is_final is not None else previous['final'] if same_interview and action!='next_interview' else False
        ended_from = previous['ended_from'] if stage==previous['stage'] else (
            {k:previous[k] for k in ('stage','round','final')} if stage in TERMINAL else None)
        current.update(stage=stage, round=round_number, final=final, ended_from=ended_from,
                       observed_at=observed_at, updated_at=time.time(), source=source,
                       reference=reference, summary=summary, version=previous['version']+1)
        current['assessment_type'] = (assessment_type or previous.get('assessment_type','unknown')
            if stage=='assessment' and previous['stage']=='assessment' else assessment_type or 'unknown')
        # An explicit reclassification corrects the earlier interpretation rather
        # than leaving a mistakenly classified interview counted forever.
        if action=='correct' and stage not in TERMINAL and (
            RANK[stage]<RANK[previous['stage']] or stage==previous['stage']=='assessment'):
            current['advancement_reset_at']=time.time()
            current['advancement_reset_key']=event_key
        if source in {'owner','web-owner'}: current['manual_updated_at']=time.time()
        put(c, current)
        if source in {'owner','web-owner'}:
            # Restoring a pre-submission snapshot must not erase a later owner
            # progress edit. Keep the submission undo guard stale after this edit.
            c.execute('UPDATE applications SET version=version+1 WHERE application_id=?',(row['id'],))
    event = dict(application_id=row['id'], **{'from':previous['stage'],'to':stage},
        round=current['round'] if not reason else interview_round, final=current['final'],
        previous_round=previous['round'], observed_at=observed_at, recorded_at=time.time(),
        source=source, reference=reference, summary=summary, action=action,
        assessment_type=current.get('assessment_type','unknown') if not reason else assessment_type or 'unknown',
        applied=not bool(reason), reason=reason)
    c.execute("INSERT INTO application_events(event_key,application_id,kind,payload,created) VALUES(?,?,'progress',?,?)",
              (event_key,row['id'],json.dumps(event,ensure_ascii=False),time.time()))
    return dict(duplicate=False, applied=not bool(reason), progress=public_state(current), reason=reason)


class ApplicationProgress:
    def __init__(self, store): self.store=store

    def record_pending_email(self, message_id, received_at, company, stage, summary,
                             candidate_ids=None, candidate_job_ids=None, assessment_type='unknown'):
        """Keep verified mail visible while its exact application remains unresolved."""
        if not isinstance(message_id,str) or len(message_id)<12 or any(x not in '0123456789abcdef' for x in message_id):
            raise ValueError('Use the actual Gmail message ID')
        observed=timestamp(received_at)
        if stage not in STAGES or assessment_type not in ASSESSMENT_TYPES: raise ValueError('Invalid progress')
        if not isinstance(company,str) or not 1<=len(company)<=100: raise ValueError('Invalid company')
        if not isinstance(summary,str) or not 1<=len(summary)<=300: raise ValueError('Use a brief factual summary')
        with self.store.connect(True) as c:
            rows=records.read(c); candidates=[]
            for aid in candidate_ids or []:
                row=next((r for r in rows if r.get('id')==aid),None)
                if row is None: raise ValueError('Unknown candidate application')
                candidates.append({k:row[k] for k in ('id','companyName','jobTitle','jobLink')})
            for jid in candidate_job_ids or []:
                if not c.execute('SELECT 1 FROM jobs WHERE id=?',(jid,)).fetchone(): raise ValueError('Unknown candidate job')
            key='email:'+message_id
            payload=dict(job_id=key,message_id=message_id,received_at=observed,companyName=company,
                         stage=stage,summary=summary,assessment_type=assessment_type,
                         reason='application_match_pending',candidates=candidates,candidate_job_ids=candidate_job_ids or [])
            old=c.execute("SELECT payload FROM application_events WHERE event_key=? AND kind='pending'",('pending:'+key,)).fetchone()
            if old:
                if json.loads(old[0])!=payload: raise ValueError('Pending email already has a different review')
                return dict(duplicate=True,review=payload)
            c.execute("INSERT INTO application_events(event_key,kind,payload,created) VALUES(?,'pending',?,?)",('pending:'+key,json.dumps(payload,ensure_ascii=False),time.time()))
            return dict(duplicate=False,review=payload)

    def list(self, query='', stage=None, limit=50, cursor=None, application_id=None):
        if not isinstance(query,str) or len(query)>200 or not 1<=limit<=100: raise ValueError('Invalid search')
        if stage is not None and stage not in STAGES: raise ValueError('Invalid stage')
        with self.store.connect() as c:
            rows=project_display(c,records.read(c))
            index=job_index(c)
            result=[]
            for row in sorted(rows,key=lambda r:r.get('id','')):
                if not row.get('id'): continue
                if application_id and row['id']!=application_id: continue
                if cursor and row['id']<=cursor: continue
                if query.lower() not in (row['companyName']+' '+row['jobTitle']).lower(): continue
                current=state(c,row['id'])
                if not current or stage and current['stage']!=stage: continue
                item={k:row[k] for k in ('id','jobTitle','jobLink','companyName','date','profileName')}
                item['progress']=row['progress']
                item['job_ids']=sorted(index.get(job_key(row['jobLink']),set()))
                if application_id:
                    item['history']=[{**(event:=json.loads(r[0])), 'from_label':stage_label(event['from'],event.get('previous_round')),'to_label':stage_label(event['to'],event.get('round'),event.get('final'),event.get('assessment_type'))} for r in c.execute(
                        "SELECT payload FROM application_events WHERE application_id=? AND kind='progress' ORDER BY rowid",(row['id'],))]
                result.append(item)
                if len(result)>limit: break
            return dict(applications=result[:limit], next_cursor=result[limit-1]['id'] if len(result)>limit else None,
                        stages=LABELS, unresolved_matches=pending_reviews(c))

    def update(self, application_id, stage, expected_version, idempotency_key, summary,
               action='set', interview_round=None, is_final=None, observed_at=None,
               source='owner', reference='', assessment_type=None):
        if source not in {'owner','web-owner','email'}: raise ValueError('Invalid source')
        if not isinstance(summary,str) or not 1<=len(summary.strip())<=300: raise ValueError('Provide a brief factual summary')
        if not isinstance(reference,str) or len(reference)>200: raise ValueError('Invalid reference')
        if source=='email' and (len(reference)<12 or any(x not in '0123456789abcdefABCDEF' for x in reference)):
            raise ValueError('Email updates require the actual Gmail message ID')
        if source=='email' and observed_at is None: raise ValueError('Email updates require the actual received timestamp')
        observed=timestamp(observed_at) if observed_at else time.time()
        with self.store.connect(True) as c:
            checksum,old=self.store._idem(c,idempotency_key,['application-progress',application_id,stage,
                expected_version,summary,action,interview_round,is_final,observed_at,source,reference]+
                ([assessment_type] if assessment_type is not None else []))
            if old is not None:return old
            row=next((r for r in records.read(c) if r.get('id')==application_id),None)
            if not row: raise ValueError('Application not found; list application states first')
            current=state(c,application_id)
            from .recruiting import authorized_mailbox
            event_key='email:'+authorized_mailbox(c)+':'+reference.lower() if source=='email' else 'update:'+idempotency_key
            seen=c.execute('SELECT payload FROM application_events WHERE event_key=?',(event_key,)).fetchone()
            if seen:
                event=json.loads(seen[0])
                if event['application_id']!=application_id or event['to']!=stage: raise ValueError('Message already belongs to another application or stage')
                return dict(duplicate=True,applied=event['applied'],progress=public_state(current))
            if type(expected_version) is not int or current['version']!=expected_version:
                raise ProfileConflict('申请进度已更新，请重新读取后操作')
            result=apply_event(c,row,stage=stage,observed_at=observed,source=source,reference=reference.lower() if source=='email' else reference,
                summary=summary.strip(),event_key=event_key,action=action,interview_round=interview_round,is_final=is_final,
                assessment_type=assessment_type)
            if result['applied']:
                if source=='email':
                    for pending in pending_reviews(c):
                        if pending['message_id']==reference.lower() and any(r['id']==application_id for r in pending['candidates']):
                            c.execute("UPDATE application_events SET kind='pending_resolved' WHERE event_key=?",('pending:'+pending['job_id'],))
                sync_records(c)
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',(idempotency_key,checksum,json.dumps(result)))
            return result
