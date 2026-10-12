"""Bounded page evidence, kept separate from questions requiring an answer."""
import json


def form_document(value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('version') != 1 or type(value.get('truncated')) is not bool:
        raise ValueError('Invalid form document')
    if len(json.dumps(value, ensure_ascii=False)) > 200000:
        raise ValueError('Form document too large')

    def string(item, limit):
        if not isinstance(item, str) or len(item) > limit:
            raise ValueError('Invalid form document text')
        return item

    source = value.get('fields')
    if not isinstance(source, list) or len(source) > 150:
        raise ValueError('Invalid form document fields')
    fields = []
    for item in source:
        if not isinstance(item, dict) or type(item.get('required')) is not bool:
            raise ValueError('Invalid form document field')
        options = item.get('options', [])
        if not isinstance(options, list) or len(options) > 1000 or any(not isinstance(o, dict) for o in options):
            raise ValueError('Invalid form document options')
        fields.append({
            'fieldId': string(item.get('fieldId'), 80),
            'question': string(item.get('question'), 2000),
            'type': string(item.get('type'), 80),
            'required': item['required'],
            'description': string(item.get('description', ''), 4000),
            'answer': string(item.get('answer', ''), 4000),
            'options': [{'value': string(o.get('value'), 2000), 'label': string(o.get('label'), 500)} for o in options],
        })
    if len({f['fieldId'] for f in fields}) != len(fields):
        raise ValueError('Duplicate form document fields')
    return {'version': 1, 'title': string(value.get('title'), 500),
            'text': string(value.get('text'), 60000), 'fields': fields, 'truncated': value['truncated']}
