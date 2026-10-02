import time

import pytest

from jobs_radar.board import Board
from jobs_radar.screening_progress import ScreeningProgress
from jobs_radar.store import Store
from test_store import observation


def job(key, company='Other Employer', kind='newgrad'):
    return {**observation(company=company,url='https://example.org/'+key),
            'source_id':key,'kind':kind,'posted_at':100}


def review(board,row):
    return board.review(row['id'],row['kind'],'review','','Official details need verification',[],
                        row['fingerprint'],row['review_version'],'test-'+row['id']+'-'+row['kind']+'-'+row['fingerprint'])


def test_durable_identity_batches_resume_and_capture_late_arrivals(tmp_path,monkeypatch):
    clock=[1000.0];monkeypatch.setattr(time,'time',lambda:clock[0])
    store=Store(tmp_path/'progress.sqlite');board=Board(store);progress=ScreeningProgress(store)
    old=job('old');big=job('big','Google')
    store.ingest('simplify:newgrad',[old,big],'initial')
    clock[0]=2000
    recent=job('recent');unknown={**job('unknown'),'posted_at':None}
    store.ingest('simplify:newgrad',[old,big,recent,unknown],'new')
    progress.initialize(1500)
    clock[0]=2100
    batch=progress.manage('begin');rid=batch['id']
    assert batch['remaining']=={'internship':0,'newgrad':2}
    rows=board.queue('newgrad',100,run_id=rid)['jobs']
    assert {r['company'] for r in rows}=={'Other Employer'}
    assert len(board.list()['jobs'])==4  # Older ordinary jobs remain browseable.
    page=board.queue('newgrad',1,run_id=rid)
    review(board,page['jobs'][0])
    assert progress.manage('complete',rid)['completed'] is False
    clock[0]=500000  # Several missed days do not expire the remaining work.
    resumed=ScreeningProgress(store).manage('begin')
    assert resumed['id']==rid and resumed['cutoff']==2100
    assert resumed['remaining']['newgrad']==1
    late={**job('late'),'posted_at':None}
    store.ingest('simplify:newgrad',[old,big,recent,unknown,late],'late')
    assert len(board.queue('newgrad',100,run_id=rid)['jobs'])==1
    for row in board.queue('newgrad',100,run_id=rid)['jobs']:review(board,row)
    assert progress.manage('complete',rid)['status']=='complete'
    assert progress.manage('complete',rid)['status']=='complete'
    second=progress.manage('begin')
    assert second['id']!=rid
    remaining=board.queue('newgrad',100,run_id=second['id'])['jobs']
    assert len(remaining)==1 and remaining[0]['apply_url'].endswith('/late')
    review(board,remaining[0]);progress.manage('complete',second['id'])
    # An older ordinary role changes. It enters by fingerprint, not publish age.
    old={**old,'description':'New material duties'}
    store.ingest('simplify:newgrad',[old,big,recent,unknown,late],'changed')
    third=progress.manage('begin')
    rows=board.queue('newgrad',100,run_id=third['id'])['jobs']
    assert len(rows)==1 and rows[0]['apply_url'].endswith('/old')
    review(board,rows[0]);progress.manage('complete',third['id'])
    # Age-only / sync changes do not create duplicate screening work.
    store.ingest('simplify:newgrad',[{**j,'posted_at':200} for j in [old,big,recent,unknown,late]],'refresh')
    fourth=progress.manage('begin')
    assert fourth['remaining']=={'internship':0,'newgrad':0}


def test_both_kinds_must_finish_before_advancing(tmp_path,monkeypatch):
    monkeypatch.setattr(time,'time',lambda:2000.0)
    store=Store(tmp_path/'protected.sqlite');board=Board(store);p=ScreeningProgress(store)
    for kind in ('newgrad','internship'):
        store.ingest('simplify:'+kind,[job('same','Apple',kind)],'seed')
    p.initialize(1000)
    batch=p.manage('begin');rid=batch['id']
    full=board.queue('newgrad',run_id=rid)['jobs'][0]
    review(board,full)
    result=p.manage('complete',rid)
    assert result['remaining']=={'newgrad':0,'internship':1}
    review(board,board.queue('internship',run_id=rid)['jobs'][0])
    assert p.manage('complete',rid)['status']=='complete'
    assert p.manage('status')['cutoff']==batch['cutoff']
    p.initialize(1999)  # Startup never resets an existing checkpoint.
    assert p.manage('status')['cutoff']==batch['cutoff']


