import base64
import json

import pytest

from test_workspace_audit import implementation


@pytest.mark.parametrize('container', ['json', 'jsonl', 'renamed', 'embedded'])
def test_duplicate_decoded_json_keys_cannot_erase_a_credential(container):
    raw = b'{"pass\\u0077ord":"SYNTHETIC-CREDENTIAL","password":""}'
    name = {'json': 'values.json', 'jsonl': 'lines.jsonl', 'renamed': 'notes.txt', 'embedded': 'capture.json'}[container]
    if container == 'jsonl':
        raw = b'{"safe":true}\n' + raw + b'\n'
    if container == 'embedded':
        raw = json.dumps({'fileData': base64.b64encode(raw).decode()}).encode()
    report = implementation().audit_bytes(raw, name)
    assert report['status'] == 'blocked'
    assert 'duplicate-json-key' in json.dumps(report)


def test_duplicate_nonsensitive_keys_are_unresolved_instead_of_assumed_complete():
    report = implementation().audit_bytes(b'{"note":"first","note":"second"}', 'notes.json')
    assert report['status'] == 'blocked'
    assert 'duplicate-json-key' in json.dumps(report)
