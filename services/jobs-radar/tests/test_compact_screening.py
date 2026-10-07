import json
import time

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.company_screening import run_companies, set_preference, pending
from jobs_radar.luna_screening import run, ScreeningError
from jobs_radar.screening_progress import ScreeningProgress
from jobs_radar.store import Store
from test_store import observation


def seed(tmp_path):
    store=Store(tmp_path/'compact.sqlite')
    for kind in ('internship','newgrad'):
        store.ingest('simplify:'+kind,[{
            **observation(company=company,url=f'https://example.org/{kind}/{i}'),
            'source_id':str(i),'kind':kind,'source_url':'https://example.org/source',
            'title':'Software Engineer','locations':[location], 'section':section,
        } for i,(company,location,section) in enumerate([
            ('xAI','Palo Alto, CA','Other'),('Duolingo','Pittsburgh, PA','Other'),
            ('General Motors','Austin, TX','FAANG+'),('Unfamiliar Company','Seattle, WA',''),
        ])],'seed',scoped_only=True)
    ScreeningProgress(store).initialize(time.time()-10)
    return store,Board(store)


def model(request):
    payload=json.loads(request.content);rows=json.loads(payload['input'])
    if rows[0]['id'].startswith('company_'):
        assert all(set(r)=={'id','company'} for r in rows)
        result={'companies':{r['id']:r['company'] in {'xAI','Duolingo'} for r in rows}}
    else:
        result={'jobs':{r['id']:{'decision':'keep','reason':'岗位方向符合','evidence_quote':r['title']} for r in rows}}
    return httpx.Response(200,json={'status':'completed','output':[{'content':[
        {'type':'output_text','text':json.dumps(result)}]}]})


