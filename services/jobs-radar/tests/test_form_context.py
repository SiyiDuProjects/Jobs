import copy
import json
import pytest
from jobs_radar.field_answers import fields_input
from jobs_radar.web_inputs import AnswerJobRequest
from jobs_radar import flexible_answers
from test_answers import setup, field, mapping, save, run, Client
from test_simple_answers import run as simple_run, Client as SimpleClient, answer


def document():
    return {'version': 1, 'title': 'Application survey', 'truncated': False,
            'text': 'Shared instructions for this form.\n[field:survey]\nSelect one.\n[field:signature]\nChecking this box is equivalent to a handwritten signature.',
            'fields': [field('survey', question='Select one', answer=''),
                       field('signature', question='Signature', type='checkbox', options=[], answer='')]}


def test_document_crosses_http_contract_and_both_model_boundaries(tmp_path):
    a, p = setup(tmp_path)
    doc = document()
    fields = [{k: v for k, v in f.items() if k != 'answer'} for f in doc['fields']]
    old_context = [{'question': 'Previously completed question', 'answer': 'Already filled'}]
    payload = AnswerJobRequest(**p, requestId="synthetic-context-test", fields=fields, formContext=old_context, formDocument=doc).model_dump(exclude_none=True)
    client = Client(mappings=[])
    run(a, p, client, fields, formContext=payload['formContext'], formDocument=payload['formDocument'])
    data = json.loads(client.calls[0]['input'])
    assert data['context']['formDocument'] == doc
    assert data['context']['formContext'] == old_context
    assert [f['fieldId'] for f in data['fields']] == ['survey', 'signature']
    assert len(flexible_answers.INSTRUCTIONS.splitlines()) <= 30
    simple = SimpleClient([])
    simple_run(a, p, simple, fields, formContext=old_context, formDocument=doc)
    data = json.loads(simple.calls[0]['input'])
    assert data['formDocument'] == doc and data['formContext'] == old_context
    assert [f['fieldId'] for f in data['fields']] == ['survey', 'signature']


@pytest.mark.parametrize('patch', [
    {'text': 'x' * 60001}, {'fields': [{}]}, {'version': 2}, {'truncated': 'false'},
    {'fields': document()['fields'] * 2},
])
def test_invalid_document_is_rejected_before_model_request(patch):
    with pytest.raises(ValueError):
        fields_input({'fields': [field()], 'formDocument': {**document(), **patch}})


def test_legacy_binding_cache_ignores_shared_prose_but_retains_field_shape(tmp_path):
    a, p = setup(tmp_path)
    p = save(a, p, employmentData={'eligibilityUS': True})
    doc = document()
    client = Client()
    run(a, p, client, formDocument=doc)
    assert run(a, p, None, formDocument=doc)['answerUsage']['modelCalls'] == 0
    changed = copy.deepcopy(doc)
    changed['text'] += '\nLoading complete. 1 of 2 complete.'
    assert run(a, p, client, formDocument=changed)['answerUsage']['modelCalls'] == 0
    altered = field(description='A new qualification applies to this question.')
    assert run(a, p, client, [altered], formDocument=changed)['answerUsage']['modelCalls'] == 1


@pytest.mark.parametrize('job_specific', [False, True])
def test_simple_cache_ignores_document_but_preserves_job_scope_and_field_shape(tmp_path, job_specific):
    a, p = setup(tmp_path)
    doc = document()
    client = SimpleClient([answer(jobSpecific=job_specific)])
    job = {'jobUrl': 'https://jobs.ashbyhq.com/example/11111111-1111-1111-1111-111111111111/application', 'jobTitle': 'Engineer'}
    assert simple_run(a, p, client, formDocument=doc, **job)['answerUsage']['modelCalls'] == 1
    assert json.loads(client.calls[0]['input'])['formDocument'] == doc
    changed = copy.deepcopy(doc)
    changed['text'] += '\nLoading complete. 1 of 2 complete.'
    changed['title'] = 'Application survey - updated'
    changed['fields'][0]['fieldId'] = 'new-page-id'
    changed['fields'][0]['answer'] = 'Synthetic context only'
    for current in [changed, None]:
        result = simple_run(a, p, client, formDocument=current, **job)
        assert result['answerUsage']['cacheHits'] == 1
        assert result['answerUsage']['modelCalls'] == 0
    other = simple_run(a, p, client, formDocument=changed,
                       jobUrl=job['jobUrl'].replace('/example/', '/other/'), jobTitle='Engineer')
    assert other['answerUsage']['modelCalls'] == int(job_specific)
    assert other['answerUsage']['cacheHits'] == int(not job_specific)
    for altered in [field(description='A new qualification applies to this question.'),
                    field(options=[{'value': 'y', 'label': 'Yes, without restrictions'},
                                   {'value': 'n', 'label': 'No'}])]:
        result = simple_run(a, p, client, [altered], formDocument=changed, **job)
        assert result['answerUsage']['cacheHits'] == 0
        assert result['answerUsage']['modelCalls'] == 1


def test_generic_cache_created_without_document_is_reused_with_document(tmp_path):
    a, p = setup(tmp_path)
    client = SimpleClient([answer(jobSpecific=False)])
    simple_run(a, p, client)
    result = simple_run(a, p, client, formDocument=document())
    assert result['answerUsage']['cacheHits'] == 1
    assert len(client.calls) == 1


def test_missing_invalid_and_missing_fact_are_distinct(tmp_path):
    a, p = setup(tmp_path)
    mappings = [mapping(route='unknown', options=[])]
    missing = run(a, p, Client(mappings))['answers'][0]
    assert missing['interruptionReason'] == 'answer_missing'
    invalid = {'fieldId': 'eligible', 'state': 'answer', 'value': 'invented',
               'questionZh': '已经理解的题目', 'reason': 'Synthetic model output'}
    rejected = run(a, p, Client(mappings, answers=[invalid]))['answers'][0]
    assert rejected['interruptionReason'] == 'answer_invalid'
    assert rejected['questionZh'] == '已经理解的题目'
    unknown = dict(invalid, state='needs_input', value=None, reason='资料缺少过去的相关情况')
    unresolved = run(a, p, Client(mappings, answers=[unknown]))['answers'][0]
    assert unresolved['interruptionReason'] == 'missing_fact'
    assert unresolved['reason'] == '资料缺少过去的相关情况'
    assert simple_run(a, p, SimpleClient([]))['answers'][0]['interruptionReason'] == 'answer_missing'
    assert simple_run(a, p, SimpleClient([answer(value='invented')]))['answers'][0]['interruptionReason'] == 'answer_invalid'
