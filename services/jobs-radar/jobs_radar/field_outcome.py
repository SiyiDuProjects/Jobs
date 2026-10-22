"""A field's outcome from the extension's run ledger: who decided it and why it
was left. field_outcome.json is the vocabulary shared with the extension.

Unknown codes from a newer extension become 'other' instead of rejecting the
whole page or corpus packet; the shape itself stays strict.
"""
import json
from pathlib import Path

VOCABULARY = json.loads(Path(__file__).with_name('field_outcome.json').read_text())


def outcome(value):
    from .validation import shape, text, boolean
    shape(value, ('state',), ('by', 'reason', 'from', 'review', 'taken'))
    state = text(value['state'], 40)
    result = {'state': state if state in VOCABULARY['states'] else 'open'}
    for key, allowed in (('by', 'deciders'), ('from', 'deciders'), ('reason', 'reasons')):
        if key in value:
            code = text(value[key], 40)
            result[key] = code if code in VOCABULARY[allowed] else 'other'
    for key in ('review', 'taken'):
        if key in value:
            result[key] = boolean(value[key])
    return result
