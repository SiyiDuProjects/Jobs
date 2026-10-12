import copy
import pytest
from starlette.testclient import TestClient
from jobs_radar.question_corpus import QuestionCorpus, digest, question_key
from jobs_radar.store import Store
from jobs_radar.server import create_server
from jobs_radar.web import WebAccess
from jobs_radar.client_protocol import CURRENT_HEADERS


def page(question='Are you eligible to work in the United States?'):
    return dict(version=1, platform='workday', build='synthetic', company='Example', step='questions',
                trees=[dict(tag='form', attrs={}, children=[dict(tag='input', attrs={'type': 'text'}, children=[])])],
                fields=[dict(id='field-1', question=question, description='', type='radio', required=True,
                             options=[dict(value='option-0', label='Yes'), dict(value='option-1', label='No')], observations=[])],
                coverage=dict(nodes=2, truncated=False))


def fingerprint(value): return digest({key: value[key] for key in ('trees', 'fields')})


def test_failed_capture_promotes_deduplicated_page_and_keeps_one_snapshot(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    original = page()
    corpus.capture(fingerprint(original), original)
    variant = copy.deepcopy(original)
    variant['trees'][0]['attrs']['class'] = 'same-question-new-container'
    key = fingerprint(variant)
    assert not corpus.capture(key, variant)['stored']
    failure = dict(runId='run-1', documentId='document-1', fieldIds=['field-1'], reason='site_error', fieldLinks={'field-1': 'runtime-field-3'})
    one = corpus.capture(key, variant, failure)
    assert one['stored']
    assert not corpus.capture(key, variant, failure)['stored']
    assert corpus.capture(key, variant, failure)['failureId'] == one['failureId']
    assert len(corpus.failures()) == 1
    assert corpus.failures()[0]['fieldLinks'] == {'field-1': 'runtime-field-3'}
    assert len(corpus.export()['pages']) == 2
    assert corpus.failure_page(one['failureId'])['page']['trees'] == variant['trees']
    corpus.resolve_failure(one['failureId'], True)
    assert corpus.failures()[0]['resolved']
    assert len(corpus.export()['pages']) == 2
    with pytest.raises(ValueError): corpus.capture(key, variant, {**failure, 'fieldIds': ['other']})
    with pytest.raises(ValueError): corpus.capture(key, variant, {**failure, 'answer': 'private'})


def test_unrecognized_form_is_a_failed_corpus_page_without_invented_questions(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page(); value['fields'] = []
    result = corpus.capture(fingerprint(value), value, dict(runId='run-1', documentId='document-1', fieldIds=[], reason='unrecognized_control'))
    assert corpus.failure_page(result['failureId'])['page']['fields'] == []


def test_compressed_roundtrip_dedup_and_new_question(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite')); value = page(); key = fingerprint(value)
    assert corpus.probe(key) == {'known': False}
    assert corpus.capture(key, value) == {'stored': True}
    assert corpus.probe(key) == {'known': True}
    assert corpus.capture(key, value) == {'stored': False}
    another = page('Do you need sponsorship?')
    assert corpus.capture(fingerprint(another), another)['stored']
    exported = corpus.export()
    assert len(exported['pages']) == 2 and exported['pages'][0]['page'] == value | {'quality': {'excluded': False, 'reasons': []}}
    assert exported['labels'] == {}
    assert question_key(value['fields'][0]) != question_key(another['fields'][0])


@pytest.mark.parametrize('change', [
    lambda p: p['trees'][0]['attrs'].update(onclick='alert(1)'),
    lambda p: p['trees'][0]['children'][0]['attrs'].update(value='personal'),
    lambda p: p['trees'][0].update(tag='script'),
    lambda p: p['fields'][0].update(answer='private'),
])
def test_unsafe_or_personal_value_structures_rejected(tmp_path, change):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite')); value = page(); change(value)
    with pytest.raises(ValueError): corpus.capture(fingerprint(value), value)
    assert corpus.export()['pages'] == []


def test_private_http_boundary(tmp_path):
    store = Store(tmp_path / 'http.sqlite'); origin = 'https://radar.test'
    with TestClient(create_server(store, origin).streamable_http_app(), base_url=origin, headers=CURRENT_HEADERS) as client:
        assert client.get('/api/extension/corpus').status_code == 401
        assert client.post('/api/extension/corpus', json={'action': 'probe', 'fingerprint': 'a' * 64}).status_code == 401
        rid = client.get('/api/session').json()['request_id']; WebAccess(store, origin).approve(rid)
        assert client.get('/api/extension/corpus').json()['pages'] == []
        value = page()
        response = client.post('/api/extension/corpus', json={'action': 'capture', 'fingerprint': fingerprint(value), 'page': value}, headers={'origin': origin})
        assert response.status_code == 200 and response.json()['stored']


def test_search_novelty_counts_without_duplicate_snapshots(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    original = page()
    original['fields'][0]['observations'] = [dict(query='Example', options=['Example University'])]
    assert corpus.capture(fingerprint(original), original)['stored']
    variant = copy.deepcopy(original)
    variant['trees'][0]['attrs']['class'] = 'another-layout'
    assert not corpus.capture(fingerprint(variant), variant)['stored']
    variant['fields'][0]['observations'].append(dict(query='Second', options=['Second University']))
    assert corpus.capture(fingerprint(variant), variant)['stored']
    assert len(corpus.export()['pages']) == 2


def test_manual_correction_is_not_a_gold_label_and_is_idempotent(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page(); fingerprint_value = fingerprint(value)
    corpus.capture(fingerprint_value, value)
    ident = '11111111-2222-3333-4444-555555555555'
    for _ in range(2):
        assert corpus.correction(fingerprint_value, 'field-1', ident) == {'recorded': True, 'gold': False}
    exported = corpus.export()
    assert exported['labels'] == {}
    key = question_key(value['fields'][0])
    assert exported['corrections'] == [dict(questionId=key, count=1)]
    mapping = dict(binding=dict(predicate='us_work_eligible', options=['true', 'false']),
                   meaning=dict(topic='work_eligibility', country='US', company='', timeframe='current'))
    corpus.label(key, mapping)
    assert corpus.export()['labels'] == {key: mapping}
    with pytest.raises(ValueError):
        corpus.label(key, {**mapping, 'binding': dict(predicate='invented', options=['true', 'false'])})


def test_existing_cached_bindings_are_exported_without_profile_values(tmp_path):
    from jobs_radar.answer_bindings import BindingCache, binding_key
    store = Store(tmp_path / 'corpus.sqlite'); cache = BindingCache(store)
    field = page()['fields'][0] | {'fieldId': 'field-1'}
    context = dict(jobContext=dict(country='US'))
    mapping = dict(binding=dict(predicate='us_work_eligible', options=['true', 'false']),
                   meaning=dict(topic='work_eligibility', country='US', company='', timeframe='current'))
    import json
    with store.connect(True) as c:
        c.execute('INSERT INTO answer_bindings VALUES(?,?)', (binding_key(field, context, 'synthetic'), json.dumps(mapping)))
    result = cache.read([field], context, 'synthetic', dict(employmentData=dict(eligibilityUS=False)), 'private-id', 'private-version', {'field-1': {}})
    assert result['field-1']['value'] == 'option-1'
    exported = cache.corpus.export()['bindings']
    assert len(exported) == 1 and exported[0]['binding'] == mapping['binding']
    assert 'private-id' not in json.dumps(exported) and 'private-version' not in json.dumps(exported)


def test_offline_baseline_never_calls_provider_or_reads_real_profiles(tmp_path, monkeypatch):
    import asyncio
    import json
    from deploy.question_corpus import baseline, private_path
    def forbidden():
        raise AssertionError('Offline baseline must not access a provider credential')
    monkeypatch.setattr('jobs_radar.simple_answers.api_key', forbidden)
    source = private_path(tmp_path / '.qa' / 'input.json'); output = source.with_name('report.json')
    source.write_text(json.dumps(dict(source='synthetic-bootstrap', pages=[dict(id='fixture', page=page())], bindings=[])))
    summary = asyncio.run(baseline(source, output, 30, False))
    assert summary['providerCalls'] == 0 and summary['questions'] == 1 and summary['unanswered'] == 4
    report = json.loads(output.read_text())
    assert report['syntheticFactsOnly'] and not report['live']
    assert output.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError): private_path(tmp_path / 'public.json')


def test_unknown_identity_does_not_flag_explicit_empty_employment_history():
    from deploy.question_corpus import invariants
    field={'question':'Have you ever worked at Example?','type':'radio','options':[{'value':'no','label':'No'}]}
    row={'value':'no','decision':'write','route':'previous_employer'}
    assert invariants('fixture','unknown',field,row,{'jobData':[]})==[]
    row['route']='us_work_eligible'
    assert invariants('fixture','unknown',field,row)[0]['rule']=='unknown_fact_answered'


def test_recorded_search_options_do_not_become_choice_ids_in_model_request():
    from deploy.verify_reported_questions import as_field
    from jobs_radar.field_answers import fields_input
    raw=page()['fields'][0] | {'type':'search-choice','question':'School'}
    assert as_field(raw)['options']==[]
    assert fields_input({'fields':[as_field(raw)]})['fields'][0]['type']=='search-choice'
    raw['type']='combobox';raw['options']=[]
    with pytest.raises(ValueError): fields_input({'fields':[as_field(raw)]})


def test_safe_job_identity_and_redaction_metadata_roundtrip(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page()
    value.update(jobIdentity='https://job-boards.greenhouse.io/embed/job_app?for=example&token=12345', redactionVersion=2)
    corpus.capture(fingerprint(value), value)
    exported = corpus.export()['pages'][0]['page']
    assert exported['jobIdentity'] == value['jobIdentity']
    assert exported['redactionVersion'] == 2
    assert exported['quality'] == {'excluded': False, 'reasons': []}


@pytest.mark.parametrize('url', [
    'https://job-boards.greenhouse.io/embed/job_app?for=example&token=12345&validityToken=private',
    'https://unknown.example/apply?token=private',
    'https://secret:password@jobs.example/apply',
    'file:///private/path',
])
def test_corpus_rejects_unredacted_or_private_posting_metadata(tmp_path, url):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page() | {'jobIdentity': url}
    with pytest.raises(ValueError): corpus.capture(fingerprint(value), value)
    with pytest.raises(ValueError): corpus.probe(fingerprint(value), job_identity=url)
    assert corpus.export()['pages'] == []


def test_known_snapshot_can_gain_identity_without_reupload_or_overwriting_other_job(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page(); key = fingerprint(value)
    corpus.capture(key, value)
    first = 'https://jobs.ashbyhq.com/example/11111111-2222-3333-4444-555555555555/application'
    second = 'https://jobs.ashbyhq.com/example/99999999-2222-3333-4444-555555555555/application'
    assert corpus.probe(key, job_identity=first) == {'known': True}
    assert corpus.probe(key, job_identity=second) == {'known': True}
    exported = corpus.export()['pages']
    assert len(exported) == 1
    assert exported[0]['page']['jobIdentity'] == first
    assert 'redactionVersion' not in exported[0]['page']


def test_old_damaged_snapshots_marked_on_export_without_reconstructing_text(tmp_path):
    import json
    import zlib
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page('Have you worked at [private]?')
    value['fields'][0]['options'][0]['label'] = '[private]'
    key = fingerprint(value)
    # Simulate existing compressed captures, including an obsolete all-clear flag.
    value['quality'] = {'excluded': False, 'reasons': []}
    with corpus.store.connect(True) as c:
        c.execute('INSERT INTO corpus_pages VALUES(?,?,?)', (key, zlib.compress(json.dumps(value).encode()), 1))
    exported = corpus.export()['pages'][0]['page']
    assert exported['quality'] == {'excluded': True, 'reasons': ['redacted_options', 'redacted_question']}
    assert exported['fields'] == value['fields']
    # Export labels damage without destructively changing the archived capture.
    with corpus.store.connect() as c:
        original = json.loads(zlib.decompress(c.execute('SELECT payload FROM corpus_pages').fetchone()[0]))
    assert original == value


def test_identity_redaction_outside_questions_does_not_exclude_snapshot(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite'))
    value = page()
    value['trees'][0]['children'].append({'text': 'Hello [private], [email]'})
    corpus.capture(fingerprint(value), value)
    assert corpus.export()['pages'][0]['page']['quality'] == {'excluded': False, 'reasons': []}