def test_shared_set_once_per_company_across_kinds_and_daily_reuse(tmp_path):
    store,board=seed(tmp_path)
    with store.connect() as c: before=[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    calls=[]
    def handler(request):
        calls.append(json.loads(json.loads(request.content)['input']));return model(request)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result=run(store,client=client)
    assert result['companies']['evaluated']==4
    assert len(calls)==2 and len(calls[0])==8 and len(calls[1])==4
    for kind in ('newgrad','internship'):
        assert {r['company'] for r in board.list(kind=kind,company_filter='1')['jobs']}=={'xAI','Duolingo'}
    assert board.filter_counts(company_filter='1')['total']==4
    assert board.list(kind='internship',company_filter='1',region='ca')['total']==1
    with store.connect() as c:
        assert before==[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
        assert c.execute('SELECT count(*) FROM job_company_screening').fetchone()[0]==0
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Known companies and unchanged jobs must not call Luna again'))) as client:
        assert run(store,client=client)['companies']['evaluated']==0


def test_job_changes_never_invalidate_company_membership_and_case_is_shared(tmp_path):
    store,board=seed(tmp_path)
    set_preference(store,'  XAI  ',True,0)
    set_preference(store,'General Motors',False,0)
    new={**observation(company='xai',url='https://example.org/new'), 'title':'Firmware Engineer','source_id':'new'}
    store.ingest('simplify:newgrad',[new],'new',scoped_only=True)
    row=board._rows('newgrad')[0]
    assert row['company_recommended'] is True  # Role is separately excluded by initial screening.
    assert not any(r['key'] in {'xai','general motors'} for r in pending(store))
    with store.connect(True) as c: c.execute("UPDATE company_preferences SET policy='previous-policy'")
    assert board._rows('newgrad')[0]['company_recommended'] is True


def test_history_backfill_does_not_change_initial_reviews_or_application_ledger(tmp_path):
    store,board=seed(tmp_path)
    row=next(r for r in board._rows('internship') if r['company']=='Duolingo')
    board.mark_submitted(row['id'],0,key='submitted')
    with store.connect(True) as c:
        c.execute("UPDATE observations SET present=0 WHERE job_id=?",(row['id'],))
        c.execute("UPDATE observations SET present=0 WHERE json_extract(payload,'$.company')='Duolingo'")
        before={table:[tuple(r) for r in c.execute('SELECT * FROM '+table+' ORDER BY rowid')]
                for table in ('applications','application_events','job_screening')}
    assert 'duolingo' not in {r['key'] for r in pending(store)}
    assert 'duolingo' in {r['key'] for r in pending(store,True)}
    with httpx.Client(transport=httpx.MockTransport(model)) as client:
        assert run_companies(store,client=client,include_history=True)['remaining']==0
    assert next(r for r in board._rows('internship',include_history=True) if r['id']==row['id'])['company_recommended'] is True
    with store.connect() as c:
        assert before=={table:[tuple(r) for r in c.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in before}


@pytest.mark.parametrize('bad',['missing','extra','string','duplicate'])
def test_company_batch_failure_is_atomic_and_resumable(tmp_path,bad):
    store,board=seed(tmp_path)
    def fail(request):
        response=model(request);value=response.json();result=json.loads(value['output'][0]['content'][0]['text'])
        key=next(iter(result['companies']))
        if bad=='missing':del result['companies'][key]
        elif bad=='extra':result['companies']['foreign']=True
        elif bad=='string':result['companies'][key]='true'
        content=json.dumps(result)
        if bad=='duplicate':content=content.replace('"companies": {','"companies": {'+json.dumps(key)+': false, ')
        value['output'][0]['content'][0]['text']=content
        return httpx.Response(200,json=value)
    with httpx.Client(transport=httpx.MockTransport(fail)) as client:
        with pytest.raises(ScreeningError):run_companies(store,client=client)
    with store.connect() as c:assert c.execute('SELECT count(*) FROM company_preferences').fetchone()[0]==0
    with httpx.Client(transport=httpx.MockTransport(model)) as client:
        assert run_companies(store,client=client)['evaluated']==4


def test_owner_override_wins_race_and_negative_is_remembered(tmp_path):
    store,board=seed(tmp_path)
    def racing(request):
        set_preference(store,'Duolingo',False,0)
        return model(request)
    with httpx.Client(transport=httpx.MockTransport(racing)) as client:run_companies(store,client=client)
    assert all(r['company_recommended'] is False for k in ('newgrad','internship') for r in board._rows(k) if r['company']=='Duolingo')
    assert pending(store)==[]
    with pytest.raises(ValueError,match='changed'):set_preference(store,'Duolingo',True,0)
    set_preference(store,'Duolingo',True,1)
    assert next(r for r in board._rows('newgrad') if r['company']=='Duolingo')['company_recommended'] is True


def test_initial_review_cannot_write_a_company_decision(tmp_path):
    store,board=seed(tmp_path);row=board._rows('newgrad')[0]
    with pytest.raises(ValueError,match='shared company list'):
        board.review(row['id'],row['kind'],'keep','eligible','Matching role',[],row['fingerprint'],0,'legacy',company_recommended=True)


def test_company_request_uses_market_policy_without_job_eligibility_context():
    from jobs_radar.company_screening import classify_companies
    from jobs_radar.screening_policy import RULES
    rows=[{'key':'spacex','name':'SpaceX','sponsorship':'Does Not Offer Sponsorship'},
          {'key':'nvidia','name':'NVIDIA','title':'Hardware Engineer'}]
    def handler(request):
        payload=json.loads(request.content)
        assert RULES['company_preference'] in payload['instructions']
        assert 'high-paying technology talent market' in payload['instructions']
        assert 'Exact pay data is NOT required' in payload['instructions']
        assert 'regardless of sponsorship' in payload['instructions']
        assert 'Does Not Offer Sponsorship' not in payload['instructions']
        assert json.loads(payload['input'])==[
            {'id':'company_0','company':'SpaceX'}, {'id':'company_1','company':'NVIDIA'}]
        return httpx.Response(200,json={'status':'completed','output':[{'content':[
            {'type':'output_text','text':json.dumps({'companies':{'company_0':True,'company_1':True}})}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        decisions,_=classify_companies(client,rows)
    assert all(row['keep'] for row in decisions)


def test_batch_budget_resumes_without_repeating_known_companies(tmp_path):
    store,board=seed(tmp_path);seen=[]
    def handler(request):
        names=[r['company'] for r in json.loads(json.loads(request.content)['input'])]
        assert not set(names)&set(seen);seen.extend(names)
        return model(request)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert run_companies(store,client=client,batch_size=2,max_batches=1)['remaining']==2
        assert run_companies(store,client=client,batch_size=2,max_batches=1)['remaining']==0
    assert len(seen)==4


def test_standalone_application_company_is_included_without_private_context(tmp_path):
    store,board=seed(tmp_path)
    with store.connect(True) as c:
        c.execute("INSERT INTO applications(job_id,status,record,deleted) VALUES('external:test','submitted',?,0)",
            (json.dumps({'companyName':'External Co','jobTitle':'Private role','profileName':'Private person'}),))
    assert 'external co' not in {r['key'] for r in pending(store)}
    requests=[]
    def handler(request):
        requests.append(json.loads(request.content)['input']);return model(request)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:run_companies(store,client=client,include_history=True)
    assert 'External Co' in ''.join(requests) and 'Private' not in ''.join(requests)


def mark(board,row,value=True):
    from jobs_radar.intern_companies import normalize_company
    board.review(row['id'],row['kind'],'keep','eligible','Matching occupation',[],row['fingerprint'],row['review_version'],'tag-'+row['id']+'-'+row['kind'])
    with board.store.connect() as c:
        previous=c.execute('SELECT version FROM company_preferences WHERE company_key=?',(normalize_company(row['company']),)).fetchone()
    return set_preference(board.store,row['company'],value,previous[0] if previous else 0)
