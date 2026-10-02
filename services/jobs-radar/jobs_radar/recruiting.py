"""Private, evidence-linked recruiting progress. Email content is untrusted data."""
import json
import time
from urllib.parse import quote

from .application_progress import STAGES as PROGRESS_STAGES
STAGES = set(PROGRESS_STAGES) | {'received'}


def authorized_mailbox(c, required=True):
    """Reuse the server's authorized mailbox, then one unambiguous Profile email."""
    configured={r[0] for r in c.execute('SELECT mailbox FROM recruiting_sync') if r[0]}
    if len(configured)==1:return next(iter(configured))
    if len(configured)>1:raise ValueError('Multiple authorized recruiting mailboxes require owner review')
    from .application_schema import table_exists
    emails=set()
    if table_exists(c,'owner_profiles'):
        for row in c.execute('SELECT profile FROM owner_profiles WHERE deleted=0'):
            email=json.loads(row[0]).get('contactData',{}).get('email')
            if isinstance(email,str) and '@' in email:emails.add(email.strip())
    if len(emails)==1:return next(iter(emails))
    if required:raise ValueError('A single authorized recruiting mailbox must be confirmed in the server Profile')
    return None


def email_url(message_id, mailbox=None):
    account='?authuser='+quote(mailbox) if mailbox else ''
    return f'https://mail.google.com/mail/u/{account}#all/{message_id}'


