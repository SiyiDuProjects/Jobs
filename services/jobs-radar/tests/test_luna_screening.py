import json
import time

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.employer_blacklist import blocked_employer
from jobs_radar.luna_screening import ScreeningError, classify, failure_summary, run
from jobs_radar.screening_progress import ScreeningProgress
from jobs_radar.store import Store
from test_store import observation


@pytest.mark.parametrize('name,blocked',[
    ('General Dynamics',True),('General Dynamics Mission Systems',True),('GDIT',True),
    ('SpaceX',True),('General Motors',False),('General DynamicsResearch',False),('SpaceX Tools Independent',False),
])
def test_named_company_family_boundary(name,blocked):
    assert blocked_employer(name)==blocked


def setup_store(tmp_path):
    s=Store(tmp_path/'luna.sqlite')
    rows=[{**observation(url='https://example.org/'+str(i)),'source_id':str(i),'source_url':'https://example.org/'+str(i),'title':title}
          for i,title in enumerate(['Software Engineer','Firmware Engineer'])]
    s.ingest('simplify:newgrad',rows,'seed',scoped_only=True)
    ScreeningProgress(s).initialize(time.time()-10)
    return s


def reply(rows,partial=False,bad_quote=False):
    jobs=[{'id':r['id'],'decision':'trash' if r['title']=='Firmware Engineer' else 'keep',
           'reason':'Title-based occupation decision','evidence_quote':'Invented title' if bad_quote else r['title']} for r in rows]
    if partial:jobs=jobs[:1]
    return {'status':'completed','model':'gpt-6-luna','usage':{'input_tokens':10,'output_tokens':10},
            'output':[{'content':[{'type':'output_text','text':json.dumps({'jobs':jobs})}]}]}


@pytest.mark.parametrize('failure',['partial','quote','http'])
def test_bad_provider_result_does_not_write_and_can_resume(tmp_path,failure):
    s=setup_store(tmp_path)
    def handler(request):
        payload=json.loads(request.content)
        assert payload['store'] is False
        rows=json.loads(payload['input'])
        assert all('status' not in r and 'application_version' not in r for r in rows)
        if failure=='http':return httpx.Response(429,json={'error':{'message':'untrusted provider body'}})
        return httpx.Response(200,json=reply(rows,partial=failure=='partial',bad_quote=failure=='quote'))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError):run(s,client=client)
    assert all(r['screening']=='pending' for r in Board(s)._rows('newgrad'))
    with s.connect() as c:assert not c.execute("SELECT 1 FROM locks WHERE name='luna-screening'").fetchone()
    def good(request):return httpx.Response(200,json=reply(json.loads(json.loads(request.content)['input'])))
    with httpx.Client(transport=httpx.MockTransport(good)) as client:result=run(s,client=client)
    assert result['status']=='complete' and result['keep']==result['trash']==1
    assert [r['title'] for r in Board(s).list()['jobs']]==['Software Engineer']
    with s.connect() as c:assert all(r[0]=='not_started' for r in c.execute('SELECT status FROM applications'))


def test_manual_change_during_request_stays_protected(tmp_path):
    s=setup_store(tmp_path)
    def handler(request):
        rows=json.loads(json.loads(request.content)['input'])
        with s.connect(True) as c:
            c.execute("UPDATE applications SET status='submitted',version=version+1 WHERE job_id=?",
                      (next(r['id'] for r in rows if r['title']=='Firmware Engineer'),))
        return httpx.Response(200,json=reply(rows))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:result=run(s,client=client)
    assert result['changed']==1 and result['trash']==0
    assert any(r['title']=='Firmware Engineer' and r['status']=='submitted' and r['screening']!='trash' for r in Board(s)._rows('newgrad'))


def test_blacklisted_employer_is_suppressed_before_luna(tmp_path):
    s=Store(tmp_path/'employers.sqlite')
    s.ingest('simplify:newgrad',[{**observation(company=company,url='https://example.org/'+str(i)),
             'source_id':str(i),'source_url':'https://example.org/'+str(i)}
             for i,company in enumerate(['General Dynamics Mission Systems','SpaceX','General Motors'])],'seed',scoped_only=True)
    s.screen_titles()
    assert [r['company'] for r in Board(s).list()['jobs']]==['General Motors']
    trash=Board(s).list(view='trash')['jobs']
    assert len(trash)==2 and all(r['review']['reason']=='employer_blacklist' for r in trash)