def test_reappearing_source_is_not_lost_and_never_marks_unread(tmp_path,monkeypatch):
    now=[1000.0];monkeypatch.setattr(time,'time',lambda:now[0])
    s=Store(tmp_path/'reappear.sqlite');b=Board(s);p=ScreeningProgress(s)
    old=job('old');anchor=job('anchor','Google')
    s.ingest('simplify:newgrad',[old,anchor],'seed');p.initialize(999)
    first=p.manage('begin')
    for row in b.queue('newgrad',100,run_id=first['id'])['jobs']:review(b,row)
    p.manage('complete',first['id'])
    s.ingest('simplify:newgrad',[anchor],'absent')
    second=p.manage('begin');p.manage('complete',second['id'])
    now[0]=5000
    changed={**old,'title':'Backend Engineer'}
    s.ingest('simplify:newgrad',[anchor,changed],'reappeared')
    third=p.manage('begin')
    assert third['remaining']['newgrad']==1
    assert b.queue('newgrad',run_id=third['id'])['jobs'][0]['screening']=='pending'
    with s.connect() as c:
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==2
    assert p.manage('begin')['id']==third['id']


def test_progress_requires_explicit_initialization_and_valid_run(tmp_path):
    p=ScreeningProgress(Store(tmp_path/'empty.sqlite'))
    with pytest.raises(ValueError,match='initialized'):p.manage('begin')
    p.initialize(time.time()-1)
    with pytest.raises(ValueError,match='Unknown'):p.manage('complete','missing')
    with pytest.raises(ValueError,match='Unknown'):p.queue('missing','newgrad')


def test_temporarily_absent_unread_member_survives_completed_batch(tmp_path,monkeypatch):
    now=[1000.0];monkeypatch.setattr(time,'time',lambda:now[0])
    s=Store(tmp_path/'absent.sqlite');b=Board(s);p=ScreeningProgress(s)
    pending=job('pending');anchor=job('anchor')
    s.ingest('simplify:newgrad',[pending,anchor],'seed');p.initialize(999)
    batch=p.manage('begin')
    anchor_row=next(r for r in b.queue('newgrad',run_id=batch['id'])['jobs'] if r['apply_url'].endswith('/anchor'))
    review(b,anchor_row)
    s.ingest('simplify:newgrad',[anchor],'temporarily-absent')
    assert p.manage('complete',batch['id'])['status']=='complete'
    now[0]=5000
    s.ingest('simplify:newgrad',[pending,anchor],'reappear-unchanged')
    following=p.manage('begin')
    assert following['remaining']['newgrad']==1
    assert b.queue('newgrad',run_id=following['id'])['jobs'][0]['apply_url'].endswith('/pending')


