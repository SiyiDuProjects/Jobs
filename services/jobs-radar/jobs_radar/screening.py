"""Apply the owner's explicit title exclusions before a sync becomes visible."""
import json
import re
import time

from .board import fingerprint, safe_url
from .scope import discovery_scope
from .sponsorship import restriction, title_citizenship
from .geography import non_us_only, screening_locations
from .education import restriction as education_restriction


def title_reason(title):
    if education_restriction([{'title':title}]):
        return 'phd'
    if re.search(r'\bdata\s+analyst\b', title, re.I):
        return 'data_analyst'
    if re.search(r'\bdata\s+scien(?:ce|tist)\b', title, re.I):
        return 'data_science'
    # Occupational relevance is an AI judgment, not a growing keyword list.
    return None


def screen_titles(connection, job_ids=None, now=None):
    """Uses the caller's transaction; preserves applications and permanent tags."""
    now = time.time() if now is None else now
    scope, values = discovery_scope(now)
    # Only our automatic country exclusions may become pending when fresh
    # sources add US or unresolved locations. Owner deletions remain permanent.
    prior_locations = connection.execute("""SELECT q.* FROM job_screening q
        JOIN applications a ON a.job_id=q.job_id
        WHERE q.state='trash' AND q.reason IN ('non_us_only','no_sponsorship','citizenship','phd') AND q.manual_keep=0
        AND a.status='not_started' AND a.version=0
        AND (SELECT actor FROM audit WHERE job_id=q.job_id AND event='screening'
             AND json_extract(payload,'$[1]')=q.kind ORDER BY id DESC LIMIT 1)
            IN ('sync-location-rule','sync-sponsorship-rule','sync-degree-rule','sync-title-rule')""").fetchall()
    for prior in prior_locations:
        if job_ids is not None and prior['job_id'] not in job_ids: continue
        current = [json.loads(r[0]) for r in connection.execute(f'''SELECT o.payload FROM observations o
            JOIN search_index s USING(stream,source_id) WHERE o.job_id=? AND s.kind=?
            AND {scope} AND o.present=1 AND s.active=1 AND s.visible=1''',
            (prior['job_id'],prior['kind'],*values))]
        if not current: continue
        if prior['reason']=='non_us_only':
            if non_us_only(screening_locations(current)): continue
        elif prior['reason']=='phd':
            if education_restriction(current): continue
        elif restriction(current) or any(title_citizenship(s.get('title','')) for s in current):
            continue
        token=fingerprint(current)
        if token==prior['fingerprint'] and prior['reason']!='phd': continue
        detail='当前来源的自动排除依据已变化，重新初筛。'
        connection.execute("""UPDATE job_screening SET state='pending',reason='',detail=?,evidence='[]',
            fingerprint=?,reviewed_at=?,expires_at=NULL,version=version+1 WHERE job_id=? AND kind=?""",
            (detail,token,now,prior['job_id'],prior['kind']))
        payload=[prior['job_id'],prior['kind'],'pending','',detail,[],token,prior['version'],'sync-location-rule']
        connection.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'screening','sync-location-rule',?,?)",
                           (prior['job_id'],now,json.dumps(payload)))
    rows = connection.execute(f'''SELECT o.job_id,s.kind,o.payload FROM observations o
        JOIN search_index s USING(stream,source_id) JOIN applications a ON a.job_id=o.job_id
        WHERE {scope} AND o.present=1 AND s.active=1 AND s.visible=1
        AND a.status='not_started' AND a.version=0
        AND NOT EXISTS (SELECT 1 FROM job_screening q WHERE q.job_id=o.job_id AND q.kind=s.kind
                        AND (q.state='trash' OR q.manual_keep=1))''', values)
    grouped = {}
    for row in rows:
        if job_ids is None or row['job_id'] in job_ids:
            grouped.setdefault((row['job_id'],row['kind']),[]).append(json.loads(row['payload']))
    counts = {'newgrad':0,'internship':0}
    observed_at = time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(now))
    for (jid,kind), sources in grouped.items():
        education = education_restriction(sources)
        match = (education[0] if education and safe_url(education[0].get('source_url')) else
                 next((s for s in sources if title_reason(s.get('title','')) in {'data_analyst','data_science'}
                       and safe_url(s.get('source_url'))), None))
        location_match = not match and non_us_only(screening_locations(sources))
        restricted = restriction(sources) if not match and not location_match else None
        citizen = next((s for s in sources if title_citizenship(s.get('title','')) and safe_url(s.get('source_url'))),None) if not match and not location_match and not restricted else None
        if location_match:
            match = next((s for s in sources if s.get('locations') and safe_url(s.get('source_url'))), None)
        elif restricted:
            match = restricted[0] if safe_url(restricted[0].get('source_url')) else None
        elif citizen:
            match = citizen
        if not match: continue
        reason = ('non_us_only' if location_match else restricted[2] if restricted else
                  'citizenship' if citizen else 'phd' if education and match is education[0] else title_reason(match['title']))
        quote = (education[1] if reason=='phd' else match['locations'][0] if location_match
                 else restricted[1] if restricted else match['title'])
        evidence = [{'url':match['source_url'],'quote':quote,'observed_at':observed_at}]
        if reason=='phd':
            detail = '来源标题或学历字段明确为仅限博士／博士后，按用户要求在采集阶段自动删除。'
        elif reason=='non_us_only':
            detail = '来源明确仅列出美国境外地点：' + '；'.join(screening_locations(sources)) + '。按用户要求排除，FAANG+ 也不豁免。'
        elif reason in {'no_sponsorship','citizenship'}:
            detail = '来源明确标注不提供 sponsorship。' if reason=='no_sponsorship' else '来源明确要求美国公民身份。'
        else:
            detail = '标题明确为 Data Analyst，按已确认规则自动删除。' if reason=='data_analyst' else '标题明确为 Data Science / Data Scientist，按已确认规则自动删除。'
        token = fingerprint(sources)
        prior = connection.execute('SELECT version FROM job_screening WHERE job_id=? AND kind=?',(jid,kind)).fetchone()
        old_version = prior['version'] if prior else 0
        connection.execute('''INSERT INTO job_screening VALUES(?,?,?,?,?,?,?,?,?,?,0)
            ON CONFLICT(job_id,kind) DO UPDATE SET state=excluded.state,reason=excluded.reason,
            detail=excluded.detail,evidence=excluded.evidence,fingerprint=excluded.fingerprint,
            reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at,version=excluded.version''',
            (jid,kind,'trash',reason,detail,json.dumps(evidence),token,now,now+86400,old_version+1))
        actor=('sync-degree-rule' if reason=='phd' else 'sync-location-rule' if location_match
               else 'sync-sponsorship-rule' if restricted or citizen else 'sync-title-rule')
        payload = [jid,kind,'trash',reason,detail,evidence,token,old_version,actor]
        connection.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'screening',?,?,?)",
                           (jid,actor,now,json.dumps(payload)))
        counts[kind] += 1
    return counts


