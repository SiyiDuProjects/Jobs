"""Private board and screening share canonical jobs and the application ledger."""
from collections import Counter
import hashlib
import json
import math
import re
import time
from urllib.parse import urlsplit

from .scope import STREAM_IDS, discovery_scope
from .geography import matches_region
from .role_families import FAMILIES, classify
from .intern_companies import matches_company_review, normalize_company
from .recruiting import STAGES, email_url, authorized_mailbox

KINDS = {'newgrad', 'internship'}
REASONS = {'phd', 'data_analyst', 'data_science', 'off_target_role', 'employer_blacklist', 'non_us_only', 'no_sponsorship', 'clearance', 'manual'}
from .screening_policy import RULES


def safe_url(value):
    p = urlsplit(value or '')
    return p.scheme in {'https', 'http'} and bool(p.hostname) and not p.username and not p.password


def engineering_title(title):
    # Optional title-based browsing filter, never an eligibility or deletion rule.
    if re.search(r'\b(?:salesforce|cobol|mainframe|support|field service|sales|marketing|pricer|business analyst|data analytics|data governance|reporting|gis|geospatial)\b',title,re.I):
        return False
    return bool(re.search(r'\b(?:software|developer|development|devops|sre|site reliability|backend|frontend|full[ -]?stack|quantitative|quant|trading|machine learning)\b|\bAI\b.*\b(?:engineer|engineering|frameworks|applications|development)\b|\bdata[\s-]+engineer(?:ing|s)?\b',title,re.I))

def fingerprint(sources):
    # Ages, sync timestamps and source ordering must not requeue unchanged roles.
    fields = ['title','company','locations','description','degrees','sponsorship','h1b','apply_url','category']
    values = sorted({json.dumps({k:s.get(k) for k in fields}, sort_keys=True, ensure_ascii=False) for s in sources})
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()

