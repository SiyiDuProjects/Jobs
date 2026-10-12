import asyncio
import json
import sqlite3
import sys
import pytest
from argparse import Namespace
from pathlib import Path

from jobs_radar.answer_result import result
from jobs_radar.job_match import job_key
from jobs_radar.profiles import Profiles
from jobs_radar.management import Management
from jobs_radar.question_corpus import QuestionCorpus, digest
from jobs_radar.store import Store

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
from corpus_flow_replay import posting_context, replay_code_hash
import compare_answer_flows as comparison


def test_replay_revision_includes_shared_runtime_source(tmp_path):
    source = tmp_path / 'source/content/shared/runtime.js'
    source.parent.mkdir(parents=True)
    source.write_text('export const revision = 1;')
    before = replay_code_hash(tmp_path)
    source.write_text('export const revision = 2;')
    assert replay_code_hash(tmp_path) != before


def page():
    def control(ident, question):
        return dict(tag='label', attrs={}, children=[{'text': question}, dict(tag='input', attrs={
            'data-jobs-corpus-field': ident, 'aria-label': question, 'required': ''}, children=[])])
    return dict(version=1, platform='unknown', build='synthetic', company='Example', step='questions',
                trees=[dict(tag='form', attrs={}, children=[control('field-1', 'First name'), control('field-2', 'Preferred arrangement')])],
                fields=[dict(id=ident, question=question, description='', type='text', required=True, options=[], observations=[])
                        for ident, question in [('field-1', 'First name'), ('field-2', 'Preferred arrangement')]],
                coverage=dict(nodes=7, truncated=False))


def insert_job(store, url, title, description='', locations=None):
    with store.connect(True) as connection:
        connection.execute('INSERT INTO jobs(id,identity,job_key,first_seen,last_seen) VALUES(?,?,?,1,1)', ('a'*24, job_key(url), job_key(url)))
        connection.execute('INSERT INTO observations VALUES(?,?,?,?,?,?,?)', ('synthetic', 'one', 'a'*24,
            json.dumps(dict(title=title, description=description, locations=locations or [])), 1, 1, 1))


def test_context_joins_identity_not_company_or_step(tmp_path):
    store = Store(tmp_path / 'source.sqlite')
    url = 'https://jobs.ashbyhq.com/example/11111111-2222-3333-4444-555555555555'
    insert_job(store, url, 'Synthetic engineer', 'Actual posting description', ['Example City'])
    with store.connect() as connection:
        found = posting_context(connection, {'jobIdentity': url + '/application', 'step': 'Application Questions'})
        assert found['complete']
        assert found['title'] == 'Synthetic engineer'
        assert found['description'] == 'Actual posting description'
        assert found['locations'] == ['Example City']
        missing = posting_context(connection, {'company': 'example', 'step': 'Synthetic engineer'})
        assert not missing['complete'] and missing['title'] == ''
        external = posting_context(connection, {'jobIdentity': 'https://jobs.ashbyhq.com/other/11111111-2222-3333-4444-555555555555'})
        assert external['source'] == 'posting_not_in_library'


@pytest.mark.parametrize('reported_only', [False, True])
def test_private_comparison_runs_local_rules_then_both_actual_request_paths(tmp_path, monkeypatch, reported_only):
    store = Store(tmp_path / 'source.sqlite')
    profiles = Profiles(store)
    Management(store)
    for name in ('Intern', 'Newgrad'):
        profiles.save(dict(profileName=name, nameData={'firstName': 'Example'}, contactData={}, addressData={},
                           jobData=[], educationData=[], languageData=[], resumeData={}, websiteData={}, skillsData=[], employmentData={}))
    corpus = QuestionCorpus(store)
    value = page()
    corpus.capture(digest({key: value[key] for key in ('trees', 'fields')}), value)
    damaged = page()
    damaged['fields'][0]['question'] = 'Are you a [private]?'
    corpus.capture(digest({key: damaged[key] for key in ('trees', 'fields')}), damaged)
    if reported_only:
        for marked in (value, damaged):
            saved = corpus.capture(digest({key: marked[key] for key in ('trees', 'fields')}), marked,
                                   dict(runId='synthetic-run', documentId='synthetic-doc', fieldIds=[], reason='manual_report'))
            corpus.resolve_failure(saved['failureId'], True)
        unreported = page()
        unreported['fields'][0]['question'] = 'Unreported sample'
        corpus.capture(digest({key: unreported[key] for key in ('trees', 'fields')}), unreported)
    calls = []

    class Engine:
        def __init__(self, _store, flow):
            self.flow = flow

        async def generate(self, request):
            calls.append((self.flow, request))
            assert [field['question'] for field in request['fields']] == ['Preferred arrangement']
            assert {'question': 'First name', 'answer': 'Example'} in request['formContext']
            assert 'Preferred arrangement' in request['formDocument']['text']
            return {'answers': [result(field, request['profileId'], request['profileVersion'], 'answer', 'Synthetic option',
                                questionZh='虚构问题', answerZh='虚构回答', reasonZh='测试资料') for field in request['fields']],
                    'answerUsage': {'modelCalls': 1}}

    monkeypatch.setattr(comparison, 'Answers', Engine)
    output = tmp_path / 'comparison.json'
    extension = Path(__file__).resolve().parents[3] / 'extensions/speedyapply-local'
    args = Namespace(database=str(store.path), output=str(output), extension=str(extension), node='node',
                     profile_name=None, reported_only=reported_only, resume=None, reuse_legacy=None)
    asyncio.run(comparison.run(args))
    report = json.loads(output.read_text())
    assert len(calls) == 4
    assert report['evaluationScope'] == 'snapshot_pipeline'
    assert report['summary']['excludedPages'] == 1
    assert report['summary']['questions'] == 4
    for flow in ('legacy', 'simple'):
        assert report['summary']['metrics'][flow]['local'] == 2
        assert report['summary']['metrics'][flow]['unknown'] == 0
    assert report['realATSWrite'] is False
    assert report['originalUserAnswersRestored'] is False
    assert output.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(store.path) as connection:
        assert connection.execute('SELECT count(*) FROM owner_profiles WHERE deleted=0').fetchone()[0] == 2
        assert connection.execute('SELECT count(*) FROM corpus_pages').fetchone()[0] == (3 if reported_only else 2)


def test_timed_out_page_worker_is_stopped_and_next_page_can_start(tmp_path):
    from corpus_flow_replay import SnapshotReplay
    extension = tmp_path / 'extension'
    scripts = extension / 'scripts'
    scripts.mkdir(parents=True)
    worker = scripts / 'corpus-flow-worker.mjs'
    worker.write_text("process.stdin.resume(); setInterval(() => {}, 1000);\n")

    async def check():
        import pytest
        async def provider(_request):
            raise AssertionError('No provider request is expected')
        async with SnapshotReplay(extension, read_timeout=0.1) as replay:
            with pytest.raises(asyncio.TimeoutError):
                await replay.run({}, {}, {}, {}, provider)
            assert replay.process is None
            worker.write_text("import {createInterface} from 'node:readline'; const lines=createInterface({input:process.stdin}); lines.on('line',()=>console.log(JSON.stringify({type:'result',result:{ok:true}})));\n")
            assert await replay.run({}, {}, {}, {}, provider) == {'ok': True}
    asyncio.run(check())
