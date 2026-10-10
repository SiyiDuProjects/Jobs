"""Offline JSON-in/JSON-out bridge to the production predicate evaluator.

Input is a private corpus plus synthetic identities; no provider requests or
credentials are used. Keep output in the ignored local corpus directory.
"""
import json
import sys
from .answer_bindings import answer, evaluate


def run(payload):
    results = []
    for case in payload['cases']:
        field = case['field']
        values = []
        for identity in payload['profiles']:
            row = answer(case['binding'], case['meaning'], field, identity, 'synthetic', 'synthetic')
            value = evaluate(case['binding']['predicate'], identity, case['binding'].get('argument', ''))
            values.append({'identity': identity['id'], 'value': row['value'] if row else None,
                           'concept': value[0] if value else None, 'route': case['binding']['predicate']})
        results.append({'key': case['key'], 'answers': values})
    return results


if __name__ == '__main__':
    json.dump(run(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