class Board:
    def __init__(self, store):
        self.store = store

    def _rows(self, kind, include_history=False):
        if kind not in KINDS:
            raise ValueError('Choose full-time or internship')
        scope, scope_values = discovery_scope()
        with self.store.connect() as c:
            observations = c.execute(f'''SELECT o.job_id,o.payload,o.present FROM observations o
                JOIN search_index s USING(stream,source_id) WHERE s.kind=? AND o.present=1 AND s.active=1 AND s.visible=1 AND {scope}''',(kind,*scope_values)).fetchall()
            active_ids = {r['job_id'] for r in observations}
            if include_history:
                observations = [*observations, *(r for r in c.execute('''SELECT o.job_id,o.payload,o.present FROM observations o
                    JOIN applications a ON a.job_id=o.job_id WHERE json_extract(o.payload,'$.kind')=? AND a.version>0''',(kind,)) if r['job_id'] not in active_ids)]
            applications = {r['job_id']:dict(r) for r in c.execute('SELECT * FROM applications')}
            from .application_progress import job_progress
            progress = {jid:p for jid in applications if (p:=job_progress(c,jid))}
            mailbox=authorized_mailbox(c,required=False)
            for p in progress.values(): p['email_url']=email_url(p['message_id'],mailbox) if p['message_id'] else None
            reviews = {r['job_id']:dict(r) for r in c.execute('SELECT * FROM job_screening WHERE kind=?',(kind,))}
            from .job_titles import display_titles
            titles = display_titles(c)
            role_families = {r['job_id']:dict(r) for r in c.execute('SELECT * FROM job_role_family WHERE kind=?',(kind,))}
            opened = dict(c.execute('SELECT job_id,opened_at FROM web_opened WHERE kind=?',(kind,)))
            undo = {r['job_id']:r['version'] for r in c.execute('SELECT job_id,version FROM owner_submission_undo WHERE expires>?',(time.time(),))}
            first_seen = dict(c.execute('SELECT id,first_seen FROM jobs'))
            added_at = dict(c.execute(f'''SELECT job_id,min(first_seen) FROM observations
                WHERE stream IN ({','.join('?' for _ in STREAM_IDS)}) AND json_extract(payload,'$.kind')=?
                GROUP BY job_id''',(*STREAM_IDS,kind)))
            companies = {json.loads(r[0]).get('company','').casefold() for r in c.execute("SELECT payload FROM observations WHERE present=1 AND json_extract(payload,'$.section')='FAANG+'")}
        grouped = {}
        for row in observations:
            grouped.setdefault(row['job_id'], []).append(json.loads(row['payload']))
        result = []
        for jid, sources in grouped.items():
            sources.sort(key=lambda s:({'simplify':0,'speedyapply':1}.get(s['source'],9), s.get('source_id','')))
            app, review = applications[jid], reviews.get(jid)
            primary = sources[0]
            locations = list(dict.fromkeys(loc for s in sources for loc in s.get('locations',[])))
            urls = list(dict.fromkeys(s['apply_url'] for s in sources if safe_url(s.get('apply_url'))))
            token = fingerprint(sources)
            fp = review['fingerprint'] if review else None
            family, basis = classify(sources, role_families.get(jid), token)
            big = primary['company'].casefold() in companies or primary['company'].casefold() in {'google','alphabet','meta','facebook','apple','amazon','netflix'}
            result.append({'id':jid,'kind':kind,'company':primary['company'],'title':titles.get(jid,primary['title']),
                'role_family':family,'role_basis':basis,'locations':locations,'categories':list(dict.fromkeys(s.get('category','') for s in sources)),
                'sources':list(dict.fromkeys(s['source'] for s in sources)), 'apply_url':urls[0] if urls else None,
                'source_url':next((s.get('source_url') for s in sources if safe_url(s.get('source_url'))),None),
                'posted_at':max((s.get('posted_at') or 0 for s in sources),default=0) or None,
                'first_seen':first_seen[jid], 'added_at':added_at.get(jid,first_seen[jid]), 'status':app['status'], 'application_version':app['version'],
                'application_detail':app['detail'],'progress':progress.get(jid),'group':'faang' if big else 'other','fingerprint':token,
                'opened_at':opened.get(jid), 'can_undo_submission':app['status'] in {'submitted','submitted_unconfirmed'} and undo.get(jid)==app['version'],
                'active':jid in active_ids, 'review_version':review['version'] if review else 0,'review':review,
                'screening': 'pending' if not review or (fp != token and review['state'] != 'trash' and not review['manual_keep']) else review['state'],
                'all_sources':sources})
        return result

    def list(self, *args, **filters):
        if 'summary_only' in filters:
            raise ValueError('Unsupported list option')
        return self._listing(*args, **filters)

    def _listing(self, kind='newgrad', view='jobs', text='', category='', location='', status='not_started', group='', screening='', page=1, page_size=50, added_since=None, added_before=None, region='', exclude_data_engineering='', exclude_titles='', roles='', intern_companies='', exclude_companies='', compact='', summary_only=False):
        selected_roles = set(roles.split(',')) if roles else FAMILIES
        if selected_roles - (FAMILIES | {'none'}): raise ValueError('Invalid role family')
        if region not in {'','ca','ca_remote','focus_remote'}: raise ValueError('Invalid region')
        if intern_companies not in {'','1'}: raise ValueError('Invalid internship company filter')
        if compact not in {'','1'}: raise ValueError('Invalid compact filter')
        if len(exclude_companies)>1000: raise ValueError('Excluded company names are too long')
        excluded_companies={normalize_company(v) for v in re.split('[,，;；\n]',exclude_companies) if v.strip()}
        if len(excluded_companies)>20: raise ValueError('Use at most 20 excluded companies')
        if exclude_data_engineering not in {'','1'}: raise ValueError('Invalid Data Engineer filter')
        if len(exclude_titles)>256: raise ValueError('Excluded keywords are too long')
        keywords=[v.strip() for v in re.split('[,，;；\n]',exclude_titles) if v.strip()]
        if len(keywords)>12: raise ValueError('Use at most 12 excluded keywords')
        title_patterns=[re.compile(r'(?<!\w)'+re.escape(v)+r'(?!\w)',re.I) for v in keywords]
        if view not in {'jobs','trash'} or page < 1 or not 1 <= page_size <= 100:
            raise ValueError('Invalid page or view')
        if any(t is not None and (not math.isfinite(t) or t<0) for t in (added_since,added_before)):
            raise ValueError('Invalid added date timestamp')
        if added_since is not None and added_before is not None and added_before<=added_since:
            raise ValueError('Invalid added date range')
        # Recent view keeps completed rows in place without importing old history.
        rows = self._rows(kind,include_history=view=='jobs' and status not in {'not_started','recent','unsubmitted'})
        # Trash may outlive its source listing during the 24-hour undo window.
        if view == 'trash':
            present = {r['id'] for r in rows}
            with self.store.connect() as c:
                missing = [dict(r) for r in c.execute("SELECT * FROM job_screening WHERE kind=? AND state='trash' AND expires_at>?",(kind,time.time())) if r['job_id'] not in present]
            for review in missing:
                job = self.store.get_jobs([review['job_id']])[0]
                source = next((s for s in job['all_sources'] if s['kind']==kind), {})
                rows.append({'id':job['id'],'kind':kind,'company':source.get('company',''),'title':source.get('title',''),
                    'locations':source.get('locations',[]),'categories':[source.get('category','')],'sources':[source.get('source','')],
                    'apply_url':source.get('apply_url'),'source_url':source.get('source_url'),'posted_at':source.get('posted_at'),
                    'first_seen':job['first_seen'],'status':job['status'],'application_version':job['version'],'application_detail':job['detail'],
                    'group':'other','fingerprint':review['fingerprint'],'review_version':review['version'],'review':review,'screening':'trash','all_sources':[]})
        def visible(r):
            # The displayed FAANG+ tag exempts jobs only from compact presets.
            compact_exempt = view=='jobs' and compact=='1' and r['group']=='faang'
            trash = r['review'] and r['review']['state']=='trash'
            if view=='trash':
                if not trash or r['review']['expires_at'] <= time.time(): return False
            elif trash: return False
            if view=='jobs' and any(normalize_company(s.get('company','')) in excluded_companies for s in r['all_sources']): return False
            # The shared browser preference must never filter full-time or recycle rows.
            if view=='jobs' and kind=='internship' and intern_companies=='1' and not compact_exempt:
                if not any(matches_company_review(s.get('company','')) for s in r['all_sources']): return False
            if view!='trash' and added_since is not None and r['added_at']<added_since: return False
            if view!='trash' and added_before is not None and r['added_at']>=added_before: return False
            if view!='trash' and status in STAGES:
                if not r.get('progress') or r['progress']['stage']!=status: return False
            elif view!='trash' and status=='unsubmitted':
                if r['status'] in {'submitted','submitted_unconfirmed'}: return False
            elif view!='trash' and status not in {'','recent'} and r['status']!=status: return False
            if text.casefold() not in (r['company']+' '+r['title']).casefold(): return False
            if location.casefold() not in ' '.join(r['locations']).casefold(): return False
            if not compact_exempt and not matches_region(r['locations'],region): return False
            if view!='trash' and r['role_family'] not in selected_roles: return False
            if category=='engineering':
                if not engineering_title(r['title']): return False
            elif category and category not in r['categories']: return False
            if view!='trash':
                if exclude_data_engineering=='1' and re.search(r'\bdata[\s-]+engineer(?:ing|s)?\b',r['title'],re.I): return False
                if any(p.search(r['title']) for p in title_patterns): return False
            if group and group!=r['group']: return False
            return not screening or screening==r['screening']
        selected = [r for r in rows if visible(r)]
        total = len(selected)
        application_counts = {'submitted':0, 'not_started':0, **Counter(r['status'] for r in selected)}
        # Counts share the exact predicate, without sorting/serializing a page,
        # reading source health or asking the filesystem for disk usage.
        if summary_only:
            return {'total':total,'application_counts':application_counts}
        recent = sorted((r for r in rows if r.get('opened_at') and r['status'] not in {'submitted','submitted_unconfirmed'} and r['screening']!='trash'), key=lambda r:-r['opened_at']) if view=='jobs' else []
        recent = [{k:r[k] for k in ('id','company','title','application_version','opened_at')} for r in recent]
        # One chronological list; the optional company-group filter selects FAANG+.
        selected.sort(key=lambda r: (-(r['added_at'] if added_since is not None and view!='trash' else r['posted_at'] or r['first_seen']), r['id']))
        counts = {g:sum(r['group']==g for r in selected) for g in ['faang','other']}
        selected = selected[(page-1)*page_size:page*page_size]
        for r in selected:
            r.pop('all_sources',None)
            if r['review']: r['review']['evidence']=json.loads(r['review']['evidence'])
        return {'jobs':selected,'recent_opened':recent,'application_counts':application_counts,'total':total,'groups':counts,'page':page,'page_size':page_size,'rules':RULES,
                'source_health':self.store.health()['sources']}

    def filter_counts(self, **filters):
        # Use the exact list predicate before pagination for both employment kinds.
        for key in ('kind','view','page','page_size'):
            filters.pop(key, None)
        result = {}
        for kind in ('newgrad','internship'):
            listing = self._listing(kind=kind,page_size=1,summary_only=True,**filters)
            result[kind] = {'total':listing['total'], **listing['application_counts']}
        result['total'] = sum(result[k]['total'] for k in ('newgrad','internship'))
        return result

    def queue(self, kind, limit=50, cursor=None, run_id=None):
        if run_id:
            from .screening_progress import ScreeningProgress
            return ScreeningProgress(self.store).queue(run_id,kind,limit,cursor)
        if not 1<=limit<=100: raise ValueError('limit must be 1..100')
        rows = sorted((r for r in self._rows(kind) if r['status']=='not_started' and r['application_version']==0 and r['screening']=='pending'
                       and not (r['review'] and r['review']['manual_keep']) and (not cursor or r['id']>cursor)), key=lambda r:r['id'])
        selected = rows[:limit]
        return {'jobs':selected,'next_cursor':selected[-1]['id'] if len(rows)>limit else None,'rules':RULES}

    def review(self, job_id, kind, decision, reason, detail, evidence, expected_fingerprint, expected_version, key, actor='gpt-work', role_family=None, role_evidence=None):
        if kind not in KINDS or decision not in {'keep','review','trash','restore'}:
            raise ValueError('Invalid screening decision')
        if not detail.strip() or len(detail)>2000 or len(evidence)>5:
            raise ValueError('A concise reason and at most five evidence items are required')
        if decision=='trash':
            if reason not in REASONS or (reason=='manual' and actor!='web-owner'):
                raise ValueError('Not an authorized removal reason')
            if reason=='no_sponsorship' and kind!='newgrad':
                raise ValueError('Never remove internships for sponsorship')
            if not evidence or any(not safe_url(e.get('url')) or not e.get('quote') or not e.get('observed_at') for e in evidence):
                raise ValueError('Removal requires a source URL, exact supporting excerpt and observation timestamp')
        role_evidence = role_evidence or []
        if role_family is not None:
            if role_family not in FAMILIES or decision not in {'keep','review'}: raise ValueError('Invalid role classification')
            if len(role_evidence)>3 or (role_family!='unknown' and not role_evidence): raise ValueError('Role classification needs official duty evidence')
            if any(not safe_url(e.get('url')) or not e.get('quote') or not e.get('observed_at') for e in role_evidence): raise ValueError('Invalid role evidence')
        elif role_evidence: raise ValueError('Role evidence requires a role family')
        payload = [job_id,kind,decision,reason,detail,evidence,expected_fingerprint,expected_version,actor]
        if role_family is not None: payload += [role_family,role_evidence]
        with self.store.connect(True) as c:
            checksum, old = self.store._idem(c,key,['screening',payload])
            if old is not None: return old
            self.store.require_current_job(c,job_id)
            app = c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone()
            previous = c.execute('SELECT * FROM job_screening WHERE job_id=? AND kind=?',(job_id,kind)).fetchone()
            if not app or (previous['version'] if previous else 0)!=expected_version: raise ValueError('Screening version changed; reload')
            if previous and previous['state']=='trash' and decision!='restore':
                raise ValueError('Deleted tag is persistent; use an explicit restore within 24 hours')
            scope, scope_values = discovery_scope()
            source_rows = c.execute(f"SELECT o.payload FROM observations o JOIN search_index s USING(stream,source_id) WHERE o.job_id=? AND s.kind=? AND o.present=1 AND s.active=1 AND s.visible=1 AND {scope}",(job_id,kind,*scope_values)).fetchall()
            sources = [json.loads(r[0]) for r in source_rows]
            current_fp = fingerprint(sources)
            if decision=='restore':
                if not previous or previous['state']!='trash' or previous['expires_at']<=time.time(): raise ValueError('Restore window expired')
                current_fp = current_fp if sources else previous['fingerprint']
            elif not sources or current_fp!=expected_fingerprint:
                raise ValueError('Source content changed; inspect the latest job')
            if decision=='trash':
                from .application_records import can_remove_unsubmitted
                # An owner may abandon an unsubmitted draft without erasing its
                # history. Automatic screening still protects processed roles.
                if not can_remove_unsubmitted(app) or (actor!='web-owner' and (app['status']!='not_started' or app['version']!=0)):
                    raise ValueError('Processed or claimed applications are protected')
                if previous and previous['manual_keep'] and actor!='web-owner': raise ValueError('Manually kept role is protected')
                titles=' '.join(s.get('title','') for s in sources)
                if reason=='employer_blacklist':
                    from .employer_blacklist import blocked_employer
                    if not any(blocked_employer(s.get('company')) for s in sources):
                        raise ValueError('Company is not on the owner blacklist')
                if reason=='phd' and not re.search(r'\bph\.?\s*d\b',titles,re.I): raise ValueError('Title does not contain PhD / Ph.D.')
                if reason=='data_analyst' and not re.search(r'\bdata\s+analyst\b',titles,re.I): raise ValueError('Title does not identify a Data Analyst role')
                if reason=='data_science' and not re.search(r'\bdata\s+scien(?:ce|tist)\b',titles,re.I): raise ValueError('Title does not identify a Data Science role')
                if reason=='off_target_role':
                    # Verify that the judgment cites this job's actual available
                    # material; the AI, not a keyword allowlist, judges relevance.
                    supported = any(
                        e.get('url') in {src.get('source_url'), src.get('apply_url')}
                        and e.get('quote', '').strip()
                        and any(e['quote'].strip().casefold() in str(src.get(field) or '').casefold()
                                for field in ('title', 'description'))
                        for e in evidence for src in sources)
                    if not supported:
                        raise ValueError('Non-target judgment needs an exact current title or summary excerpt and its source URL')
            state='keep' if decision=='restore' else decision
            version=expected_version+1
            now=time.time()
            manual_keep=1 if decision=='restore' else (previous['manual_keep'] if previous else 0)
            c.execute('''INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,kind) DO UPDATE SET
                state=excluded.state,reason=excluded.reason,detail=excluded.detail,evidence=excluded.evidence,fingerprint=excluded.fingerprint,
                reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,version=excluded.version,manual_keep=excluded.manual_keep''',
                (job_id,kind,state,reason,detail,json.dumps(evidence),current_fp,now,now+86400 if state=='trash' else None,version,manual_keep))
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'screening',?,?,?)",(job_id,actor,now,json.dumps(payload)))
            if role_family is not None:
                c.execute('INSERT OR REPLACE INTO job_role_family VALUES(?,?,?,?,?,?)',(job_id,kind,role_family,current_fp,json.dumps(role_evidence),now))
            result={'job_id':job_id,'kind':kind,'state':state,'version':version,'expires_at':now+86400 if state=='trash' else None}
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',(key,checksum,json.dumps(result)))
            return result

    def opened(self, job_id, kind, dismiss=False):
        if kind not in KINDS: raise ValueError('Invalid kind')
        with self.store.connect(True) as c:
            self.store.require_current_job(c,job_id)
            if not c.execute("SELECT 1 FROM observations WHERE job_id=? AND json_extract(payload,'$.kind')=?",(job_id,kind)).fetchone():
                raise ValueError('Job missing')
            if dismiss:
                c.execute('DELETE FROM web_opened WHERE job_id=? AND kind=?',(job_id,kind))
            else:
                c.execute('INSERT INTO web_opened VALUES(?,?,?) ON CONFLICT(job_id,kind) DO UPDATE SET opened_at=excluded.opened_at',(job_id,kind,time.time()))
        return {'job_id':job_id,'opened':not dismiss}

    def mark_submitted(self, job_id, version, reference='', key=None):
        # Explicit owner attestation; clicking an Apply link is never a submission.
        if not isinstance(reference,str) or len(reference)>1000: raise ValueError('Invalid confirmation reference')
        with self.store.connect(True) as c:
            checksum, old=self.store._idem(c,key,['owner-submitted',job_id,version,reference])
            if old is not None: return old
            self.store.require_current_job(c,job_id)
            app=c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone()
            if not app or app['version']!=version or app['status']=='submitted': raise ValueError('Application state changed; reload')
            reviews=[dict(r) for r in c.execute("SELECT * FROM job_screening WHERE job_id=? AND state='trash'",(job_id,))]
            c.execute('INSERT OR REPLACE INTO owner_submission_undo VALUES(?,?,?,?,?)',(job_id,version+1,time.time()+86400,json.dumps(dict(app)),json.dumps(reviews)))
            evidence=[{'type':'official_success' if reference.strip() else 'owner_confirmation','reference':reference.strip() or 'Owner clicked 已投递 to confirm their completed application','observed_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'reported_by':'owner'}]
            from .application_records import write_state
            write_state(c,job_id,dict(status='submitted',updated=time.time(),detail='Owner confirmed submission on the board',
                evidence=json.dumps(evidence),attempted_at=app['attempted_at'] or time.time(),confirmed_at=time.time()),version_step=1,reason='owner_confirmation')
            c.execute("UPDATE job_screening SET state='keep',manual_keep=1,expires_at=NULL,version=version+1 WHERE job_id=? AND state='trash'",(job_id,))
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'owner_submission','web-owner',?,?)",(job_id,time.time(),json.dumps(evidence)))
            from .application_records import add_manual
            add_manual(c,job_id)
            result={'job_id':job_id,'status':'submitted','version':version+1}
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',(key,checksum,json.dumps(result)))
            return result

    def undo_submitted(self, job_id, version, key):
        with self.store.connect(True) as c:
            checksum,old=self.store._idem(c,key,['undo-owner-submitted',job_id,version])
            if old is not None: return old
            self.store.require_current_job(c,job_id)
            snapshot=c.execute('SELECT * FROM owner_submission_undo WHERE job_id=?',(job_id,)).fetchone()
            app=c.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone()
            if not snapshot or snapshot['expires']<=time.time(): raise ValueError('撤销期限已过')
            if not app or app['status'] not in {'submitted','submitted_unconfirmed'} or app['version']!=version or snapshot['version']!=version:
                raise ValueError('投递记录已更新，请刷新；不能撤销其他操作')
            for review in json.loads(snapshot['reviews']):
                current=c.execute('SELECT * FROM job_screening WHERE job_id=? AND kind=?',(job_id,review['kind'])).fetchone()
                if not current or current['version']!=review['version']+1: raise ValueError('初筛记录已更新，请刷新')
                c.execute('''UPDATE job_screening SET state=?,reason=?,detail=?,evidence=?,fingerprint=?,reviewed_at=?,expires_at=?,version=version+1,manual_keep=? WHERE job_id=? AND kind=?''',
                    tuple(review[k] for k in ('state','reason','detail','evidence','fingerprint','reviewed_at','expires_at','manual_keep'))+(job_id,review['kind']))
            before=json.loads(snapshot['application'])
            restored=('status','detail','evidence','owner_run_id','record','progress','attempted_at','confirmed_at','submission_error','deleted')
            from .application_records import write_state
            write_state(c,job_id,{**{key:before.get(key,0 if key=='deleted' else None) for key in restored},'updated':time.time()},
                version_step=1,record_step=1,reason='owner_undo')
            c.execute('DELETE FROM owner_submission_undo WHERE job_id=?',(job_id,))
            c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'owner_submission_undo','web-owner',?,?)",(job_id,time.time(),json.dumps({'from_version':version,'restored_status':before['status']})))
            result={'job_id':job_id,'status':before['status'],'version':version+1}
            c.execute('INSERT INTO idempotency VALUES(?,?,?)',(key,checksum,json.dumps(result)))
            return result
