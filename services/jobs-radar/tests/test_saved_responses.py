import json
from pathlib import Path
import uuid
import pytest
from jobs_radar.saved_responses import normalize_record, normalize_list
from jobs_radar.management import Management
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store

EXAMPLES = json.loads((Path(__file__).parent/'fixtures'/'saved-response-contract.json').read_text(encoding='utf-8'))

@pytest.mark.parametrize('example', EXAMPLES, ids=lambda row: row['name'])
def test_browser_server_saved_response_contract(example):
    if not example['valid']:
        with pytest.raises(ValueError): normalize_record(example['input'])
        return
    result = normalize_record(example['input'])
    assert result['keywords'] == example['keywords']
    assert result['response'] == example['response']
    assert result['fromAutofill'] is False
    if 'source' in example['input']: assert result['source'] == example['input']['source']

def test_management_preserves_old_damaged_history_but_rejects_new_damage(tmp_path):
    store=Store(tmp_path/'responses.sqlite');Profiles(store);management=Management(store)
    key='jobsResponses:'+str(uuid.uuid4())
    good=EXAMPLES[0]['input'];bad=EXAMPLES[2]['input']
    # Existing history is intentionally injected at the storage boundary.
    with store.connect(True) as c:
        c.execute('INSERT INTO management_documents VALUES(?,?,?)',(key,json.dumps([good,bad,None]),1))
    result=management.write([{'key':key,'revision':1,'value':[{**good,'response':'Updated'},bad,None]}])
    assert result[key]['value'][0]['keywords']==['全名']
    assert result[key]['value'][1:]==[bad,None]
    with pytest.raises(ValueError): management.write([{'key':key,'revision':2,'value':[good,{**bad,'response':'New damage'}]}])
    assert management.snapshot()==result
    # A deliberate repaired overwrite retains the previous raw version.
    management.write([{'key':key,'revision':2,'value':[good]}])
    with store.connect() as c:
        versions=[json.loads(r['value']) for r in c.execute('SELECT value FROM management_revisions WHERE key=?',(key,))]
    assert [good,bad,None] in versions

def test_damage_allowance_cannot_duplicate_invalid_history():
    bad=EXAMPLES[2]['input']
    with pytest.raises(ValueError): normalize_list([bad,bad],[bad])


def test_new_exact_question_records_do_not_need_legacy_keywords():
    row = {'key':'q', 'question':'Have you used Example?', 'response':'Yes', 'origin':'person',
           'scope':'company','ruleVersion':3,'context':{'companyKey':'example','country':'US'}}
    assert normalize_record(row) == {**row,'fromAutofill':False}
    assert 'questionKeywords' not in __import__('jobs_radar.saved_responses',fromlist=['RULES']).RULES


@pytest.mark.parametrize('origin', ['person', 'agent', 'page-tool', 'legacy'])
def test_provenance_roundtrips_through_both_browser_contracts_and_storage(tmp_path, origin):
    import subprocess
    key = 'jobsResponses:' + str(uuid.uuid4())
    row = {**EXAMPLES[0]['input'], 'origin': origin, 'ruleVersion': 2,
           'context': {'jobKey': 'synthetic-job', 'companyKey': 'synthetic-company',
                       'country': 'US', 'capturedAt': '2026-10-07T00:00:00Z'}}
    root = Path(__file__).resolve().parents[3]
    script = """
import fs from 'node:fs';
import {JobsResponseContract as extension} from './extensions/speedyapply-local/src/custom/response-contract.js';
import {JobsResponseContract as website} from './services/jobs-radar/web/src/manage/saved-response-contract.js';
const row=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify([extension.parseList([row])[0], website.parseList([row])[0]]));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=root,
                            input=json.dumps(row), text=True, capture_output=True, check=True)
    expected = normalize_record(row)
    assert json.loads(result.stdout) == [expected, expected]
    store = Store(tmp_path / 'provenance.sqlite'); Profiles(store)
    management = Management(store)
    management.write([{'key': key, 'revision': 0, 'value': [expected]}])
    assert management.snapshot()[key]['value'] == [expected]


def test_legacy_origin_stays_unknown_and_invalid_provenance_is_rejected():
    assert 'origin' not in normalize_record(EXAMPLES[0]['input'])
    for extra in [{'origin': 'human-ish'}, {'context': {'credential': 'never'}}, {'ruleVersion': 0}]:
        with pytest.raises(ValueError): normalize_record({**EXAMPLES[0]['input'], **extra})
