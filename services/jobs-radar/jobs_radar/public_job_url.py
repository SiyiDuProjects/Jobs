"""Redact navigation parameters without inventing another posting identity.

Shared examples are consumed by the extension too. Unknown identities that
depend on private parameters cannot be retained as diagnostic job URLs.
"""
import re
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from .job_match import job_key

SENSITIVE = re.compile(r'token|session|^sid$|auth|^code$|^(?:api[-_]?)?key$|^sig(?:nature)?$|pass(?:word|code)?$|e-?mail|^nonce$|^state$|ticket|jwt|otp|phone|secret|credential', re.I)


def posting_token(host, name, value):
    return name == 'token' and re.search(r'(^|\.)greenhouse\.io$', host) and re.fullmatch(r'[0-9]+', value)


def public_job_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or '@' in unquote(parsed.path):
        raise ValueError('Private or unsupported job URL')
    key = job_key(value)
    if not key:
        raise ValueError('Job identity unavailable')
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    fragment = parsed.fragment
    def render(query, hash_value):
        return urlunsplit(('https', parsed.hostname, parsed.path or '/', urlencode(query).replace('~', '%7E'), hash_value))
    for name in [name for name, _ in pairs]:
        trial = [(k, v) for k, v in pairs if k != name]
        unchanged = job_key(render(trial, fragment)) == key
        token = posting_token(parsed.hostname, name, next((v for k, v in pairs if k == name), ''))
        if SENSITIVE.search(name) and not token:
            if not unchanged:
                raise ValueError('Private parameters are part of an unknown job identity')
            pairs = trial
        elif unchanged:
            pairs = trial
    if fragment:
        if job_key(render(pairs, '')) == key:
            fragment = ''
        elif re.search(r'token|code=|state=|auth|@', fragment, re.I):
            raise ValueError('Private fragment is part of an unknown job identity')
    result = render(sorted(pairs, key=lambda item: item[0]), fragment)
    if job_key(result) != key or len(result) > 3000:
        raise ValueError('Redaction changed the job identity or exceeded URL limit')
    return result
