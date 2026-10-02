"""Apply the owner's explicit title exclusions before a sync becomes visible."""
import json
import re
import time

from .board import fingerprint, safe_url
from .scope import discovery_scope
from .employer_blacklist import blocked_employer


def title_reason(title):
    if re.search(r'\bph\.?\s*d\b', title, re.I):
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
        match = next((s for s in sources if blocked_employer(s.get('company')) and safe_url(s.get('source_url'))), None)
        company_match = match is not None
        if not match:
            match = next((s for s in sources if title_reason(s.get('title','')) and safe_url(s.get('source_url'))), None)
        if not match:
            continue
        reason = 'employer_blacklist' if company_match else title_reason(match['title'])
        evidence = [{'url':match['source_url'],'quote':match['company'] if company_match else match['title'],'observed_at':observed_at}]
        if company_match:
            detail = '用户明确排除公司：' + match['company'] + '。采集时直接排除，不交给模型反复判断。'
        elif reason=='phd':
            detail = '岗位标题包含 PhD / Ph.D.，按用户要求在采集阶段自动删除。'
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
        payload = [jid,kind,'trash',reason,detail,evidence,token,old_version,'sync-title-rule']
        connection.execute("INSERT INTO audit(job_id,event,actor,created,payload) VALUES(?,'screening','sync-title-rule',?,?)",
                           (jid,now,json.dumps(payload)))
        counts[kind] += 1
    return counts