class Recruiting:
    def __init__(self, store):
        self.store = store

    @property
    def mailbox(self):
        with self.store.connect() as c:return authorized_mailbox(c)

    def overview(self):
        """Lifetime recorded applications, independent of discovery and display filters."""
        fields = ('submitted', 'waiting', 'assessment', 'phone_screen', 'screen', 'interview', 'offer',
                  'accepted', 'rejected', 'withdrawn', 'offer_declined', 'archived', 'unverified', 'ever_advanced', 'submission_unconfirmed')
        counts = {kind:dict.fromkeys(fields, 0) for kind in ('newgrad','internship','unknown')}
        with self.store.connect() as c:
            # One canonical application contributes exactly once, including retired sources.
            from .application_progress import advanced_applications, job_progress
            advanced_ids,_=advanced_applications(c)
            rows=[];advanced=set();assessment_types={}
            for app in c.execute("SELECT * FROM applications WHERE status IN ('submitted','submitted_unconfirmed') AND job_id NOT IN (SELECT alias_id FROM job_aliases)"):
                progress=json.loads(app['progress']) if app['progress'] else None
                view=job_progress(c,app['job_id'])
                kinds={r[0] for r in c.execute("SELECT DISTINCT json_extract(payload,'$.kind') FROM observations WHERE job_id=?",(app['job_id'],))}
                if not kinds and app['record']:
                    kinds={{'Newgrad':'newgrad','Intern':'internship'}.get(json.loads(app['record']).get('profileName'),'unknown')}
                rows.append(dict(job_id=app['job_id'],status=app['status'],stage=view['stage'] if view else None,kinds=next(iter(kinds)) if len(kinds)==1 else 'unknown'))
                if app['application_id'] in advanced_ids:advanced.add(app['job_id'])
                if progress:assessment_types[app['job_id']]=progress.get('assessment_type','unknown')
            sync = c.execute('SELECT last_success FROM recruiting_sync WHERE mailbox=?',(authorized_mailbox(c,required=False),)).fetchone()
        for row in rows:
            bucket = counts[row['kinds'] if row['kinds'] in ('newgrad','internship') else 'unknown']
            if row['status']=='submitted_unconfirmed':
                bucket['submission_unconfirmed'] += 1
                continue
            bucket['submitted'] += 1
            stage = row['stage']
            bucket['waiting' if stage=='received' else stage if stage in STAGES and stage!='applied' else 'unverified'] += 1
            if row['job_id'] in advanced or stage in ('phone_screen','interview','offer','accepted','offer_declined'):
                bucket['ever_advanced'] += 1
        from .application_progress import display_stage
        display_counts={kind:dict.fromkeys(('submitted','no_answer','assessment','interview','offer','accepted','rejected','withdrawn','offer_declined','archived'),0) for kind in counts}
        for row in rows:
            if row['status']!='submitted': continue
            bucket=display_counts[row['kinds'] if row['kinds'] in ('newgrad','internship') else 'unknown']
            bucket['submitted']+=1
            bucket[display_stage(row['stage'],row['job_id'] in advanced,assessment_types.get(row['job_id']))]+=1
        return {'counts':counts, 'total':{f:sum(v[f] for v in counts.values()) for f in fields},
                'display_counts':display_counts,
                'last_mail_sync':sync[0] if sync else None, 'as_of':time.time(),
                'scope':'All recorded canonical applications, including closed and historical jobs.',
                'waiting_definition':'Receipt confirmed, no later progress recorded. No matching email is unverified, never proof of no reply.',
                'advancement_definition':'OA counts only with evidence of prior screening. Automatic or unclassified OA does not count; completion alone is not advancement. Owner reclassifications correct historical counts.'}

    def sync_state(self):
        with self.store.connect() as c:
            row=c.execute('SELECT * FROM recruiting_sync WHERE mailbox=?',(self.mailbox,)).fetchone()
        last=row['last_success'] if row else None
        now=time.time()
        return {'mailbox':self.mailbox,'last_success':last,
                'search_after':max(0,(last-172800) if last else now-30*86400),
                'search_before':now,
                'instructions':'Read all recruiting-message pages in this window, including read mail. First run covers 30 days; later runs overlap 48 hours. Advance only after all pages and writes complete. Report ambiguous/unmatched messages for owner review; never guess a match.'}

    def finish_sync(self, expected_last_success, searched_before, all_pages_processed, summary):
        if all_pages_processed is not True or not isinstance(summary,str) or not 1<=len(summary)<=1000:
            raise ValueError('Complete all email pages and provide a concise result summary first')
        if not isinstance(searched_before,(int,float)) or not time.time()-86400<=searched_before<=time.time()+60:
            raise ValueError('Use search_before from the current sync_state')
        with self.store.connect(True) as c:
            row=c.execute('SELECT last_success FROM recruiting_sync WHERE mailbox=?',(self.mailbox,)).fetchone()
            old=row[0] if row else None
            if old==searched_before: return {'mailbox':self.mailbox,'last_success':old,'duplicate':True}
            if old!=expected_last_success or (old and searched_before<old):
                raise ValueError('Another run advanced the checkpoint; read sync state again')
            c.execute('INSERT OR REPLACE INTO recruiting_sync VALUES(?,?,?)',(self.mailbox,searched_before,summary))
        return {'mailbox':self.mailbox,'last_success':searched_before}

    def find(self, company, limit=25, cursor=None):
        """Include retired source records and all application statuses."""
        if not isinstance(company, str) or not 2 <= len(company.strip()) <= 120:
            raise ValueError('Provide a company name, at least two characters')
        if not 1 <= limit <= 100:
            raise ValueError('limit must be 1..100')
        with self.store.connect() as c:
            rows = c.execute('''SELECT DISTINCT o.job_id FROM observations o
                WHERE instr(lower(json_extract(o.payload,'$.company')),lower(?))>0
                AND o.job_id>? ORDER BY o.job_id LIMIT ?''',
                (company.strip(), cursor or '', limit+1)).fetchall()
            jobs = []
            for row in rows[:limit]:
                jid = row['job_id']
                sources = [json.loads(r[0]) for r in c.execute('SELECT payload FROM observations WHERE job_id=?', (jid,))]
                app = dict(c.execute('SELECT * FROM applications WHERE job_id=?', (jid,)).fetchone())
                from .application_progress import job_progress
                progress = job_progress(c,jid)
                jobs.append({'job_id': jid, 'application_status': app['status'], 'application_version': app['version'],
                    'progress_version': progress['version'] if progress else 0,
                    'stage': progress['stage'] if progress else None,
                    'sources': [{k:s.get(k) for k in ('company','title','kind','locations','apply_url','source_id')} for s in sources],
                    'processed_message_ids': [json.loads(r[0])['message_id'] for r in c.execute("SELECT payload FROM application_events WHERE job_id=? AND kind='mail'", (jid,))]})
        return {'mailbox': self.mailbox, 'jobs': jobs, 'next_cursor': rows[limit-1]['job_id'] if len(rows)>limit else None}
