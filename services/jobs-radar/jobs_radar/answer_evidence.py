"""Local citation validation, separate from semantic support verification.

Finding text in the Profile proves its source, never that an answer follows.
This module performs no network requests and never logs personal quotations.
"""
import hashlib
import json
import fnmatch

VERSION = 2
from .answer_policy import POLICY


def facts(profile):
    result = {}

    def visit(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                visit(item, f'{path}.{key}' if path else key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f'{path}.{index}')
        elif value is not None and value != '' and path != 'applicationData.aiNotes':
            result[path] = value

    visit(profile or {}, '')
    return result


def citation_schema(profile):
    return {'type': 'array', 'items': {'anyOf': [
        {'type': 'object', 'properties': {'profilePath': {
            'type': 'string', 'enum': list(facts(profile)) or ['unavailable']}},
         'required': ['profilePath'], 'additionalProperties': False},
        {'type': 'object', 'properties': {'noteQuote': {'type': 'string'}},
         'required': ['noteQuote'], 'additionalProperties': False},
        {'type': 'object', 'properties': {'authorization': {'type': 'string', 'enum': list(POLICY['standingAuthorizations'])}},
         'required': ['authorization'], 'additionalProperties': False},
    ]}}


def resolve(citations, profile):
    if not isinstance(citations, list) or not 1 <= len(citations) <= 12:
        return None
    available = facts(profile)
    notes = (profile or {}).get('applicationData', {}).get('aiNotes', '')
    resolved = []
    for item in citations:
        if not isinstance(item, dict):
            return None
        if set(item) == {'profilePath'} and isinstance(item['profilePath'], str) and item['profilePath'] in available:
            resolved.append({'profilePath': item['profilePath'], 'value': available[item['profilePath']]})
        elif set(item) == {'noteQuote'} and isinstance(item['noteQuote'], str):
            quote = item['noteQuote']
            if not 4 <= len(quote.strip()) <= 3000 or not isinstance(notes, str) or quote not in notes:
                return None
            resolved.append({'noteQuote': quote})
        elif set(item) == {'authorization'} and isinstance(item['authorization'], str) and item['authorization'] in POLICY['standingAuthorizations']:
            resolved.append({'authorization': item['authorization'], 'scope': POLICY['standingAuthorizations'][item['authorization']]})
        else:
            return None
    return resolved


def evidence_id(field, value, citations):
    return hashlib.sha256(json.dumps([field, value, citations], sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()[:24]


def candidates(rows, fields, profile):
    by_id = {field['fieldId']: field for field in fields}
    result = []
    for row in rows:
        if row['state'] != 'answer' or row['source'] != 'profile':
            continue
        evidence = resolve(row.get('evidence'), profile)
        if evidence:
            result.append({'field': by_id[row['fieldId']], 'value': row['value'], 'evidence': evidence})
    return result


def decide(row, field, profile, profile_id, profile_version, check=None):
    from .answer_semantics import field_key, VOCABULARY, classification
    meaning = classification(row.get('meaning'))
    if meaning is None:
        meaning = {'topic': 'unknown', 'country': '', 'company': '', 'timeframe': ''}
    if check and classification(check.get('meaning')):
        meaning = classification(check['meaning'])
    evidence = resolve(row.get('evidence'), profile)
    verdict = check.get('verdict') if check else None
    spec = VOCABULARY['topics'][meaning['topic']]
    def compatible(item):
        if 'profilePath' in item:
            return any(fnmatch.fnmatchcase(item['profilePath'], pattern) for pattern in spec['paths'])
        if 'noteQuote' in item:
            return spec['notes']
        return 'authorization' in item and meaning['topic'] == 'acknowledgment'
    compatible_evidence = bool(evidence) and all(compatible(item) for item in evidence)
    verified = (compatible_evidence and (field['required'] or all('authorization' not in item for item in evidence))
                and row['state'] == 'answer' and verdict == 'write')
    # Date precision is a value invariant, independent of question wording or
    # how many education records the Profile contains. A selected exact date
    # cannot borrow a day from a month-only structured fact. Notes still need
    # the semantic verdict for their stated date.
    if verified and field['type'] == 'date' and all('profilePath' in item for item in evidence):
        verified = any(item['value'] == row['value'] for item in evidence)
    draft = (row['state'] == 'answer' and field['required'] and verdict == 'draft'
             and meaning['topic'] in VOCABULARY['draftTopics']
             and (not evidence or compatible_evidence))
    proof = {'version': VERSION, 'vocabularyVersion': VOCABULARY['version'],
             'profileId': profile_id, 'profileVersion': profile_version,
             'field': field_key(field), 'value': row['value'],
             'status': 'verified' if verified or draft else 'unverified',
             'id': evidence_id(field, row['value'], row.get('evidence')),
             'paths': [item['profilePath'] for item in evidence or [] if 'profilePath' in item]}
    reason = ('control_failure' if row.get('invalidValue') or verdict == 'unavailable' else
              'new_commitment' if verdict == 'new_commitment' or meaning['topic'] == 'acknowledgment' else 'missing_fact')
    decision = 'write' if verified else 'draft' if draft else 'ask'
    result = {**row, 'meaning': meaning, 'proof': proof, 'decision': decision,
              'needsConfirmation': not verified, 'source': 'profile' if verified else 'suggestion' if draft else row['source']}
    if decision == 'ask':
        result.update(state='needs_input', source='unknown', value=None, interruptionReason=reason)
        result.pop('answerZh', None)
    # Citations are transient review data. Never put them in diagnostics or cache.
    result.pop('invalidValue', None)
    if not verified and not draft:
        result.pop('evidence', None)
    return result
