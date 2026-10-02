"""Saved Response boundary, driven by the same field contract as the browser."""
import json
from pathlib import Path
import re
import unicodedata

RULES = json.loads(Path(__file__).with_name('saved_response_contract.json').read_text(encoding='utf-8'))

def normalize_keyword(value):
    value = unicodedata.normalize(RULES['keywordNormalization'], value).strip().lower()
    # ECMAScript Unicode letter/number classes, underscore and whitespace.
    value = ''.join(c for c in value if unicodedata.category(c)[0] in RULES['keywordCategoryPrefixes'] or c in RULES['keywordCharacters'] or RULES['keywordWhitespace'] and c.isspace())
    return re.sub(r'\s+', ' ', value).strip()

def question_keywords(question):
    rule = RULES['questionKeywords']
    normalized = unicodedata.normalize(RULES['keywordNormalization'], str(question)).lower()
    words, current = [], []
    for char in normalized:
        if unicodedata.category(char)[0] in rule['categories'] or char in rule['characters']:
            current.append(char)
        elif current:
            words.append(''.join(current))
            current = []
    if current:
        words.append(''.join(current))
    return list(dict.fromkeys(word for word in words if (len(word) >= rule['minimumLetters'] or word.isascii() and word.isdigit()) and word not in rule['stopWords']))


def normalize_record(value):
    if not isinstance(value, dict): raise ValueError('Invalid saved response')
    result = dict(value)
    for name, rule in RULES['fields'].items():
        if name not in value:
            if 'default' in rule: result[name] = rule['default']
            elif rule.get('required'): raise ValueError('Missing ' + name)
            continue
        field = value[name]
        kind = rule['type']
        if kind in {'keywords', 'strings'}:
            if not isinstance(field, list) or any(not isinstance(v, str) for v in field): raise ValueError('Invalid ' + name)
            if kind == 'keywords':
                field = list(dict.fromkeys(normalize_keyword(v) for v in field))
                if any(not v for v in field): raise ValueError('Keyword cannot be empty')
            if len(field) < rule.get('minItems', 0): raise ValueError('Missing keywords')
        elif kind == 'integer':
            if type(field) is not int or field < rule['minimum']: raise ValueError('Invalid ' + name)
        elif kind == 'string':
            if not isinstance(field, str): raise ValueError('Invalid ' + name)
            if rule.get('trim'): field = field.strip()
            if rule.get('nonempty') and not field.strip(): raise ValueError(name + ' cannot be empty')
        elif kind == 'boolean' and type(field) is not bool: raise ValueError('Invalid ' + name)
        result[name] = field
    if RULES['appearancesCannotExceedKeywords'] and result['appearances'] > len(result['keywords']): raise ValueError('Appearances exceed distinct keywords')
    return result

def normalize_list(value, previous=()):
    if not isinstance(value, list): raise ValueError('Expected a response list')
    result = []
    # Existing damaged entries may survive an unrelated edit unchanged. New or
    # modified invalid records are rejected; revision history retains originals.
    remaining = list(previous) if isinstance(previous, list) else []
    for row in value:
        try: result.append(normalize_record(row))
        except ValueError:
            if row not in remaining: raise
            remaining.remove(row)
            result.append(row)
    return result
