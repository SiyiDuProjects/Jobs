"""Owner-authorized suggestions for review, never evidence for an automatic write."""
from .answer_evidence import evidence_id
from .answer_semantics import field_key
from .field_answers import CHOICES

INSTRUCTIONS = """
The owner requests review-first suggestions for every unanswered REQUIRED field.
This overrides abstaining solely because a personal fact is unknown: give your best
plausible concrete answer with source=suggestion, needsConfirmation=true and no
invented evidence. It will be displayed only in an editable review card and cannot
be written or continued until the owner explicitly confirms it. Distinguish a
suggestion from a known fact. Do not contradict known facts. Use offered option
values only; prefer a truthful Unknown/Not applicable/Prefer not to disclose when
appropriate, otherwise suggest the best plausible offered answer for owner review.
For ordinary required text/date questions supply a concrete reviewable draft.
Missing credentials, identifiers, contact details and search-choice canonical names
still require actual input; do not manufacture these. Optional unknowns stay empty.
When facts support an answer, return source=profile with exact relevant citations.
In a Work Authorization menu combining employer scope and sponsorship, an explicit
current sponsorship requirement supports 'I require sponsorship to work in this
country'; current US eligibility does not invalidate that option. Never replace it
with 'any employer' or 'present employer only' without support for that qualifier.
"""


def proposed(row, field, result):
    if not field['required'] or field['type'] == 'search-choice' or result['decision'] != 'ask':
        return result
    value = row.get('value') if row['state'] == 'answer' else None
    # A provider may still abstain. Keep choices reviewable without another
    # model call; this is an explicitly labelled proposal, never a factual default.
    if value is None and field['type'] in CHOICES:
        options = field['options']
        option = next((o for o in options if o['label'].strip().casefold() in
                       {'unknown', 'prefer not to disclose', 'prefer not to answer', 'no'}), options[0])
        value = [option['value']] if field['type'] == 'select-multiple' else option['value']
    if value is None and field['type'] in {'checkbox', 'custom-checkbox'}:
        value = False
    if value is None:
        return result
    proof = {**result['proof'], 'status': 'proposed', 'value': value,
             'id': evidence_id(field, value, []), 'paths': [], 'field': field_key(field)}
    answer = {**result, 'state': 'answer', 'value': value, 'source': 'suggestion',
              'decision': 'draft', 'reviewOnly': True, 'needsConfirmation': True,
              'proof': proof, 'evidence': []}
    if value != row.get('value'):
        answer.pop('answerZh', None)
    return answer
