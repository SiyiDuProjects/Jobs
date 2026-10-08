"""Local citation validation, separate from semantic support verification.

Finding text in the Profile proves its source, never that an answer follows.
This module performs no network requests and never logs personal quotations.
"""
import hashlib
import json

VERSION = 2


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


def decide(row, field, profile, profile_id, profile_version):
    from .answer_semantics import supported, topic_for, field_key, VOCABULARY, classification
    meaning = classification(row.get('meaning'))
    if meaning is None:
        meaning = {'topic': topic_for(field), 'country': '', 'company': '', 'timeframe': ''}
    evidence = resolve(row.get('evidence'), profile)
    verified = (row['state'] == 'answer' and row['source'] == 'profile' and bool(evidence)
                and supported(field, row['value'], evidence, meaning, profile))
    proof = {'version': VERSION, 'vocabularyVersion': VOCABULARY['version'],
             'profileId': profile_id, 'profileVersion': profile_version,
             'field': field_key(field), 'value': row['value'],
             'status': 'verified' if verified else 'unverified',
             'id': evidence_id(field, row['value'], row.get('evidence')),
             'paths': [item['profilePath'] for item in evidence or [] if 'profilePath' in item]}
    draft = row['state'] == 'answer' and row['source'] == 'suggestion' and field['required']
    reason = 'control_failure' if row.get('invalidValue') else 'new_commitment' if meaning['topic'] == 'acknowledgment' else 'missing_fact'
    decision = 'write' if verified else 'draft' if draft else 'ask'
    result = {**row, 'meaning': meaning, 'proof': proof, 'decision': decision,
              'needsConfirmation': not verified}
    if decision == 'ask':
        result.update(state='needs_input', source='unknown', value=None, interruptionReason=reason)
        result.pop('answerZh', None)
    # Citations are transient review data. Never put them in diagnostics or cache.
    result.pop('invalidValue', None)
    if not verified:
        result.pop('evidence', None)
    return result
