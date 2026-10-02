import json
import time

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.employer_blacklist import blocked_employer
from jobs_radar.luna_screening import classify, run
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
