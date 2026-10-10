"""Private board and screening share canonical jobs and the application ledger."""
import hashlib
import json
import math
import re
import time
from urllib.parse import urlsplit

from .scope import discovery_scope
from .geography import non_us_only, screening_locations
from .role_families import FAMILIES
from .intern_companies import normalize_company

KINDS = {'newgrad', 'internship'}
REASONS = {'phd', 'data_analyst', 'data_science', 'off_target_role', 'non_us_only', 'no_sponsorship', 'citizenship', 'clearance', 'manual'}
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
        from .board_query import rows
        return rows(self.store,kind,include_history)

    def list(self, *args, **filters):
        if 'summary_only' in filters:
            raise ValueError('Unsupported list option')
        return self._listing(*args, **filters)

    def _listing(self, kind='newgrad', view='jobs', text='', category='', location='', status='not_started', group='', screening='', page=1, page_size=50, added_since=None, added_before=None, region='', exclude_data_engineering='', exclude_titles='', roles='', intern_companies='', exclude_companies='', compact='', company_filter='', company_newgrad=None, company_internship=None, summary_only=False):
        selected_roles = set(roles.split(',')) if roles else FAMILIES
        if selected_roles - (FAMILIES | {'none'}): raise ValueError('Invalid role family')
        if region not in {'','ca','ca_remote','focus_remote'}: raise ValueError('Invalid region')
        if intern_companies not in {'','1'}: raise ValueError('Invalid internship company filter')
        if compact not in {'','1'}: raise ValueError('Invalid compact filter')
        if company_filter not in {'','1'} or any(v not in {None,'','1'} for v in (company_newgrad,company_internship)):
            raise ValueError('Invalid company filter')
        selected_company = company_newgrad if kind=='newgrad' else company_internship
        company_filter = selected_company if selected_company is not None else company_filter
        # Older pages/bookmarks keep working until refreshed. New pages send
        # independent region and company preferences for each employment kind.
        if compact=='1' and not region: region='focus_remote'
        if kind=='internship' and (intern_companies=='1' or compact=='1'): company_filter='1'
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
        if kind not in KINDS:
            raise ValueError('Choose full-time or internship')
        from .board_query import listing
        result = listing(self.store,kind=kind,view=view,status=status,text=text,location=location,
            category=category,group=group,screening=screening,page=page,page_size=page_size,
            added_since=added_since,added_before=added_before,region=region,company_filter=company_filter,
            excluded_companies=excluded_companies,selected_roles=selected_roles,
            exclude_data_engineering=exclude_data_engineering,title_patterns=title_patterns,summary_only=summary_only)
        if not summary_only:
            result.update(rules=RULES,source_health=self.store.health()['sources'])
        return result

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
        rows = sorted((r for r in self._rows(kind) if r['status']=='not_started' and r['application_version']==0
                       and r['screening']=='pending'
                       and not (r['review'] and r['review']['manual_keep']) and (not cursor or r['id']>cursor)), key=lambda r:r['id'])
        selected = rows[:limit]
        return {'jobs':selected,'next_cursor':selected[-1]['id'] if len(rows)>limit else None,'rules':RULES}

    def review(self, job_id, kind, decision, reason, detail, evidence, expected_fingerprint, expected_version, key, actor='gpt-work', role_family=None, role_evidence=None, company_recommended=None, expected_company_fingerprint=None):
        if kind not in KINDS or decision not in {'keep','review','trash','restore'}:
            raise ValueError('Invalid screening decision')
        if not detail.strip() or len(detail)>2000 or len(evidence)>5:
            raise ValueError('A concise reason and at most five evidence items are required')
        if company_recommended is not None or expected_company_fingerprint is not None:
            raise ValueError('Company decisions belong to the shared company list; use set_company_preference')
        if decision=='trash':
            if reason not in REASONS or (reason=='manual' and actor!='web-owner'):
                raise ValueError('Not an authorized removal reason')
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
                if reason in {'no_sponsorship','citizenship'}:
                    from .sponsorship import restriction, title_citizenship
                    supported = restriction(sources)
                    if not supported and reason=='citizenship':
                        supported = next(((s,s['title'],'citizenship') for s in sources if title_citizenship(s.get('title',''))),None)
                    if not supported or supported[2]!=reason or not any(
                            e['quote']==supported[1] and e['url'] in {supported[0].get('source_url'),supported[0].get('apply_url')}
                            for e in evidence):
                        raise ValueError('Removal needs an explicit, uncontradicted source restriction')
                if reason=='phd':
                    from .education import restriction as education_restriction
                    supported = education_restriction(sources)
                    if not supported or not any(e['quote']==supported[1] and
                            e['url'] in {supported[0].get('source_url'),supported[0].get('apply_url')}
                            for e in evidence):
                        raise ValueError('Doctoral removal needs exact, uncontradicted title or degree evidence')
                if reason=='data_analyst' and not re.search(r'\bdata\s+analyst\b',titles,re.I): raise ValueError('Title does not identify a Data Analyst role')
                if reason=='data_science' and not re.search(r'\bdata\s+scien(?:ce|tist)\b',titles,re.I): raise ValueError('Title does not identify a Data Science role')
                if reason=='non_us_only':
                    if not non_us_only(screening_locations(sources)):
                        raise ValueError('Mixed or unresolved locations cannot prove a non-US-only role')
                    if not any(e.get('url') in {src.get('source_url'), src.get('apply_url')}
                               and any(e['quote'].strip() in loc for loc in src.get('locations', []))
                               for e in evidence for src in sources):
                        raise ValueError('Non-US removal needs an exact current source location excerpt')
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
