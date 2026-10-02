"""The extension's ATS matching rules, with mandatory host/company scope.

job_match_rules.json is also bundled into the extension. Database job IDs stay
unchanged: this key is only for connecting application records to source URLs.
"""
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, parse_qsl, urlencode

RULES = json.loads(Path(__file__).with_name('job_match_rules.json').read_text())
# Marketing/referral parameters never identify a posting. Everything else in an
# unrecognised URL's query is kept, because some sites identify jobs only there.
TRACKING = re.compile(r'^(?:utm_.*|gh_src|gclid|fbclid|msclkid|mc_[ce]id|_ga|lever-(?:source|origin).*|ref|refid|referrer|source|src|trk)$', re.I)


def normalized_host(host):
    host = host.lower()
    if host.startswith('www.'): host = host[4:]
    return 'job-boards.greenhouse.io' if host == 'boards.greenhouse.io' else host


def job_key(url):
    try:
        p = urlsplit(url)
        if p.scheme not in {'http','https'} or not p.hostname or p.username or p.password:
            return None
        host = normalized_host(p.hostname)
        query = parse_qs(p.query)
        for rule in RULES:
            if not re.search(rule['host'],host): continue
            parts = []
            if rule['name'] == 'greenhouse':
                if '/embed' in p.path:
                    parts = [query.get('for',[''])[0],query.get('token',[''])[0]]
                    # Some public feeds link to the embed endpoint without a
                    # company. Preserve that posting, but never invent a tenant
                    # or merge it with a scoped posting on the number alone.
                    if not parts[0] and parts[1] and re.fullmatch(r'/embed/job_app/?', p.path):
                        return json.dumps([host,'greenhouse_embed',parts[1]],separators=(',',':'),ensure_ascii=False)
                else:
                    m = re.search(r'^/([^/]+)/jobs/([^/]+)',p.path)
                    parts = list(m.groups()) if m else []
            elif 'query' in rule:
                parts = [next((query[k][0] for k in keys if query.get(k)), '') for keys in rule['query']]
            if (not parts or not all(parts)) and 'pattern' in rule:
                m = re.search(rule['pattern'],p.path)
                parts = list(m.groups()) if m else []
            if parts and all(parts):
                if rule.get('lowercaseParts'):
                    parts = [part.lower() for part in parts]
                return json.dumps([host,rule['name'],*parts],separators=(',',':'),ensure_ascii=False)
            # A generic identifier rule (for example gh_jid on any careers site)
            # does not own its host: without the identifier, keep looking.
            if not rule.get('fallthrough'): return None
        pairs = sorted((k,v) for k,v in parse_qsl(p.query,keep_blank_values=True) if not TRACKING.match(k))
        return json.dumps([host,'exact',p.path.rstrip('/') or '/',urlencode(pairs),p.fragment],separators=(',',':'),ensure_ascii=False)
    except (ValueError,TypeError):
        return None

def job_index(c):
    index = {}
    for row in c.execute("SELECT id,job_key FROM jobs WHERE job_key IS NOT NULL AND id NOT IN (SELECT alias_id FROM job_aliases)"):
        index.setdefault(row['job_key'],set()).add(row['id'])
    return index


def _tokens(url):
    p = urlsplit(url)
    text = p.path + '?' + p.query + '#' + p.fragment
    # Requisition numbers (Workday REF088587W / JR100691-1, gh_jid, pid) and
    # UUIDs. Title slugs and years are shared by sibling postings, so no.
    ident = re.compile(r'[A-Za-z]{0,4}-?\d{5,}(?:-\d{1,3})?[A-Za-z]?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)
    return {t.lower() for t in re.split(r'[^A-Za-z0-9-]+', text) if ident.fullmatch(t)}


def _scope(url):
    p = urlsplit(url)
    host = normalized_host(p.hostname or '')
    first = next((s for s in p.path.split('/') if s), '').lower()
    if host == 'jobs.smartrecruiters.com':
        oneclick = re.match(r'^/oneclick-ui/company/([^/]+)/(?:job|publication)/', p.path)
        if oneclick:
            first = oneclick[1].lower()
    # Multi-company ATS hosts are scoped by their company path segment.
    shared = {'job-boards.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com',
              'jobs.smartrecruiters.com','apply.workable.com','app.careerpuck.com'}
    return (host, first if host in shared else '')


GENERIC = {'www', 'careers', 'career', 'jobs', 'job', 'apply', 'boards', 'jobboards', 'greenhouse', 'lever', 'ashbyhq',
           'myworkdayjobs', 'myworkdaysite', 'icims', 'smartrecruiters', 'workable', 'campus', 'external', 'global',
           'talent', 'recruiting', 'hire', 'com', 'io', 'co', 'net', 'org', 'ai', 'hr', 'us', 'app', 'en'}


def _brands(url):
    """Company names in a page's host and, on shared ATS hosts, its company path."""
    p = urlsplit(url)
    host = normalized_host(p.hostname or '')
    words = set(re.split(r'[.-]', host)) | {host.split('.')[0].replace('-', '')}
    if _scope(url)[1]:
        words.add(_scope(url)[1].replace('-', ''))
    return {w for w in words if len(w) >= 3 and w not in GENERIC and not re.fullmatch(r'wd\d+|fa|us\d*|\d+', w)}


def _corroborates(url, listed):
    """Same posting: its own site and a shared requisition number, or a company
    careers hub and its ATS (squarepoint-capital.com -> Greenhouse squarepointcapital,
    careers.amd.com -> campus-amd.icims.com) sharing the number and the company name."""
    shared = _tokens(url) & _tokens(listed)
    if not shared:
        return False
    if _scope(url) == _scope(listed):
        return True
    here, there = _brands(url), _brands(listed)
    return any(a == b or (len(a) >= 4 and len(b) >= 4 and (a in b or b in a)) for a in here for b in there)


def resolve(c, url, hint=None):
    """URL identity first. A website-launched job ID is accepted only when the
    current page repeats one of that job's requisition identifiers, on its own
    site or on the ATS behind the same company's careers hub (_corroborates).

    Returns (job_ids, method): method is 'url', 'hint' or None.
    """
    index = job_index(c)
    ids = index.get(job_key(url), set()) if job_key(url) else set()
    if ids: return sorted(ids), 'url'
    if not hint or not re.fullmatch(r'[a-f0-9]{24}', hint): return [], None
    alias = c.execute('SELECT canonical_id FROM job_aliases WHERE alias_id=?', (hint,)).fetchone() \
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_aliases'").fetchone() else None
    target = alias[0] if alias else hint
    urls = [r[0] for r in c.execute("SELECT DISTINCT json_extract(payload,'$.apply_url') FROM observations WHERE job_id=?", (target,)) if r[0]]
    try:
        if not any(_corroborates(url, u) for u in urls): return [], None
    except ValueError:
        return [], None
    group = set()
    for u in urls: group |= index.get(job_key(u), set())
    return sorted(group or {target}), 'hint'