@pytest.mark.parametrize('status,provider_code',[
    (429,'insufficient_quota'),(429,'rate_limit_exceeded'),(401,'invalid_api_key'),
    (403,'permission_denied'),(400,'unsupported_value'),(500,'server_error'),
    (400,'untrusted-secret-code'),
])
def test_provider_failure_is_bounded_and_preserves_original_batch(tmp_path,status,provider_code):
    s=setup_store(tmp_path)
    original=ScreeningProgress(s).manage('begin')
    def bad(request):
        return httpx.Response(status,json={'error':{'code':provider_code,'message':'private provider response'}},
                              headers={'x-private':'private header'})
    with httpx.Client(transport=httpx.MockTransport(bad)) as client:
        with pytest.raises(ScreeningError) as caught: run(s,client=client)
    summary=failure_summary(caught.value)
    assert summary['error_code']=='provider_http' and summary['stage']=='provider'
    assert summary['http_status']==status
    if provider_code=='untrusted-secret-code': assert 'provider_code' not in summary
    else: assert summary['provider_code']==provider_code
    assert 'private' not in json.dumps(summary) and 'untrusted' not in json.dumps(summary)
    current=ScreeningProgress(s).manage('status')
    assert current['id']==original['id'] and current['remaining']==original['remaining']
    with s.connect() as c:
        assert not c.execute("SELECT 1 FROM locks WHERE name='luna-screening'").fetchone()
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0
    def good(request): return httpx.Response(200,json=reply(json.loads(json.loads(request.content)['input'])))
    with httpx.Client(transport=httpx.MockTransport(good)) as client: result=run(s,client=client)
    assert result['run_id']==original['id'] and result['status']=='complete'


@pytest.mark.parametrize('failure,code',[
    ('coverage','job_coverage'),('quote','evidence_mismatch'),('decision','decision_invalid'),
    ('incomplete','provider_incomplete'),('shape','provider_shape'),('json','provider_json'),
    ('transport','provider_transport'),
])
def test_model_validation_and_transport_failures_are_distinguishable(tmp_path,failure,code):
    s=setup_store(tmp_path)
    def bad(request):
        if failure=='transport': raise httpx.ConnectError('private transport detail',request=request)
        if failure=='json': return httpx.Response(200,text='private non-json body')
        rows=json.loads(json.loads(request.content)['input'])
        data=reply(rows,partial=failure=='coverage',bad_quote=failure=='quote')
        if failure=='incomplete': data.update(status='incomplete',incomplete_details={'reason':'max_output_tokens'})
        if failure=='shape': data['output']=[{'content':[{'type':'output_text','text':'{"jobs":[null]}'}]}]
        if failure=='decision':
            jobs=json.loads(data['output'][0]['content'][0]['text'])
            jobs['jobs'][0]['decision']='private invalid decision'
            data['output'][0]['content'][0]['text']=json.dumps(jobs)
        return httpx.Response(200,json=data)
    with httpx.Client(transport=httpx.MockTransport(bad)) as client:
        with pytest.raises(ScreeningError) as caught: run(s,client=client)
    summary=failure_summary(caught.value)
    assert summary['error_code']==code and summary['stage']=='provider'
    assert 'private' not in json.dumps(summary)
    assert all(r['screening']=='pending' for r in Board(s)._rows('newgrad'))


def test_unexpected_failure_logs_only_stage_and_keeps_failure(tmp_path,monkeypatch):
    s=setup_store(tmp_path)
    def bad(*args,**kwargs): raise ValueError('private progress data')
    monkeypatch.setattr(ScreeningProgress,'manage',bad)
    with pytest.raises(ScreeningError) as caught: run(s,client=object())
    assert failure_summary(caught.value)=={
        'screening':'failed','error_type':'ValueError','error_code':'unexpected','stage':'progress'}
    assert failure_summary(ValueError('private arbitrary message'))['stage']=='unknown'


@pytest.mark.parametrize('command',['screen','collect'])
def test_cli_keeps_failure_exit_and_redacts_diagnostics(tmp_path,monkeypatch,capsys,command):
    import sys
    from jobs_radar import cli, luna_screening, sources
    s=setup_store(tmp_path)
    def fail(*args,**kwargs):
        raise ScreeningError('provider_http',http_status=429,provider_code='insufficient_quota')
    async def collected(*args,**kwargs): return [{'ok':True}]
    monkeypatch.setattr(luna_screening,'run',fail)
    monkeypatch.setattr(sources,'collect',collected)
    monkeypatch.setenv('JOBS_SCREENING_ENABLED','1')
    monkeypatch.setattr(sys,'argv',['jobs-radar','--db',str(tmp_path/'luna.sqlite'),command])
    with pytest.raises(SystemExit) as caught: cli.main()
    assert caught.value.code==1
    result=json.loads(capsys.readouterr().out)
    assert result['error_code']=='provider_http' and result['provider_code']=='insufficient_quota'
