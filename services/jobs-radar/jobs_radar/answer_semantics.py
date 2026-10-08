"""Versioned meanings and a public-structure cache.

Classification is a hint, never personal evidence. Cache contains public field
structure only; no Profile, model prose, answers or quotations are persisted.
"""
import hashlib
import json
from pathlib import Path

VOCABULARY = json.loads(Path(__file__).with_name('answer-vocabulary.json').read_text())


def classification_schema():
    return {'type': 'object', 'properties': {
        'topic': {'type': 'string', 'enum': list(VOCABULARY['topics'])},
        'country': {'type': 'string', 'enum': ['', 'US', 'CA', 'UK', 'other']},
        'company': {'type': 'string', 'enum': ['', 'current', 'named', 'any']},
        'timeframe': {'type': 'string', 'enum': ['', 'current', 'past', 'future', 'specified']},
    }, 'required': ['topic', 'country', 'company', 'timeframe'], 'additionalProperties': False}


def classification(value):
    if not isinstance(value, dict) or set(value) != {'topic', 'country', 'company', 'timeframe'}:
        return None
    if value['topic'] not in VOCABULARY['topics'] or any(not isinstance(v, str) or len(v) > 300 for v in value.values()):
        return None
    for key in ['country','company','timeframe']:
        if value[key] not in classification_schema()['properties'][key]['enum']:
            return None
    return dict(value)


def field_key(field):
    return {key: field.get(key, '' if key == 'description' else None)
            for key in ('fieldId', 'question', 'type', 'required', 'description', 'options')}


def cache_key(field, context, model):
    shape = field_key(field)
    shape.pop('fieldId')
    raw = [shape, context, VOCABULARY['version'], VOCABULARY['ruleVersion'], model]
    return hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class MeaningCache:
    def __init__(self, store):
        self.store = store
        with store.connect(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_meanings(key TEXT PRIMARY KEY, meaning TEXT NOT NULL)')

    def read(self, fields, context, model):
        with self.store.connect() as c:
            return {field['fieldId']: json.loads(row[0]) for field in fields
                    if (row := c.execute('SELECT meaning FROM answer_meanings WHERE key=?',
                                        (cache_key(field, context, model),)).fetchone())}

    def save(self, fields, rows, context, model):
        source = {row['fieldId']: row for row in rows if isinstance(row, dict) and 'fieldId' in row}
        with self.store.connect(True) as c:
            for field in fields:
                value = classification(source.get(field['fieldId'], {}).get('meaning'))
                if value:
                    c.execute('INSERT OR REPLACE INTO answer_meanings VALUES(?,?)',
                              (cache_key(field, context, model), json.dumps(value, ensure_ascii=False)))
            # Bounded deterministic cache; eviction changes cost, never truth.
            c.execute('DELETE FROM answer_meanings WHERE rowid NOT IN (SELECT rowid FROM answer_meanings ORDER BY rowid DESC LIMIT 4000)')
