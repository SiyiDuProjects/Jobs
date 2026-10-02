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


def test_question_keyword_extraction_matches_shared_browser_contract():
    import subprocess
    from jobs_radar.saved_responses import question_keywords
    questions = ['What is your experience with Python?', '您的全名？', 'C++ / C# / 3 years', 'Ｆｕｌｌ name name', 'Do you work in the US?', 'naïve café 2026']
    script = """
import fs from 'node:fs';
import {JobsResponseContract} from './web/src/manage/saved-response-contract.js';
console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(JobsResponseContract.questionKeywords)));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parents[1],
                            input=json.dumps(questions), text=True, encoding='utf8', capture_output=True, check=True)
    assert json.loads(result.stdout) == [question_keywords(question) for question in questions]
