"""Reviewed official posting identities; never infer aliases from URL suffixes.

Evidence is a compact public CXS tool-output excerpt from the Windows session
01a0fc16-9b9c-77f0-b35b-275338059221, not a Mac fetch or personal application.
Adding a binding requires a reviewed pair of official responses. Collectors,
receipt payloads and website hints cannot register or extend this mapping.
"""
import json


SNAP_EVIDENCE = {
    'checked_at': ('2026-10-02T13:36:49.7217908Z', '2026-10-02T13:36:50.0563259Z'),
    'http_status': None,  # Invoke-RestMethod succeeded; status was not captured.
    'raw_response_saved': False,
    'host': 'snapchat.wd1.myworkdayjobs.com',
    'tenant': 'snapchat',
    'jobReqId': 'R0046951',
    'title': 'Software Engineer, C++, Level 3',
    'location': 'Los Angeles, California',
    'startDate': '2026-09-28',
    'description_utf16_code_units': 8694,  # PowerShell string .Length
    'description_sha256': '0c473ae2c0c6f04dbadd85543bfc23115bc9a69a51038beeef9f3479c90287d8',
    'description_hash_encoding': 'utf-8',
    'postings': (
        {'url': 'https://snapchat.wd1.myworkdayjobs.com/en-US/sourced/job/Los-Angeles-California/Software-Engineer--C----Level-3_R0046951',
         'cxs_url': 'https://snapchat.wd1.myworkdayjobs.com/wday/cxs/snapchat/sourced/job/Los-Angeles-California/Software-Engineer--C----Level-3_R0046951',
         'url_requisition': 'R0046951', 'id': '94ec5214050f1000d43312e1b0ea0000'},
        {'url': 'https://snapchat.wd1.myworkdayjobs.com/en-US/snap/job/Los-Angeles-California/Software-Engineer--C----Level-3_R0046951-1',
         'cxs_url': 'https://snapchat.wd1.myworkdayjobs.com/wday/cxs/snapchat/snap/job/Los-Angeles-California/Software-Engineer--C----Level-3_R0046951-1',
         'url_requisition': 'R0046951-1', 'id': '94ec5214050f1000d43312e1b0ea0001'},
    ),
}

VERIFIED_POSTINGS = (SNAP_EVIDENCE,)


def _workday_key(host, requisition):
    return json.dumps([host, 'workday', requisition], separators=(',', ':'))


# Exact existing URL keys, including their host/tenant, bound to the official
# requisition. The canonical key stays stable regardless of ingestion order.
_CANONICAL = {
    _workday_key(evidence['host'], posting['url_requisition']):
        _workday_key(evidence['host'], evidence['jobReqId'])
    for evidence in VERIFIED_POSTINGS for posting in evidence['postings']
}


def canonical_key(key):
    return _CANONICAL.get(key, key)


def equivalent_keys(key):
    """Include pre-binding persisted keys without rewriting historical rows."""
    canonical = canonical_key(key)
    return tuple(sorted({canonical, *(old for old, new in _CANONICAL.items() if new == canonical)})) if canonical else ()