def reopen_automatic_reviews(connection):
    """Explicit policy backfill; never resurrect owner removals or processed jobs.

    Idempotent per policy: interrupted/continued backfills do not erase new reviews.
    Fresh initial gates immediately reapply before any model work starts.
    """
    from .screening_policy import POLICY
    if connection.execute("SELECT 1 FROM audit WHERE event='screening_policy_backfill' AND payload=?",(POLICY,)).fetchone():
        return
    rows=connection.execute("""SELECT q.* FROM job_screening q JOIN applications a ON a.job_id=q.job_id
        WHERE q.state IN ('trash','review') AND q.manual_keep=0 AND q.reason!='manual'
        AND a.status='not_started' AND a.version=0
        AND (SELECT actor FROM audit WHERE job_id=q.job_id AND event='screening'
             AND json_extract(payload,'$[1]')=q.kind ORDER BY id DESC LIMIT 1)
            IN ('gpt-6-luna','sync-title-rule','sync-location-rule','sync-sponsorship-rule')""").fetchall()
    now=time.time()
    for row in rows:
        connection.execute("""UPDATE job_screening SET state='pending',reason='',detail='初筛规则已更新，重新评估',
            evidence='[]',reviewed_at=?,expires_at=NULL,version=version+1 WHERE job_id=? AND kind=?""",
            (now,row['job_id'],row['kind']))
        connection.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'screening_policy_reopen','owner-policy-update',?,?)",
            (row['job_id'],now,json.dumps({'kind':row['kind'],'policy':POLICY,'previous_version':row['version']})))
    connection.execute("INSERT INTO audit(event,actor,created,payload) VALUES('screening_policy_backfill','owner-policy-update',?,?)",(now,POLICY))
