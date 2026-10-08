"""Exact, person-origin evidence from the bound Profile's server document.

Selection never rewrites provenance, scope or the original response. No keyword
scoring or cross-company inference occurs; semantic/time applicability is checked
by the existing answer verifier after this necessary scope filter.
"""
import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone
from .job_match import job_key
from .saved_responses import normalize_record


def normalized(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def company_key(value):
    """The same conservative ATS tenant boundary used by JobsJobMatch."""
    try:
        parts = json.loads(value)
        if not isinstance(parts, list) or len(parts) < 3 or any(not isinstance(p, str) or not p for p in parts):
            return None
        host, kind, identity = parts[:3]
        tenant = None
        if len(parts) == 4 and ((kind == 'greenhouse' and re.search(r'(^|\.)greenhouse\.io$', host))
                or (kind == 'smartrecruiters' and host == 'jobs.smartrecruiters.com')
                or (kind == 'adp' and re.search(r'(^|\.)adp\.com$', host))):
            tenant = identity
        elif kind == 'path' and re.fullmatch(r'jobs\.(?:eu\.)?lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|ats\.rippling\.com', host):
            match = re.match(r'^/([^/]+)/[^/]+', identity)
            tenant = match[1] if match else None
        elif kind == 'workday' and re.fullmatch(r'[^.]+\.wd\d+\.(?:myworkdayjobs|myworkdaysite)\.com', host):
            tenant = host
        elif kind in {'icims','eightfold','taleo','oracle','avature','pinpoint','path'} and re.fullmatch(
                r'[^.]+\.(?:icims\.com|eightfold\.ai|taleo\.net|avature\.net|pinpointhq\.com|bamboohr\.com|breezy\.hr|applytojob\.com|theresumator\.com|freshteam\.com)', host
                ) and not re.match(r'^(?:www|jobs|careers|apply|app|ats)\.', host):
            tenant = host
        elif kind == 'oracle' and re.fullmatch(r'[^.]+\.fa\.[^.]+\.oraclecloud\.com', host):
            tenant = host
        elif kind in {'microsoft','amd','tesla','tiktok','amazon','google','bytedance','apple','meta','greenhouse_custom'}:
            tenant = host
        return json.dumps([host, 'company', tenant], separators=(',', ':'), ensure_ascii=False) if tenant else None
    except (TypeError, ValueError):
        return None


def request_context(payload):
    url, country = payload.get('jobUrl', ''), payload.get('jobCountry', '')
    if not isinstance(url, str) or len(url) > 3000 or not isinstance(country, str) or len(country) > 100:
        raise ValueError('Invalid answer job context')
    key = job_key(url) if url else None
    return {'jobKey': key or '', 'companyKey': company_key(key) or '', 'country': country}


def applies(record, context):
    captured = record.get('context', {})
    key = record.get('jobKey') or captured.get('jobKey', '')
    if record.get('jobKey') and captured.get('jobKey') and record['jobKey'] != captured['jobKey']:
        return False
    company = company_key(key)
    if captured.get('companyKey') and captured['companyKey'] != company:
        return False
    same_job = bool(key and key == context['jobKey'])
    scope = record.get('scope')
    if scope == 'job' and not same_job:
        return False
    if scope == 'company' and (not company or company != context['companyKey']):
        return False
    if scope not in {'job', 'company', 'global'}:
        return False
    country = captured.get('country', '')
    current = context['country']
    if country == 'MIXED' or current == 'MIXED':
        return False
    if country and current and normalized(country) != normalized(current):
        return False
    # Unknown jurisdiction cannot expand a scoped answer onto another job whose
    # country differs in precision. Explicit global records retain global scope.
    if not same_job and country != current and (country or scope != 'global'):
        return False
    try:
        stamp = datetime.fromisoformat(captured.get('capturedAt', '').replace('Z', '+00:00'))
        if stamp.tzinfo is None or stamp.timestamp() > datetime.now(timezone.utc).timestamp() + 300:
            return False
    except (TypeError, ValueError):
        return False
    return True


class AnswerMemory:
    def __init__(self, store, profile_id, fields, context):
        self.store, self.key = store, 'jobsResponses:' + profile_id
        self.revision, rows = self.read()
        self.by_field = {}
        for field in fields:
            matches = {}
            for raw in rows:
                try:
                    row = normalize_record(raw)
                except ValueError:
                    continue
                if (row.get('origin') != 'person' or not isinstance(row.get('question'), str)
                        or not row['question'].strip() or len(row['question']) > 4000 or len(row['response']) > 4000
                        or normalized(row['question']) != normalized(field['question']) or not applies(row, context)):
                    continue
                ident = hashlib.sha256(json.dumps([self.key, self.revision, row], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]
                matches[ident] = {'savedResponse': ident, 'question': row['question'], 'response': row['response'],
                                  'origin': 'person', 'scope': row['scope'], 'context': row['context']}
            # Never truncate qualifiers or choose one of conflicting records by
            # keyword score. Excess data is not eligible for automatic reuse.
            if len(matches) <= 8 and len(json.dumps(matches, ensure_ascii=False).encode()) <= 24000:
                self.by_field[field['fieldId']] = matches

    def read(self):
        with self.store.connect() as c:
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='management_documents'").fetchone():
                return 0, []
            row = c.execute('SELECT value,revision FROM management_documents WHERE key=?', (self.key,)).fetchone()
        return (row['revision'], json.loads(row['value'])) if row else (0, [])

    def current(self):
        with self.store.connect() as c:
            row = c.execute('SELECT revision FROM management_documents WHERE key=?', (self.key,)).fetchone()
        return (row['revision'] if row else 0) == self.revision

    def prompt(self):
        return {field: list(rows.values()) for field, rows in self.by_field.items() if rows}
