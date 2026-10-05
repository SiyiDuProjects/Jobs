import json
import time

import httpx
import pytest

from jobs_radar.board import Board
from jobs_radar.company_screening import input_fingerprint
from jobs_radar.luna_screening import run, ScreeningError
from jobs_radar.screening_policy import POLICY
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


def mark(board,row,value=True):
    return board.review(row['id'],row['kind'],'keep','eligible','Matching occupation',[],
                        row['fingerprint'],row['review_version'],'tag-'+row['id']+'-'+str(row['review_version']),
                        company_recommended=value,expected_company_fingerprint=row['company_fingerprint'])


def model(request):
    payload=json.loads(request.content)
    rows=json.loads(payload['input'])
    result={r['id']:{'decision':'keep','company_recommended':r['company'] in {'xAI','Duolingo'},
                     'reason':'岗位方向符合','evidence_quote':r['title']} for r in rows}
    return httpx.Response(200,json={'status':'completed','output':[{'content':[
        {'type':'output_text','text':json.dumps({'jobs':result})}]}]})


def test_one_batch_saves_distinct_internship_and_fulltime_tags_without_application_changes(tmp_path):
    store,board=seed(tmp_path)
    with store.connect() as c:
        before=[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    assert board.list(kind='internship',company_filter='1')['total']==0  # Unreviewed is not recommended.
    with httpx.Client(transport=httpx.MockTransport(model)) as client:
        assert run(store,client=client)['status']=='complete'
    assert {r['company'] for r in board.list(kind='internship',company_filter='1')['jobs']}=={'xAI','Duolingo'}
    assert board.list(kind='newgrad',company_filter='1')['total']==2
    assert board.list(kind='internship')['total']==4
    assert board.filter_counts(company_filter='1')['total']==4
    assert board.list(kind='internship',company_filter='1',region='ca')['total']==1
    assert board.list(kind='internship',company_filter='1',exclude_companies='xai')['total']==1
    with store.connect() as c:
        assert before==[tuple(r) for r in c.execute('SELECT * FROM applications ORDER BY job_id')]
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Unchanged jobs must not call Luna again'))) as client:
        assert run(store,client=client)['keep']==0


def test_invalid_or_stale_tags_never_pass_and_policy_change_requeues(tmp_path):
    store,board=seed(tmp_path)
    row=board._rows('internship')[0];mark(board,row)
    with store.connect(True) as c:
        c.execute("UPDATE job_company_screening SET policy='old-policy' WHERE job_id=?",(row['id'],))
    assert board.list(kind='internship',company_filter='1')['total']==0
    assert row['id'] in {r['id'] for r in board.queue('internship')['jobs']}
    assert input_fingerprint(row['all_sources'],'newgrad',row['title'])!=row['company_fingerprint']
    changed=[{**s,'section':'New source classification'} for s in row['all_sources']]
    assert input_fingerprint(changed,'internship',row['title'])!=row['company_fingerprint']
    with pytest.raises(ValueError,match='Company input changed'):
        board.review(row['id'],'internship','keep','eligible','Matching occupation',[],row['fingerprint'],1,
                     'stale-request',company_recommended=True,expected_company_fingerprint='stale')


def test_legacy_review_does_not_authorize_reusing_an_old_recommendation(tmp_path):
    store,board=seed(tmp_path)
    row=board._rows('internship')[0];mark(board,row)
    current=next(r for r in board._rows('internship') if r['id']==row['id'])
    board.review(current['id'],'internship','review','','Unresolved',[],current['fingerprint'],1,'manual-review')
    assert next(r for r in board._rows('internship') if r['id']==row['id'])['screening']=='review'


def test_backfill_includes_old_keeps_but_protects_manual_and_processed_records(tmp_path):
    store,board=seed(tmp_path)
    rows=board._rows('internship')
    with store.connect(True) as c:
        c.execute('UPDATE observations SET first_seen=100')
        c.execute('UPDATE screening_checkpoint SET cutoff=?,initialized=1',(time.time(),))
        for r in rows:
            c.execute('INSERT INTO screening_seen VALUES(?,?,?,1)',(r['id'],r['kind'],r['fingerprint']))
    for r in rows:
        board.review(r['id'],'internship','keep','eligible','Old decision',[],r['fingerprint'],0,'old-'+r['id'])
    board.mark_submitted(rows[0]['id'],0,key='submitted')
    with store.connect(True) as c:
        c.execute('UPDATE job_screening SET manual_keep=1 WHERE job_id=?',(rows[1]['id'],))
    batch=ScreeningProgress(store).manage('begin')
    assert batch['remaining']['internship']==0
    with httpx.Client(transport=httpx.MockTransport(model)) as client:
        result=run(store,client=client,backfill_company=True)
    assert result['status']=='complete'
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_company_screening WHERE job_id IN (?,?)',(rows[0]['id'],rows[1]['id'])).fetchone()[0]==0
        assert c.execute('SELECT status FROM applications WHERE job_id=?',(rows[0]['id'],)).fetchone()[0]=='submitted'


@pytest.mark.parametrize('bad', ['missing','string','trash_recommended'])
def test_bad_compact_output_preserves_all_old_state(tmp_path,bad):
    store,board=seed(tmp_path)
    def fail(request):
        response=model(request);value=response.json()
        result=json.loads(value['output'][0]['content'][0]['text'])
        item=next(iter(result['jobs'].values()))
        if bad=='missing': del item['company_recommended']
        elif bad=='string': item['company_recommended']='true'
        else: item.update(decision='trash',company_recommended=True)
        value['output'][0]['content'][0]['text']=json.dumps(result)
        return httpx.Response(200,json=value)
    with httpx.Client(transport=httpx.MockTransport(fail)) as client:
        with pytest.raises(ScreeningError):run(store,client=client)
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_company_screening').fetchone()[0]==0
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0


def test_processed_job_race_cannot_save_recommendation(tmp_path):
    store,board=seed(tmp_path);row=board._rows('internship')[0]
    board.mark_submitted(row['id'],0,key='race-submitted')
    with pytest.raises(ValueError,match='protected'):mark(board,row)
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_company_screening').fetchone()[0]==0