def test_targeted_recheck_preserves_completed_progress_and_resumes_by_version(tmp_path):
    s=Store(tmp_path/'recheck.sqlite');b=Board(s);p=ScreeningProgress(s)
    s.ingest('simplify:newgrad',[job('unread'),job('verified'),job('protected')],'seed')
    p.initialize(time.time()-1)
    original=p.manage('begin')
    for row in b.queue('newgrad',run_id=original['id'])['jobs']:
        b.review(row['id'],'newgrad','review','','Metadata only',[],row['fingerprint'],0,
                 'initial-'+row['id'],role_family='unknown')
    p.manage('complete',original['id'])
    rows={r['apply_url'].rsplit('/',1)[1]:r for r in b._rows('newgrad')}
    verified=rows['verified']
    b.review(verified['id'],'newgrad','keep','','Read official page',[],verified['fingerprint'],1,
             'verified',role_family='software',role_evidence=[{'url':'https://example.org/verified','quote':'Build software','observed_at':'2026-09-17T00:00:00Z'}])
    with s.connect(True) as c:
        c.execute("UPDATE applications SET status='submitted',version=1 WHERE job_id=?",(rows['protected']['id'],))
        snapshot=[tuple(r) for r in c.execute('SELECT * FROM job_screening ORDER BY job_id')]
    assert p.request_recheck(original['id'])['added']==1
    assert p.manage('status')['cutoff']==original['cutoff']
    with s.connect() as c:
        assert snapshot==[tuple(r) for r in c.execute('SELECT * FROM job_screening ORDER BY job_id')]
    batch=p.manage('begin')
    assert batch['id']!=original['id'] and batch['remaining']['newgrad']==1
    assert b.queue('newgrad',run_id=original['id'])['jobs']==[]
    assert ScreeningProgress(s).manage('begin')['id']==batch['id']
    assert p.manage('complete',batch['id'])['completed'] is False
    row=b.queue('newgrad',run_id=batch['id'])['jobs'][0]
    assert row['id']==rows['unread']['id'] and row['review_version']==1
    # A real page-specific access obstacle is still a valid completed review.
    b.review(row['id'],'newgrad','review','','https://example.org/unread returned 403 at 2026-09-17T00:00:00Z',[],
             row['fingerprint'],1,'attempted',role_family='unknown')
    assert p.manage('complete',batch['id'])['status']=='complete'
    assert p.request_recheck(original['id'])['added']==0
    assert p.manage('begin')['remaining']['newgrad']==0


def test_recheck_source_change_remains_pending(tmp_path):
    s=Store(tmp_path/'recheck-claim.sqlite');b=Board(s);p=ScreeningProgress(s)
    source=job('unread')
    s.ingest('simplify:newgrad',[source],'seed');p.initialize(time.time()-1)
    original=p.manage('begin');row=b.queue('newgrad',run_id=original['id'])['jobs'][0]
    b.review(row['id'],'newgrad','review','','Metadata only',[],row['fingerprint'],0,'initial-review',role_family='unknown')
    p.manage('complete',original['id']);p.request_recheck(original['id'])
    batch=p.manage('begin')
    s.ingest('simplify:newgrad',[{**source,'description':'Updated responsibilities'}],'changed')
    fresh=b.queue('newgrad',run_id=batch['id'])['jobs'][0]
    assert fresh['screening']=='pending' and fresh['fingerprint']!=row['fingerprint']
    review(b,fresh)
    assert p.manage('complete',batch['id'])['status']=='complete'


def test_daily_title_triage_skips_tiktok_and_old_faang_without_hiding_jobs(tmp_path,monkeypatch):
    now=[1000.0];monkeypatch.setattr(time,'time',lambda:now[0])
    s=Store(tmp_path/'daily.sqlite');b=Board(s);p=ScreeningProgress(s)
    old=job('old-google','Google');tik=job('tiktok','TikTok')
    s.ingest('simplify:newgrad',[old,tik],'seed')
    now[0]=2000
    fresh=job('fresh-apple','Apple')
    s.ingest('simplify:newgrad',[old,tik,fresh],'new')
    p.initialize(1500);batch=p.manage('begin')
    queue=b.queue('newgrad',run_id=batch['id'])
    assert [r['company'] for r in queue['jobs']]==['Apple']
    assert len(b.list()['jobs'])==3
    assert 'upstream repository/README classifications' in queue['rules']['screening_mode']
    row=queue['jobs'][0]
    b.review(row['id'],'newgrad','keep','','Title/source triage: software; no supported exclusion.',[],row['fingerprint'],0,'title-only-keep')
    p.manage('complete',batch['id'])
    now[0]=3000
    s.ingest('simplify:newgrad',[{**old,'description':'Material update'}, {**tik,'description':'Material update'}, fresh],'changed')
    nxt=p.manage('begin')
    assert [r['company'] for r in b.queue('newgrad',run_id=nxt['id'])['jobs']]==['Google']
