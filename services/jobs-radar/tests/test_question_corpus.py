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


def test_compressed_roundtrip_dedup_and_new_question(tmp_path):
    corpus = QuestionCorpus(Store(tmp_path / 'corpus.sqlite')); value = page(); key = fingerprint(value)
    assert corpus.probe(key) == {'known': False}
    assert corpus.capture(key, value) == {'stored': True}
    assert corpus.probe(key) == {'known': True}
    assert corpus.capture(key, value) == {'stored': False}
    another = page('Do you need sponsorship?')
    assert corpus.capture(fingerprint(another), another)['stored']
    exported = corpus.export()
    assert len(exported['pages']) == 2 and exported['pages'][0]['page'] == value
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
    monkeypatch.setattr('jobs_radar.answers.api_key', forbidden)
    source = private_path(tmp_path / '.qa' / 'input.json'); output = source.with_name('report.json')
    source.write_text(json.dumps(dict(source='synthetic-bootstrap', pages=[dict(id='fixture', page=page())], bindings=[])))
    summary = asyncio.run(baseline(source, output, 30, False))
    assert summary['providerCalls'] == 0 and summary['questions'] == 1 and summary['unanswered'] == 4
    report = json.loads(output.read_text())
    assert report['syntheticFactsOnly'] and not report['live']
    assert output.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError): private_path(tmp_path / 'public.json')
