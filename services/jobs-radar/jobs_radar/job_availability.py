"""Narrow ATS terminal-page receipts using the existing job identity and trash."""
import hashlib
import json
import re
import time
from datetime import datetime

from .board import fingerprint, safe_url
from .job_match import resolve

# Whole terminal messages, not arbitrary occurrences of 'closed' in a job description.
MESSAGES = {
    "page_missing": r"the page you are looking for (?:doesn't|does not) exist[.!]?",
    "job_missing": r"(?:this|the) (?:job|position|job posting|job requisition) (?:is no longer available|has been closed|has been filled|does not exist|was not found)[.!]?",
    "applications_closed": r"(?:this|the) (?:job|position|job posting) is no longer accepting applications[.!]?",
}


def valid_evidence(code, quote):
    return isinstance(quote, str) and len(quote) <= 250 and code in MESSAGES and bool(
        re.fullmatch(MESSAGES[code], ' '.join(quote.replace('’', "'").split()), re.I))


class JobAvailability:
    def __init__(self, store):
        self.store = store
        with store.connect() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS job_availability_events(
              event_id TEXT PRIMARY KEY,device_id TEXT,checksum TEXT,payload TEXT,
              created REAL,result TEXT)''')

    def receive(self, device, p):
        if not isinstance(p, dict): raise ValueError('Invalid availability receipt')
        allowed = {'event_id','proof','job_url','observed_at','code','quote','website_job_id','removal_event','detail'}
        if set(p) - allowed or any(not isinstance(v,str) for v in p.values()):
            raise ValueError('Invalid availability fields')
        if not re.fullmatch(r'[a-zA-Z0-9-]{20,80}', p.get('event_id','')):
            raise ValueError('Invalid event ID')
        restoring = p.get('proof') == 'undo_unavailable'
        manual = p.get('proof') == 'manual_remove'
        if 'detail' in p and (not manual or not p['detail'].strip() or len(p['detail'])>500):
            raise ValueError('Manual deletion reason must contain 1 to 500 characters')
        if p.get('proof') not in {'ats_unavailable','manual_remove','undo_unavailable'}:
            raise ValueError('Invalid proof')
        valid_reason = (p.get('code') == 'manual' and p.get('quote') == '用户在插件中手动删除岗位') if manual else valid_evidence(p.get('code'),p.get('quote'))
        if not restoring and (not safe_url(p.get('job_url')) or len(p['job_url']) > 2000 or
                              not valid_reason):
            raise ValueError('Invalid terminal-page evidence')
        if restoring and not re.fullmatch(r'[a-zA-Z0-9-]{20,80}',p.get('removal_event','')):
            raise ValueError('Invalid removal event')
        raw = json.dumps(p,sort_keys=True,separators=(',',':'))
        checksum = hashlib.sha256(raw.encode()).hexdigest()
        now = time.time()
        with self.store.connect(True) as c:
            if not c.execute('SELECT 1 FROM extension_devices WHERE device_id=? AND revoked=0 AND expires>?',(device,now)).fetchone():
                raise ValueError('Device authorization expired')
            old = c.execute('SELECT * FROM job_availability_events WHERE event_id=?',(p['event_id'],)).fetchone()
            if old:
                if old['device_id'] != device or old['checksum'] != checksum: raise ValueError('Event ID reused')
                return json.loads(old['result'])
            result = self._restore(c,device,p,now) if restoring else self._remove(c,p,now)
            result.update(event_id=p['event_id'],retryable=False)
            c.execute('INSERT INTO job_availability_events VALUES(?,?,?,?,?,?)',(p['event_id'],device,checksum,raw,now,json.dumps(result)))
            return result

    def _remove(self,c,p,now):
        manual = p['proof'] == 'manual_remove'
        try:
            observed = datetime.fromisoformat(p.get('observed_at','').replace('Z','+00:00'))
            if observed.tzinfo is None: raise ValueError('Timezone required')
            age = now - observed.timestamp()
        except (ValueError,TypeError): raise ValueError('Invalid observation timestamp')
        if not -300 <= age <= 86400: return {'state':'expired'}
        hinted = p.get('website_job_id')
        candidates, method = resolve(c, p['job_url'], hinted)
        if not candidates: return {'state':'unmatched'}
        # All IDs indexed by the same scoped requisition key are source aliases.
        # Remove the complete group atomically, never just the hinted source row.
        ordered = sorted(candidates, key=lambda jid: (jid != hinted, jid))
        c.execute('SAVEPOINT remove_aliases')
        results = [self._remove_one(c,p,now,jid) for jid in ordered]
        protected = next((r for r in results if r['state']=='protected'), None)
        if protected:
            c.execute('ROLLBACK TO remove_aliases')
            c.execute('RELEASE remove_aliases')
            return protected
        c.execute('RELEASE remove_aliases')
        removed = [{**item,'job_id':jid} for jid,r in zip(ordered,results) for item in r.get('removed',[])]
        result = next((r for r in results if r['state']=='removed'), results[0])
        return {**result, 'job_ids':ordered, 'matched_by':method, **({'removed':removed} if removed else {})}

    def _remove_one(self,c,p,now,jid):
        manual = p['proof'] == 'manual_remove'
        app = c.execute('SELECT * FROM applications WHERE job_id=?',(jid,)).fetchone()
        sources = [json.loads(row[0]) for row in c.execute('SELECT payload FROM observations WHERE job_id=?',(jid,))]
        source = sources[0] if sources else {}
        result = {'state':'protected','job_id':jid,'company':source.get('company',''),'title':source.get('title','')}
        if not app or app['status']!='not_started' or (app['version']!=0 and not manual):
            return {**result,'reason':'application_history'}
        previous = {row['kind']:row for row in c.execute('SELECT * FROM job_screening WHERE job_id=?',(jid,))}
        if not manual and any(row['manual_keep'] for row in previous.values()):
            return {**result,'reason':'manually_kept'}
        evidence = [{'url':p['job_url'],'quote':p['quote'],'observed_at':p['observed_at'],'event_id':p['event_id']}]
        reason = 'manual' if manual else 'DNE' if p['code']=='page_missing' or re.search(r'does not exist|was not found',p['quote'],re.I) else 'applications_closed' if p['code']=='applications_closed' else 'job_closed'
        detail = p.get('detail',p['quote']).strip() if manual else p['quote']
        removed = []
        for kind in sorted({s.get('kind') for s in sources} & {'newgrad','internship'}):
            old = previous.get(kind)
            if old and old['state']=='trash': continue
            version = old['version']+1 if old else 1
            fp = fingerprint([s for s in sources if s.get('kind')==kind])
            c.execute('''INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,kind) DO UPDATE SET
              state=excluded.state,reason=excluded.reason,detail=excluded.detail,evidence=excluded.evidence,
              fingerprint=excluded.fingerprint,reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,
              version=excluded.version,manual_keep=excluded.manual_keep''',
              (jid,kind,'trash',reason,detail,json.dumps(evidence),fp,now,now+86400,version,0))
            removed.append({'kind':kind,'version':version})
        if not removed: return {**result,'state':'already_removed'}
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,?,'jobs-extension',?,?)",(jid,'extension_manual_remove' if manual else 'ats_unavailable',now,json.dumps(evidence)))
        return {**result,'state':'removed','removed':removed,'removal_reason':reason,'removal_detail':detail,'expires_at':now+86400}

    def _restore(self,c,device,p,now):
        original = c.execute('SELECT * FROM job_availability_events WHERE event_id=? AND device_id=?',(p['removal_event'],device)).fetchone()
        if not original: raise ValueError('Unknown removal')
        result = json.loads(original['result'])
        if result['state']!='removed': raise ValueError('Receipt did not remove a job')
        if result['expires_at']<=now: return {'state':'restore_expired'}
        jid = result['job_id']
        rows = []
        for removed in result['removed']:
            row = c.execute('SELECT * FROM job_screening WHERE job_id=? AND kind=?',(removed.get('job_id',jid),removed['kind'])).fetchone()
            if row and row['state']=='keep' and row['manual_keep']: continue
            if not row or row['state']!='trash' or row['version']!=removed['version'] or row['reason']!=result['removal_reason']:
                return {'state':'restore_conflict'}
            rows.append(row)
        for row in rows:
            c.execute("UPDATE job_screening SET state='keep',manual_keep=1,expires_at=NULL,version=version+1 WHERE job_id=? AND kind=?",(row['job_id'],row['kind']))
        c.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'ats_unavailable_undo','owner',?,?)",(jid,now,json.dumps({'removal_event':p['removal_event']})))
        return {'state':'restored','job_id':jid,'title':result['title'],'company':result['company']}
